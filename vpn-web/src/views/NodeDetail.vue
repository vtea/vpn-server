<template>
  <div v-loading="loading">
    <el-page-header @back="$router.push('/nodes')" class="node-page-header">
      <template #content>
        <div class="detail-header-row">
          <div class="detail-header-main">
            <span class="detail-header-name">{{ node.name || nodeId }}</span>
            <span
              v-if="node.node_number != null && node.node_number !== ''"
              class="detail-header-node-num"
            >
              · {{ node.node_number }}
            </span>
            <el-tag
              v-if="node.status"
              :type="getStatusInfo('node', node.status).type"
              size="small"
              class="detail-header-tag"
            >
              {{ getStatusInfo('node', node.status).label }}
            </el-tag>
          </div>
          <el-button
            type="primary"
            plain
            size="small"
            :loading="refreshing"
            class="detail-header-refresh"
            @click="load({ refresh: true })"
          >
            <el-icon><Refresh /></el-icon>
            刷新状态
          </el-button>
        </div>
      </template>
    </el-page-header>

    <el-alert
      v-if="postCreateDeploy"
      type="success"
      show-icon
      closable
      class="mb-md"
      @close="dismissPostCreate"
    >
      <template #title>新节点已创建：请先配置「相关隧道」与分流出口，再在目标机执行部署</template>
      <div class="post-create-deploy">
        <div>Bootstrap Token: <code>{{ postCreateDeploy.token }}</code></div>
        <el-text type="info" size="small" style="display: block; margin-top: 6px">在线部署（公网）</el-text>
        <el-input type="textarea" :rows="2" :model-value="postCreateDeploy.online" readonly />
        <el-button size="small" class="mt-sm" @click="copyText(postCreateDeploy.online)">复制命令</el-button>
        <template v-if="postCreateDeploy.offline">
          <el-text type="info" size="small" style="display: block; margin-top: 8px">离网部署（公网）</el-text>
          <el-input type="textarea" :rows="2" :model-value="postCreateDeploy.offline" readonly />
          <el-button size="small" class="mt-sm" @click="copyText(postCreateDeploy.offline)">复制离网命令</el-button>
          <el-text v-if="postCreateDeploy.scriptUrl" type="info" size="small" style="display: block; margin-top: 4px">
            或下载脚本：<el-link :href="postCreateDeploy.scriptUrl" target="_blank" type="primary">node-setup.sh</el-link>
          </el-text>
        </template>
        <template v-if="postCreateDeploy.onlineLan">
          <el-text type="info" size="small" style="display: block; margin-top: 8px">在线部署（内网）</el-text>
          <el-input type="textarea" :rows="2" :model-value="postCreateDeploy.onlineLan" readonly />
          <el-button size="small" class="mt-sm" @click="copyText(postCreateDeploy.onlineLan)">复制内网命令</el-button>
        </template>
        <el-alert
          v-if="postCreateDeploy.deployUrlWarning"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 10px"
        >
          {{ postCreateDeploy.deployUrlWarning }}
        </el-alert>
        <el-text v-if="postCreateDeploy.deployUrlNote" type="info" size="small" style="display: block; margin-top: 8px">
          {{ postCreateDeploy.deployUrlNote }}
        </el-text>
      </div>
    </el-alert>

    <section class="node-overview mb-lg">
      <div class="node-overview__head">
        <span class="node-overview__title">运行概况</span>
        <el-text type="info" size="small" class="node-overview__hint">
          状态后为在线人数；版本号绿色为已跟上参考、红色为建议升级、橙色为无法比对；隧道数来自当前列表
        </el-text>
      </div>
      <el-row :gutter="16">
        <el-col v-for="item in statCards" :key="item.key" :xs="24" :sm="12" :lg="8" class="overview-col">
          <div class="stat-card">
            <div class="stat-icon" :class="`stat-icon--${item.color}`">
              <el-icon :size="24"><component :is="item.icon" /></el-icon>
            </div>
            <div class="stat-content">
              <template v-if="item.key === 'latest-status'">
                <div class="stat-latest">
                  <div class="stat-value stat-value--latest">
                    <template v-if="item.rawStatus">
                      <el-tooltip :content="`原始状态: ${item.rawStatus}`" placement="top">
                        <span class="stat-value-text">{{ item.statusLabel }}</span>
                      </el-tooltip>
                    </template>
                    <template v-else>
                      <span class="stat-value-text">{{ item.statusLabel }}</span>
                    </template>
                    <span class="stat-inline-online-num">{{
                      item.onlineUsers != null ? item.onlineUsers : '—'
                    }}</span>
                  </div>
                  <div
                    class="stat-agent-version-display"
                    :class="`stat-agent-version-display--${item.agentVersionTone}`"
                  >
                    版本：{{ item.agentDisplay }}
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="stat-value stat-value--overview-num">
                  <span class="stat-value-text">{{ item.value }}</span>
                </div>
              </template>
              <div v-if="item.label" class="stat-label stat-label--overview">{{ item.label }}</div>
            </div>
          </div>
        </el-col>
      </el-row>
    </section>

    <div class="page-card mb-md">
      <div class="page-card-header">
        <span class="page-card-title">基本信息</span>
        <div class="header-actions">
          <el-button type="warning" plain size="small" @click="rotateBootstrap">
            重新生成部署令牌
          </el-button>
          <el-button type="primary" size="small" :loading="savingNode" @click="saveNodeMeta">保存</el-button>
        </div>
      </div>
      <div class="node-readonly-block">
        <div class="node-subsection-label">节点标识与只读信息</div>
        <div class="node-readonly-strip">
          <div class="node-kv">
            <span class="node-kv-label">节点 ID</span>
            <span class="node-kv-val mono-text">{{ node.id || '—' }}</span>
          </div>
          <div class="node-kv">
            <span class="node-kv-label">组网网段</span>
            <span class="node-kv-val node-kv-val--tags">
              <template v-if="segments.length">
                <el-tag v-for="(s, i) in segments" :key="i" size="small" class="segment-tag" effect="plain">
                  {{ s.segment?.name || s.segment?.id }} (槽 {{ s.slot }})
                </el-tag>
              </template>
              <el-text v-else type="info" size="small">未绑定</el-text>
            </span>
          </div>
          <div class="node-kv">
            <span class="node-kv-label">IP 库版本</span>
            <span class="node-kv-val">{{ node.ip_list_version || '未更新' }}</span>
          </div>
        </div>
        <div class="node-kv-wg">
          <span class="node-kv-label">WG 公钥</span>
          <span class="wg-key-inline">
            <span class="mono-text wg-key-text">{{ node.wg_public_key || '未上报' }}</span>
            <el-button
              v-if="node.wg_public_key"
              link
              type="primary"
              size="small"
              class="wg-key-copy"
              @click="copyText(node.wg_public_key)"
            >
              <el-icon><DocumentCopy /></el-icon>
              复制
            </el-button>
          </span>
        </div>
      </div>
      <div v-if="meshSummary.note" class="mesh-note-panel">
        <el-icon class="mesh-note-panel__icon"><InfoFilled /></el-icon>
        <p class="mesh-note-panel__text">{{ meshSummary.note }}</p>
      </div>
      <div v-if="meshSummary.openvpn_instance_subnets?.length || meshSummary.wireguard_peer_local_ips?.length" class="mesh-summary-block">
        <div v-if="meshSummary.openvpn_instance_subnets?.length" class="mesh-summary-section">
          <div class="mesh-summary-label">OpenVPN 客户端地址池与监听（按实例）</div>
          <el-tag
            v-for="(row, idx) in meshSummary.openvpn_instance_subnets"
            :key="'ov-' + idx"
            size="small"
            class="mesh-tag"
          >
            {{ modeMeshShort(row.mode) }} · {{ protoMeshChar(row.proto) }}/{{ row.port }} · {{ row.subnet }}
          </el-tag>
        </div>
        <div v-if="meshSummary.wireguard_peer_local_ips?.length" class="mesh-summary-section">
          <div class="mesh-summary-label">WireGuard 骨干（每对端一条 /30，本端 IP）</div>
          <div
            v-for="(row, idx) in meshSummary.wireguard_peer_local_ips"
            :key="'wg-' + idx"
            class="mesh-wg-line"
          >
            <span class="mesh-wg-k">对端</span>
            <span class="mesh-wg-v mesh-wg-peer">{{ row.peer_node_id }}</span>
            <span class="mesh-wg-k">本端</span>
            <span class="mesh-wg-v mesh-wg-ip">{{ row.local_ip }}</span>
            <template v-if="row.wg_port != null && row.wg_port !== ''">
              <span class="mesh-wg-k">监听</span>
              <span class="mesh-wg-v mesh-wg-port">UDP {{ row.wg_port }}</span>
            </template>
            <span class="mesh-wg-k">隧道</span>
            <el-text type="info" size="small" class="mesh-wg-v">{{ row.tunnel_subnet }}</el-text>
          </div>
        </div>
      </div>
      <el-divider content-position="left" class="node-edit-divider">可编辑</el-divider>
      <el-form class="node-meta-form" label-width="72px" @submit.prevent>
        <div class="node-edit-strip">
          <el-form-item label="名称" required>
            <el-input v-model="editNode.name" placeholder="节点显示名称" class="node-edit-input" />
          </el-form-item>
          <el-form-item label="地域">
            <el-input v-model="editNode.region" placeholder="如 cn-east" class="node-edit-input" />
          </el-form-item>
          <el-form-item label="公网地址">
            <el-input v-model="editNode.public_ip" placeholder="IPv4/IPv6 或域名" class="node-edit-input node-edit-input--wide" />
          </el-form-item>
        </div>
      </el-form>
    </div>

    <div class="page-card mb-md node-instances-card">
      <div class="page-card-header node-instances-card__head">
        <span class="page-card-title">组网接入（模式与地址）</span>
        <div class="node-instances-card__toolbar">
          <el-tooltip
            content="将库中的组网接入配置下发到本节点 Agent（需在线），合并 bootstrap 并重启 vpn-routing。"
            placement="bottom"
          >
            <el-button
              type="primary"
              plain
              size="small"
              :loading="syncingAgentConfig"
              @click="syncAgentConfig"
            >
              同步配置
            </el-button>
          </el-tooltip>
          <el-button
            type="primary"
            link
            :loading="refreshing"
            class="node-instances-card__refresh"
            @click="load({ refresh: true })"
          >
            <el-icon><Refresh /></el-icon>
            刷新状态
          </el-button>
        </div>
      </div>
      <el-collapse class="instance-hint-collapse mb-md">
        <el-collapse-item name="instance-hint">
          <template #title>
            <span class="collapse-hint-title">
              <el-icon class="collapse-hint-icon"><InfoFilled /></el-icon>
              使用说明（协议、出口与在线用户）
            </span>
          </template>
          <div class="section-hint-body">
            <p>
              以下为已启用的接入实例；子网为 VPN 客户端地址池（CIDR），修改后需 Agent 同步生效。上方「组网地址摘要」与签发所用协议均以数据库中已保存的
              <code>instances.proto</code> 为准；下拉未点「保存」前不会生效。用户 .ovpn 的 <code>proto</code> 在签发时写入，改协议后须在「用户 → 授权」中<strong>重试签发</strong>并重新下载配置。
            </p>
            <p>
              <strong>节点直连（<code>node-direct</code>）</strong>：向客户端推送默认路由，流量经本入口节点公网出口上网（NAT 到本机 WAN）。<strong>出口节点</strong>留空即可；若填写对端节点 ID（须与本页「相关隧道」一致），则该实例流量经 WireGuard 到对端再出网。
            </p>
            <p>
              <strong>国内分流（<code>cn-split</code>）/ 全局（<code>global</code>）</strong>：<strong>出口节点</strong>填写对端节点 ID；留空时节点脚本仍按旧逻辑尝试 <code>hongkong</code> 等内置名。
            </p>
            <p>
              <strong>新建节点</strong>默认仅启用 <code>node-direct</code>（节点直连）；其余模式需在下方列表中打开「启用」后，在节点上重新执行安装脚本或等待同步，以生成对应 OpenVPN 与路由。
            </p>
            <p>
              <strong>在线用户</strong>由 Agent 按各模式固定 management 端口统计；若长期为 0 请见运维手册第 3.3 节。若客户端开启「仅允许 VPN 流量」而所用实例未推默认路由（旧版节点），可能出现连上但无公网，见用户指南。
            </p>
          </div>
        </el-collapse-item>
      </el-collapse>
      <p v-if="enabledInstances.length" class="listen-summary-line">
        <span class="listen-summary-label">当前监听（公网入站需放行）</span>
        <el-tag
          v-for="inst in enabledInstances"
          :key="'ls-' + inst.id"
          size="small"
          type="info"
          effect="plain"
          class="listen-summary-tag"
        >
          {{ modeLabel(inst.mode) }} 已保存 {{ protoUpper(inst.proto) }}/{{ inst.port
          }}<span v-if="instanceListenDirty(inst)" class="listen-summary-pending">
            · 未保存 {{ protoUpper(editProto[inst.id]) }}/{{ editPort[inst.id] }}
          </span>
        </el-tag>
      </p>
      <div class="instance-cards-wrap">
        <div class="instance-cards-grid">
          <div
            v-for="row in enabledInstances"
            :key="row.id"
            class="record-card instance-card"
            :class="recordCardToneFromTagType('success')"
          >
            <div class="record-card__head instance-card__head">
              <div class="inst-segment-cell min-w-0">
                <el-tooltip
                  :content="segmentName(row.segment_id)"
                  placement="top"
                  :disabled="!segmentName(row.segment_id)"
                >
                  <span class="inst-segment-text">{{ segmentName(row.segment_id) }}</span>
                </el-tooltip>
                <el-button
                  v-if="segmentName(row.segment_id)"
                  link
                  type="primary"
                  size="small"
                  class="inst-segment-copy"
                  @click="copyText(segmentName(row.segment_id))"
                >
                  <el-icon><DocumentCopy /></el-icon>
                </el-button>
              </div>
              <el-switch :model-value="row.enabled" size="small" @change="toggleInstance(row)" />
            </div>
            <div class="instance-card__fields">
              <div class="inst-field-row inst-field-row--top">
                <div class="inst-field inst-field--stack">
                  <span class="inst-field__label">模式</span>
                  <div class="inst-field__ctl inst-field__ctl--text">{{ modeLabel(row.mode) }}</div>
                </div>
                <div class="inst-field inst-field--stack">
                  <span class="inst-field__label">协议</span>
                  <el-select v-model="editProto[row.id]" size="small" class="inst-field__ctl inst-select-proto">
                    <el-option label="UDP" value="udp" />
                    <el-option label="TCP" value="tcp" />
                  </el-select>
                </div>
                <div class="inst-field inst-field--stack">
                  <span class="inst-field__label">端口</span>
                  <el-input-number
                    v-model="editPort[row.id]"
                    :min="1"
                    :max="65535"
                    size="small"
                    controls-position="right"
                    class="inst-field__ctl inst-input-port"
                  />
                </div>
              </div>
              <div class="inst-field inst-field--row">
                <span class="inst-field__label">子网 (CIDR)</span>
                <el-input
                  v-model="editSubnet[row.id]"
                  size="small"
                  placeholder="10.8.0.0/24"
                  class="inst-field__ctl inst-input-cidr"
                />
              </div>
              <div class="inst-field inst-field--row">
                <span class="inst-field__label">出口节点</span>
                <template v-if="instanceModeUsesExit(row.mode)">
                  <el-select
                    v-model="editExitNode[row.id]"
                    clearable
                    filterable
                    :placeholder="
                      row.mode === 'node-direct' ? '未指定（本入口节点公网出口）' : '未指定（内置名回退）'
                    "
                    size="small"
                    class="inst-field__ctl inst-select-exit"
                  >
                    <el-option
                      v-for="pid in peerTunnelIds"
                      :key="pid"
                      :label="peerTunnelOptionLabel(pid)"
                      :value="pid"
                    />
                  </el-select>
                </template>
                <el-text v-else type="info" class="inst-field__ctl">—</el-text>
              </div>
            </div>
            <div class="record-card__actions">
              <el-button type="primary" size="small" @click="saveInstancePatch(row)">保存</el-button>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-if="!enabledInstances.length" description="暂无已启用实例" :image-size="60" />

      <el-collapse v-if="disabledInstances.length" class="mt-md">
        <el-collapse-item title="已禁用的接入（可重新启用）" name="disabled">
          <div class="instance-cards-wrap">
            <div class="instance-cards-grid">
              <div
                v-for="row in disabledInstances"
                :key="row.id"
                class="record-card instance-card instance-card--readonly record-card--tone-muted"
              >
                <div class="record-card__head instance-card__head">
                  <div class="inst-segment-cell min-w-0">
                    <el-tooltip
                      :content="segmentName(row.segment_id)"
                      placement="top"
                      :disabled="!segmentName(row.segment_id)"
                    >
                      <span class="inst-segment-text">{{ segmentName(row.segment_id) }}</span>
                    </el-tooltip>
                    <el-button
                      v-if="segmentName(row.segment_id)"
                      link
                      type="primary"
                      size="small"
                      class="inst-segment-copy"
                      @click="copyText(segmentName(row.segment_id))"
                    >
                      <el-icon><DocumentCopy /></el-icon>
                    </el-button>
                  </div>
                  <el-switch :model-value="row.enabled" size="small" @change="toggleInstance(row)" />
                </div>
                <div class="instance-card__fields">
                  <div class="kv-row">
                    <span class="kv-label">模式</span>
                    <span class="kv-value">{{ modeLabel(row.mode) }}</span>
                  </div>
                  <div class="kv-row">
                    <span class="kv-label">协议 / 端口</span>
                    <span class="kv-value">{{ protoUpper(row.proto) }} / {{ row.port }}</span>
                  </div>
                  <div class="kv-row">
                    <span class="kv-label">子网</span>
                    <span class="kv-value mono-text">{{ row.subnet || '—' }}</span>
                  </div>
                  <div class="kv-row">
                    <span class="kv-label">出口节点</span>
                    <span class="kv-value">{{ exitCellLabel(row) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <div class="page-card mb-md tunnel-section">
      <div class="page-card-header tunnel-section__head">
        <span class="page-card-title">相关隧道</span>
      </div>
      <div class="tunnel-cards-wrap">
        <div class="tunnel-cards-grid">
          <div
            v-for="row in tunnels"
            :key="row.id || row.subnet"
            class="record-card tunnel-card"
            :class="recordCardToneClass('tunnel', row.status)"
          >
          <div class="record-card__head">
            <div class="record-card__title min-w-0">{{ tunnelPeerLine(row) }}</div>
            <el-button type="primary" size="small" link @click="openTunnelEdit(row)">编辑</el-button>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">隧道子网</span>
              <span class="kv-value mono-text">{{ row.subnet || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">WG 本端 / 对端</span>
              <span class="kv-value mono-text">
                {{ row.node_a === nodeId ? row.ip_a : row.ip_b }} → {{ row.node_a === nodeId ? row.ip_b : row.ip_a }}
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">状态</span>
              <span class="kv-value">
                <span class="status-dot" :class="`status-dot--${row.status}`" />
                {{ getStatusInfo('tunnel', row.status).label }}
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">WG 端口 / 延迟</span>
              <span class="kv-value">
                {{ row.wg_port != null ? row.wg_port : '—' }}
                <span class="record-card__meta"> · </span>
                {{ row.latency_ms > 0 ? row.latency_ms.toFixed(1) : '—' }} ms
              </span>
            </div>
          </div>
          </div>
        </div>
      </div>
      <el-empty v-if="!tunnels.length" description="暂无隧道" :image-size="60" class="tunnel-empty" />
    </div>

    <el-dialog v-model="tunnelDialogVisible" title="编辑隧道（WireGuard /30）" width="520px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon class="mb-md">
        须为 IPv4 /30，且 <code>ip_a</code> 对应 <code>node_a</code>、<code>ip_b</code> 对应 <code>node_b</code>。修改后两端节点
        <code>config_version</code> 递增；现场 WG 配置需与 Agent/脚本同步。
      </el-alert>
      <el-form label-width="120px">
        <el-form-item label="隧道子网">
          <el-input v-model="tunnelForm.subnet" placeholder="如 172.16.0.0/30" />
        </el-form-item>
        <el-form-item label="ip_a (node_a)">
          <el-input v-model="tunnelForm.ip_a" />
        </el-form-item>
        <el-form-item label="ip_b (node_b)">
          <el-input v-model="tunnelForm.ip_b" />
        </el-form-item>
        <el-form-item label="WG 端口">
          <el-input-number v-model="tunnelForm.wg_port" :min="1" :max="65535" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="tunnelDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="tunnelSaving" @click="saveTunnelEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rotateDeployVisible" title="新的部署命令" width="680px" destroy-on-close>
      <el-alert type="success" :closable="false" style="margin-bottom: 16px">
        <template #title>
          已换发 Bootstrap Token：<code>{{ rotateData.token }}</code>
        </template>
      </el-alert>
      <el-alert v-if="rotateData.deployUrlNote" type="info" :closable="false" style="margin-bottom: 12px">
        {{ rotateData.deployUrlNote }}
      </el-alert>
      <el-alert v-if="rotateData.deployUrlWarning" type="warning" :closable="false" show-icon style="margin-bottom: 16px">
        {{ rotateData.deployUrlWarning }}
      </el-alert>
      <el-tabs v-if="rotateData.online">
        <el-tab-pane label="在线（公网）">
          <el-input type="textarea" :rows="3" :model-value="rotateData.online" readonly />
          <el-button size="small" style="margin-top: 8px" @click="copyText(rotateData.online)">复制</el-button>
        </el-tab-pane>
        <el-tab-pane v-if="rotateData.onlineLan" label="在线（内网）">
          <el-input type="textarea" :rows="3" :model-value="rotateData.onlineLan" readonly />
          <el-button size="small" style="margin-top: 8px" @click="copyText(rotateData.onlineLan)">复制</el-button>
        </el-tab-pane>
        <el-tab-pane v-if="rotateData.offline" label="离网（公网）">
          <el-input type="textarea" :rows="3" :model-value="rotateData.offline" readonly />
          <el-button size="small" style="margin-top: 8px" @click="copyText(rotateData.offline)">复制</el-button>
          <el-text v-if="rotateData.scriptUrl" type="info" size="small" style="display: block; margin-top: 8px">
            或下载脚本：<el-link :href="rotateData.scriptUrl" target="_blank" type="primary">node-setup.sh</el-link>
          </el-text>
        </el-tab-pane>
        <el-tab-pane v-if="rotateData.offlineLan" label="离网（内网）">
          <el-input type="textarea" :rows="3" :model-value="rotateData.offlineLan" readonly />
          <el-button size="small" style="margin-top: 8px" @click="copyText(rotateData.offlineLan)">复制</el-button>
          <el-text v-if="rotateData.scriptUrlLan" type="info" size="small" style="display: block; margin-top: 8px">
            或下载脚本：<el-link :href="rotateData.scriptUrlLan" target="_blank" type="primary">node-setup.sh</el-link>
          </el-text>
        </el-tab-pane>
      </el-tabs>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api/http'
import { getStatusInfo, recordCardToneClass, recordCardToneFromTagType } from '../utils'

const route = useRoute()
const nodeId = route.params.id
const loading = ref(false)
const refreshing = ref(false)
/** 「组网接入」标题栏「同步配置」请求中 */
const syncingAgentConfig = ref(false)
/** 与节点列表同源：来自 /api/nodes/upgrade-status，用于详情页 Agent 版本着色 */
const latestAgentVersion = ref('')
const node = ref({})
const instances = ref([])
const segments = ref([])
const tunnels = ref([])
/** 后端 mesh_summary：OpenVPN 池 + WG 本端 IP 汇总（无单一「节点组网 IP」） */
const meshSummary = ref({ note: '', openvpn_instance_subnets: [], wireguard_peer_local_ips: [] })
const editSubnet = reactive({})
const editPort = reactive({})
const editProto = reactive({})
const editExitNode = reactive({})
/** 全量节点 id -> 名称，用于隧道对端与出口展示 */
const nodeNameById = ref({})
const postCreateDeploy = ref(null)
const editNode = reactive({ name: '', region: '', public_ip: '' })
const savingNode = ref(false)
const tunnelDialogVisible = ref(false)
const tunnelSaving = ref(false)
const tunnelEditId = ref(null)
const tunnelForm = reactive({ subnet: '', ip_a: '', ip_b: '', wg_port: 56720 })
const rotateDeployVisible = ref(false)
const rotateData = reactive({
  token: '',
  online: '',
  onlineLan: '',
  offline: '',
  offlineLan: '',
  scriptUrl: '',
  scriptUrlLan: '',
  deployUrlWarning: '',
  deployUrlNote: ''
})

const enabledInstances = computed(() => (instances.value || []).filter((i) => i.enabled === true))
const disabledInstances = computed(() => (instances.value || []).filter((i) => i.enabled !== true))

const modeLabel = (mode) => {
  const m = {
    'node-direct': '节点直连',
    'cn-split': '国内分流',
    global: '全局'
  }
  return m[mode] || mode || '-'
}

/** mesh 摘要标签：直连/分流/全局 */
const modeMeshShort = (mode) => {
  const m = { 'node-direct': '直连', 'cn-split': '分流', global: '全局' }
  return m[mode] || mode || '—'
}

const protoMeshChar = (p) => ((p || 'udp').toLowerCase() === 'tcp' ? 'T' : 'U')

const instanceModeUsesExit = (mode) =>
  mode === 'node-direct' ||
  mode === 'cn-split' ||
  mode === 'global'

const peerTunnelIds = computed(() => {
  const ids = []
  for (const row of tunnels.value) {
    const pid = row.node_a === nodeId ? row.node_b : row.node_a
    if (pid) ids.push(pid)
  }
  return [...new Set(ids)].sort()
})

const peerTunnelOptionLabel = (pid) => {
  if (!pid) return '—'
  const n = nodeNameById.value[pid]
  if (n && n !== pid) return `${pid} · ${n}`
  return pid
}

const tunnelPeerLine = (row) => {
  const pid = row.node_a === nodeId ? row.node_b : row.node_a
  return peerTunnelOptionLabel(pid || '')
}

const exitCellLabel = (row) => {
  const e = (row.exit_node || '').trim()
  if (!e) {
    return row.mode === 'node-direct' ? '本入口节点出口' : '—'
  }
  return peerTunnelOptionLabel(e)
}

const dismissPostCreate = () => {
  postCreateDeploy.value = null
}

const tryConsumePostCreateDeploy = () => {
  const s = window.history.state
  if (s?.postCreateDeploy) {
    postCreateDeploy.value = { ...s.postCreateDeploy }
    const next = { ...s }
    delete next.postCreateDeploy
    window.history.replaceState(next, '')
  }
}

const segmentName = (id) => {
  if (!id) return 'default'
  const x = segments.value.find((s) => s.segment?.id === id)
  return x?.segment?.name ? `${x.segment.name} (${id})` : id
}

/** OpenVPN 传输协议展示：tcp/udp → TCP/UDP */
const protoUpper = (p) => ((p || 'udp').toLowerCase() === 'tcp' ? 'TCP' : 'UDP')

const savedProtoKey = (inst) => ((inst.proto || 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp')

/** 表单中的协议/端口与库中已保存值不一致（仅影响「当前监听」行的未保存提示） */
const instanceListenDirty = (inst) => {
  const ep = editProto[inst.id] === 'tcp' ? 'tcp' : 'udp'
  return ep !== savedProtoKey(inst) || editPort[inst.id] !== inst.port
}

const displayAgentVersion = (v) => {
  const s = String(v || '').trim().replace(/^v/i, '').replace(/-unknown$/i, '')
  return s
}

const parseVersion = (v) => {
  const s = displayAgentVersion(v)
  if (!s) return null
  const parts = s.split('.').map((x) => Number.parseInt(x, 10))
  if (parts.some((n) => Number.isNaN(n))) return null
  while (parts.length < 3) parts.push(0)
  return parts.slice(0, 3)
}

const compareVersion = (a, b) => {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return 0
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1
    if (va[i] < vb[i]) return -1
  }
  return 0
}

/** empty：未上报；warn：格式异常或缺少参考版本；latest：不低于参考；stale：低于参考 */
const resolveAgentVersionTone = (agentRaw) => {
  const cur = displayAgentVersion(agentRaw)
  if (!cur) return 'empty'
  if (!parseVersion(cur)) return 'warn'
  const lat = latestAgentVersion.value
  if (!lat || !parseVersion(lat)) return 'warn'
  return compareVersion(cur, lat) >= 0 ? 'latest' : 'stale'
}

const statCards = computed(() => {
  const st = node.value.status
  const statusLabel = st ? getStatusInfo('node', st).label : '-'
  const agentRaw = String(node.value.agent_version || '').trim()
  const agentDisplay = agentRaw ? displayAgentVersion(agentRaw) : '—'

  return [
    {
      key: 'latest-status',
      statusLabel,
      rawStatus: st || '',
      agentDisplay,
      agentVersionTone: resolveAgentVersionTone(agentRaw),
      onlineUsers: node.value.online_users,
      icon: 'CircleCheck',
      color: 'primary'
    },
    { key: 'number', label: '节点号', value: node.value.node_number || '-', icon: 'Coin', color: 'warning' },
    {
      key: 'tunnels',
      label: '相关隧道',
      value: tunnels.value?.length ?? 0,
      icon: 'Connection',
      color: 'info'
    }
  ]
})

/**
 * 主动向本节点 Agent 下发当前库中的组网接入（update_config），需 WebSocket 在线。
 */
const syncAgentConfig = async () => {
  if (!nodeId) return
  syncingAgentConfig.value = true
  try {
    const res = await http.post(`/api/nodes/${nodeId}/sync-agent-config`)
    const n = Number(res.data?.instances) || 0
    ElMessage.success(`已下发配置（${n} 个接入实例）。节点将合并 bootstrap 并重启 vpn-routing。`)
    await load({ refresh: true })
  } catch {
    // http.js 已统一处理
  } finally {
    syncingAgentConfig.value = false
  }
}

const load = async ({ refresh = false } = {}) => {
  if (refresh) refreshing.value = true
  else loading.value = true
  try {
    const upgradeReq = http
      .get('/api/nodes/upgrade-status', {
        validateStatus: (s) => (s >= 200 && s < 300) || s === 404
      })
      .catch(() => ({ status: 404, data: {} }))

    const [nodeRes, statusRes, nodesRes, upgradeRes] = await Promise.all([
      http.get(`/api/nodes/${nodeId}`),
      http.get(`/api/nodes/${nodeId}/status`),
      http.get('/api/nodes'),
      upgradeReq
    ])

    if (upgradeRes.status !== 404 && upgradeRes.data?.latest_version) {
      latestAgentVersion.value = displayAgentVersion(upgradeRes.data.latest_version)
    } else {
      latestAgentVersion.value = ''
    }

    node.value = nodeRes.data.node || {}
    instances.value = nodeRes.data.instances || []
    segments.value = nodeRes.data.segments || []
    meshSummary.value = nodeRes.data.mesh_summary || {
      note: '',
      openvpn_instance_subnets: [],
      wireguard_peer_local_ips: []
    }
    tunnels.value = statusRes.data.tunnels || []
    node.value.online_users = statusRes.data.online_users
    if (statusRes.data?.agent_version !== undefined && statusRes.data?.agent_version !== null) {
      node.value.agent_version = statusRes.data.agent_version
    }
    const m = {}
    for (const it of nodesRes.data.items || []) {
      if (it.node?.id) m[it.node.id] = it.node.name || ''
    }
    nodeNameById.value = m
    editNode.name = node.value.name || ''
    editNode.region = node.value.region || ''
    editNode.public_ip = node.value.public_ip || ''
    for (const inst of instances.value) {
      editSubnet[inst.id] = inst.subnet || ''
      editPort[inst.id] = inst.port
      editProto[inst.id] = inst.proto === 'tcp' ? 'tcp' : 'udp'
      editExitNode[inst.id] = (inst.exit_node || '').trim()
    }
  } finally {
    if (refresh) refreshing.value = false
    else loading.value = false
  }
}

const toggleInstance = async (inst) => {
  try {
    await http.patch(`/api/instances/${inst.id}`, { enabled: !inst.enabled })
    inst.enabled = !inst.enabled
    ElMessage.success('已更新')
    await load()
  } catch {
    // http.js 已统一处理
  }
}

const saveNodeMeta = async () => {
  savingNode.value = true
  try {
    const res = await http.patch(`/api/nodes/${nodeId}`, {
      name: editNode.name,
      region: editNode.region,
      public_ip: editNode.public_ip
    })
    node.value = res.data.node || node.value
    ElMessage.success('基本信息已保存')
  } catch {
    // http.js
  } finally {
    savingNode.value = false
  }
}

const rotateBootstrap = async () => {
  try {
    await ElMessageBox.confirm(
      '将作废当前 Bootstrap 令牌并签发新令牌；已用旧令牌完成首次注册的节点不受影响，重装须使用新命令。',
      '重新生成部署令牌',
      { type: 'warning', confirmButtonText: '确定换发' }
    )
  } catch {
    return
  }
  try {
    const res = await http.post(`/api/nodes/${nodeId}/rotate-bootstrap-token`)
    rotateData.token = res.data.bootstrap_token || ''
    rotateData.online = res.data.deploy_command || ''
    rotateData.onlineLan = res.data.deploy_command_lan || ''
    rotateData.offline = res.data.deploy_offline || ''
    rotateData.offlineLan = res.data.deploy_offline_lan || ''
    rotateData.scriptUrl = res.data.script_url || ''
    rotateData.scriptUrlLan = res.data.script_url_lan || ''
    rotateData.deployUrlWarning = res.data.deploy_url_warning || ''
    rotateData.deployUrlNote = res.data.deploy_url_note || ''
    rotateDeployVisible.value = true
    ElMessage.success('已换发新令牌')
  } catch {
    // http.js
  }
}

const copyTextExecCommand = (t) => {
  const ta = document.createElement('textarea')
  ta.value = t
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, ta.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    document.body.removeChild(ta)
  }
  return ok
}

const copyText = async (t) => {
  if (!t) return
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t)
      ElMessage.success('已复制')
      return
    }
  } catch {
    // fallback below
  }
  if (copyTextExecCommand(t)) {
    ElMessage.success('已复制')
    return
  }
  ElMessage.error('复制失败')
}

const openTunnelEdit = (row) => {
  tunnelEditId.value = row.id
  tunnelForm.subnet = row.subnet || ''
  tunnelForm.ip_a = row.ip_a || ''
  tunnelForm.ip_b = row.ip_b || ''
  tunnelForm.wg_port = row.wg_port || 56720
  tunnelDialogVisible.value = true
}

const saveTunnelEdit = async () => {
  tunnelSaving.value = true
  try {
    await http.patch(`/api/tunnels/${tunnelEditId.value}`, {
      subnet: tunnelForm.subnet,
      ip_a: tunnelForm.ip_a,
      ip_b: tunnelForm.ip_b,
      wg_port: tunnelForm.wg_port
    })
    ElMessage.success('隧道已更新')
    tunnelDialogVisible.value = false
    await load()
  } catch {
    // http.js
  } finally {
    tunnelSaving.value = false
  }
}

const saveInstancePatch = async (inst) => {
  const subnet = (editSubnet[inst.id] ?? '').trim()
  const port = editPort[inst.id]
  const proto = editProto[inst.id] === 'tcp' ? 'tcp' : 'udp'
  const curExit = (inst.exit_node || '').trim()
  const newExit = String(editExitNode[inst.id] ?? '').trim()
  const body = {}
  if (subnet) body.subnet = subnet
  if (typeof port === 'number' && port > 0) body.port = port
  if (proto !== (inst.proto || 'udp')) body.proto = proto
  if (instanceModeUsesExit(inst.mode) && newExit !== curExit) {
    body.exit_node = newExit
  }
  if (!Object.keys(body).length) {
    ElMessage.warning('请修改子网、端口、UDP/TCP 或出口节点后再保存')
    return
  }
  try {
    const protoChanged = Object.prototype.hasOwnProperty.call(body, 'proto')
    const exitChanged = Object.prototype.hasOwnProperty.call(body, 'exit_node')
    await http.patch(`/api/instances/${inst.id}`, body)
    if (protoChanged) {
      ElMessage.success({
        message:
          '已保存。已有用户授权需在「用户 → 授权」中点击「重试签发」并重新下载 .ovpn，客户端首部 proto 才会与实例一致。',
        duration: 8000,
        showClose: true
      })
    } else if (exitChanged) {
      ElMessage.success({
        message:
          '已保存。请在目标节点重新执行策略路由步骤（或重装/同步 Agent 配置）后，/etc/vpn-agent/policy-routing.sh 才会使用新的出口。',
        duration: 8000,
        showClose: true
      })
    } else {
      ElMessage.success('已保存')
    }
    await load()
    try {
      await ElMessageBox.confirm(
        '配置已保存。是否立即向本节点 Agent 下发并应用（需 WebSocket 在线）？',
        '同步配置',
        {
          confirmButtonText: '立即同步',
          cancelButtonText: '放弃同步',
          type: 'info',
          distinguishCancelAndClose: true
        }
      )
      await syncAgentConfig()
    } catch (e) {
      if (e === 'cancel' || e === 'close') {
        ElMessage.info('已跳过。可稍后在「组网接入」标题栏点击「同步配置」。')
      }
    }
  } catch {
    // http.js 已统一处理
  }
}

onMounted(() => {
  tryConsumePostCreateDeploy()
  load()
})
</script>

<style scoped>
.node-page-header {
  margin-bottom: var(--spacing-lg);
}
/* 返回区、竖线、自定义标题行与右侧按钮垂直居中对齐 */
.node-page-header :deep(.el-page-header__header) {
  display: flex;
  align-items: center;
  width: 100%;
}
.node-page-header :deep(.el-page-header__left) {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 0;
}
.node-page-header :deep(.el-page-header__back) {
  display: inline-flex;
  align-items: center;
}
.node-page-header :deep(.el-page-header__content) {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.detail-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  flex-wrap: wrap;
}
.detail-header-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
}
.detail-header-name {
  font-size: 18px;
  font-weight: 600;
}
.detail-header-node-num {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-secondary);
}
.detail-header-tag {
  margin-left: 0;
}
.detail-header-refresh {
  flex-shrink: 0;
}
.node-overview__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  margin-bottom: var(--spacing-md);
}
.node-overview__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.node-overview__hint {
  font-weight: 400;
}
.overview-col {
  margin-bottom: 16px;
  min-width: 0;
}
@media (min-width: 992px) {
  .overview-col {
    margin-bottom: 0;
  }
}
.node-instances-card__head {
  flex-wrap: wrap;
  gap: 8px;
}
.node-instances-card__toolbar {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}
.node-instances-card__refresh {
  margin-left: 0;
}
.instance-hint-collapse {
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-card);
  --el-collapse-border-color: transparent;
}
.instance-hint-collapse :deep(.el-collapse-item__header) {
  padding: 12px 14px;
  font-weight: 500;
  background: var(--el-fill-color-blank);
  color: var(--text-primary);
}
.instance-hint-collapse :deep(.el-collapse-item__wrap) {
  border-top: 1px solid var(--border-light);
  background: var(--bg-card);
}
.collapse-hint-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 14px;
}
.collapse-hint-icon {
  color: var(--text-secondary);
}
.section-hint-body {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.65;
  padding: 4px 4px 8px;
}
.section-hint-body p {
  margin: 0 0 10px;
}
.section-hint-body p:last-child {
  margin-bottom: 0;
}
.section-hint-body code {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--el-fill-color-light);
}
.mesh-note-panel {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: #f7f8fa;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  color: var(--text-regular);
  line-height: 1.6;
}
.mesh-note-panel__icon {
  flex-shrink: 0;
  margin-top: 2px;
  font-size: 16px;
  color: var(--text-secondary);
}
.mesh-note-panel__text {
  margin: 0;
  font-size: 13px;
}
.node-readonly-block {
  margin-bottom: 8px;
}
.node-subsection-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.node-readonly-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: clamp(12px, 2.5vw, 32px);
  row-gap: 10px;
}
.node-kv {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  flex: 0 1 auto;
  max-width: 100%;
}
.node-kv-label {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
.node-kv-val {
  font-size: 13px;
  color: var(--text-primary);
  min-width: 0;
}
.node-kv-val--tags {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 运行概况：主数字与标签在卡内靠左对齐（自适应宽度） */
.node-overview .stat-card .stat-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  min-height: 56px;
  width: 100%;
  min-width: 0;
  text-align: left;
}

.node-overview .stat-label--overview {
  width: 100%;
  text-align: left;
}

.node-overview .stat-value--overview-num {
  display: flex;
  width: 100%;
  justify-content: flex-start;
  align-items: center;
  text-align: left;
}

.node-overview .stat-value--overview-num .stat-value-text {
  display: inline-block;
  max-width: 100%;
}

.stat-latest {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  width: 100%;
  text-align: left;
}

.stat-value--latest {
  white-space: normal;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: baseline;
  width: 100%;
}

.stat-inline-online-num {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-agent-version-display {
  width: 100%;
  text-align: left;
  font-size: 12px;
  line-height: 1.45;
  font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  word-break: break-all;
}

.stat-agent-version-display--latest {
  color: var(--el-color-success);
  font-weight: 600;
}

.stat-agent-version-display--stale {
  color: var(--el-color-danger);
  font-weight: 600;
}

.stat-agent-version-display--warn {
  color: var(--el-color-warning);
  font-weight: 500;
}

.stat-agent-version-display--empty {
  color: var(--text-secondary);
  font-weight: 500;
}

.stat-label--overview {
  margin-top: 4px;
}

.node-kv-wg {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-lighter);
}
.node-kv-wg > .node-kv-label {
  flex-shrink: 0;
  padding-top: 3px;
}
.node-kv-wg .wg-key-inline {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}
.node-edit-divider {
  margin: 20px 0 16px;
}
.node-edit-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  column-gap: clamp(12px, 2.5vw, 32px);
  row-gap: 12px;
}
.node-meta-form {
  max-width: 100%;
}
.node-meta-form :deep(.el-form-item) {
  display: inline-flex;
  align-items: center;
  margin-bottom: 0;
  flex: 0 1 auto;
}
.node-meta-form :deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--text-secondary);
}
.node-meta-form :deep(.el-form-item__content) {
  flex: 0 1 auto;
}
.node-edit-input {
  width: min(220px, 100%);
  max-width: 100%;
}
.node-edit-input--wide {
  width: min(300px, 100%);
  max-width: 100%;
}
@media (max-width: 768px) {
  .node-edit-strip :deep(.el-form-item) {
    flex: 1 1 100%;
    max-width: 100%;
  }
  .node-edit-strip :deep(.el-form-item__content) {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
  }
  .node-edit-input,
  .node-edit-input--wide {
    width: 100%;
  }
}
.wg-key-inline {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  max-width: 100%;
}
.wg-key-text {
  word-break: break-all;
}
.wg-key-copy {
  flex-shrink: 0;
  padding: 0 4px;
}
.segment-tag {
  margin: 0 8px 6px 0;
}
.mt-md {
  margin-top: 16px;
}
.mesh-summary-block {
  margin-bottom: 16px;
  padding: 14px 16px;
  background: var(--bg-card);
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--border-light);
  border-left: 3px solid var(--color-primary);
  width: 100%;
  box-sizing: border-box;
}
.instance-cards-wrap {
  width: 100%;
}

.instance-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 252px), 320px));
  gap: 12px;
  width: 100%;
  align-items: stretch;
}

.node-instances-card .instance-card.record-card {
  width: 100%;
  min-width: 0;
  max-width: 320px;
  justify-self: start;
  box-sizing: border-box;
  padding: 10px 12px 8px;
}

.node-instances-card .instance-card .record-card__head {
  margin-bottom: 8px;
}

.node-instances-card .instance-card .record-card__actions {
  margin-top: 8px;
  padding-top: 8px;
}

.instance-card__head {
  align-items: center !important;
}
.inst-segment-cell {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.inst-segment-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.inst-segment-copy {
  flex-shrink: 0;
  padding: 2px 4px;
  margin: 0;
}
.instance-card__fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.inst-field-row--top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(76px, 100px) minmax(102px, 118px);
  gap: 8px 8px;
  align-items: end;
}

/* 与 small 控件底边对齐：纯文本模式行高与输入框可视高度一致 */
.inst-field-row--top .inst-field__ctl--text {
  min-height: var(--el-component-size-small);
  display: flex;
  align-items: center;
  box-sizing: border-box;
}

.inst-field--stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.inst-field--stack .inst-select-proto,
.inst-field--stack .inst-input-port {
  width: 100%;
  max-width: none;
}

.inst-field--row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 6px 8px;
  align-items: center;
  min-width: 0;
}

.inst-field__label {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.3;
}

.inst-field--row .inst-field__label {
  padding-top: 1px;
}

.inst-field__ctl {
  width: 100%;
  min-width: 0;
}

.inst-field__ctl--text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
}

.instance-card--readonly .instance-card__fields {
  gap: 8px;
}

.inst-select-proto {
  max-width: none;
}

.inst-input-port {
  max-width: none;
}

.inst-input-cidr {
  width: 100%;
}

.inst-select-exit {
  width: 100%;
}

@media (max-width: 720px) {
  .instance-cards-grid {
    grid-template-columns: 1fr;
  }

  .node-instances-card .instance-card.record-card {
    max-width: none;
    justify-self: stretch;
  }

  .tunnel-cards-grid {
    grid-template-columns: 1fr;
  }

  .tunnel-section .tunnel-card {
    max-width: none;
    justify-self: stretch;
  }

  .inst-field-row--top {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}
.mesh-summary-section {
  margin-bottom: 10px;
}
.mesh-summary-section:last-child {
  margin-bottom: 0;
}
.mesh-summary-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
  font-weight: 600;
}
.mesh-tag {
  margin: 0 6px 4px 0;
}
.mesh-wg-line {
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  row-gap: 6px;
}
.mesh-wg-line:last-child {
  margin-bottom: 0;
}
.mesh-wg-k {
  min-width: 2.5em;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 600;
}
.mesh-wg-v {
  font-size: 13px;
}
.mesh-wg-peer {
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.mesh-wg-ip {
  font-family: ui-monospace, monospace;
}
.mesh-wg-port {
  font-family: ui-monospace, monospace;
  color: var(--el-color-primary);
}
.listen-summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 12px;
}
.listen-summary-label {
  color: var(--el-text-color-secondary);
  font-weight: 600;
}
.listen-summary-tag {
  font-family: ui-monospace, monospace;
}
.listen-summary-pending {
  color: var(--el-color-warning);
  font-weight: 500;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tunnel-section__head {
  margin-bottom: var(--spacing-md);
}

.tunnel-cards-wrap {
  width: 100%;
}

.tunnel-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 268px), 400px));
  gap: 12px;
  align-items: stretch;
}

.tunnel-section .tunnel-card.record-card {
  width: 100%;
  min-width: 0;
  max-width: 400px;
  justify-self: start;
  box-sizing: border-box;
}

.tunnel-empty {
  padding: 8px 0 4px;
}
.mb-md {
  margin-bottom: 12px;
}
.post-create-deploy {
  margin-top: 8px;
}
.mt-sm {
  margin-top: 8px;
}
</style>
