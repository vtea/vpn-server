<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">节点管理</span>
        <div style="display:flex;gap:8px;">
          <el-button v-if="canManageAllNodes" @click="openUpgradeDialog">批量升级 Agent</el-button>
          <el-button v-if="canManageAllNodes" type="primary" @click="showAdd = true">
            <el-icon><Plus /></el-icon> 添加节点
          </el-button>
        </div>
      </div>

      <div class="action-bar">
        <div class="filter-group">
          <el-input
            v-model="search"
            placeholder="搜索名称 / IP..."
            clearable
            style="width: 220px"
            :prefix-icon="Search"
          />
          <el-select v-model="statusFilter" placeholder="状态筛选" clearable style="width: 130px">
            <el-option label="在线" value="online" />
            <el-option label="离线" value="offline" />
          </el-select>
        </div>
        <el-text type="info" size="small">共 {{ filteredRows.length }} 个节点</el-text>
      </div>

      <div v-loading="loading" class="record-grid record-grid--nodes">
        <div
          v-for="row in filteredRows"
          :key="row.node.id"
          class="record-card node-list-card"
          :class="recordCardToneClass('node', row.node.status)"
        >
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title record-card__title--with-node-num">
                <el-link type="primary" @click="$router.push(`/nodes/${row.node.id}`)">
                  {{ row.node.name }}
                </el-link>
                <span
                  v-if="row.node.node_number != null && row.node.node_number !== ''"
                  class="node-title-node-number"
                >
                  · {{ row.node.node_number }}
                </span>
              </div>
              <div class="record-card__meta">
                {{ row.node.region || '—' }}
                <span v-if="row.node.public_ip"> · {{ row.node.public_ip }}</span>
              </div>
            </div>
            <div class="record-card__head-aside">
              <el-tooltip
                v-if="agentUpgradeHintText(row.node?.agent_version) !== '已最新'"
                placement="top"
                :content="agentVersionTooltip(row.node)"
              >
                <el-tag
                  size="small"
                  :type="agentUpgradeHintType(row.node?.agent_version)"
                  :style="{ cursor: agentUpgradeHintText(row.node?.agent_version) === '需更新' ? 'pointer' : 'default' }"
                  class="node-agent-status-tag"
                  @click="openUpgradeIfNeeded(row)"
                >
                  {{ agentUpgradeHintText(row.node?.agent_version) }}
                </el-tag>
              </el-tooltip>
              <el-tooltip
                placement="top"
                :content="`${getStatusInfo('node', row.node.status).label}，在线用户 ${row.node.online_users ?? 0}`"
              >
                <span class="node-user-orbit-tooltip">
                  <span
                    class="node-user-orbit-wrap"
                    :class="
                      isNodeOnline(row.node.status) ? 'node-user-orbit-wrap--online' : 'node-user-orbit-wrap--offline'
                    "
                  >
                    <span v-if="isNodeOnline(row.node.status)" class="node-user-orbit-spin" aria-hidden="true" />
                    <span
                      class="node-user-orbit-inner"
                      :class="nodeUserOrbitSizeClass(row.node.online_users)"
                    ><span class="node-user-orbit-num">{{ row.node.online_users ?? 0 }}</span></span>
                  </span>
                </span>
              </el-tooltip>
            </div>
          </div>
          <div class="record-card__tags record-card__tags--node-list">
            <template v-if="enabledInstances(row.instances).length">
              <el-tooltip
                v-for="inst in enabledInstances(row.instances)"
                :key="inst.id"
                placement="top"
                :content="instanceTagTooltip(inst)"
              >
                <el-tag size="small" class="instance-tag">
                  {{ instanceTagLabel(inst) }}
                </el-tag>
              </el-tooltip>
            </template>
            <el-text v-else type="info" size="small">暂无已启用接入</el-text>
          </div>
          <div class="record-card__actions">
            <el-button
              size="small"
              plain
              :loading="wgRefreshLoadingId === row.node.id"
              @click="refreshWG(row.node)"
            >
              刷新WG
            </el-button>
            <el-button size="small" type="primary" plain @click="$router.push(`/nodes/${row.node.id}`)">
              <el-icon><EditPen /></el-icon> 编辑
            </el-button>
            <el-button size="small" type="danger" plain @click="openDeleteDialog(row.node)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </div>
        </div>
        <el-empty v-if="!loading && !filteredRows.length" :description="nodesEmptyDescription" :image-size="60" />
      </div>
    </div>

    <el-dialog v-model="showAdd" title="添加节点" width="520px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
        各接入实例的 VPN 子网由系统按节点号与所选网段自动分配，无需手工填写。
      </el-alert>
      <el-form :model="addForm" label-width="100px">
        <el-form-item label="组网网段" required>
          <el-select
            v-model="addForm.segment_ids"
            multiple
            filterable
            placeholder="至少选择一个网段"
            style="width: 100%"
          >
            <el-option
              v-for="s in segmentOptions"
              :key="s.id"
              :label="`${s.name} (${s.id})`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="addForm.name" placeholder="如: Shanghai" />
        </el-form-item>
        <el-form-item label="地域">
          <el-input v-model="addForm.region" placeholder="如: cn-east" />
        </el-form-item>
        <el-form-item label="公网地址">
          <el-input v-model="addForm.public_ip" placeholder="如: 1.2.3.4 或 node.example.com" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="addLoading" @click="doAdd">确认添加</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showDelete" title="删除节点" width="400px" destroy-on-close @closed="deletePassword = ''">
      <p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px;">
        删除节点将清理相关隧道与接入配置，此操作不可恢复。请输入当前登录管理员密码确认。
      </p>
      <el-input v-model="deletePassword" type="password" placeholder="管理员密码" show-password @keyup.enter="confirmDelete" />
      <template #footer>
        <el-button @click="showDelete = false">取消</el-button>
        <el-button type="danger" :loading="deleteLoading" @click="confirmDelete">确认删除</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showUpgrade" title="批量升级 Agent" width="720px" destroy-on-close>
      <el-form :model="upgradeForm" label-width="120px">
        <el-form-item label="目标版本" required>
          <el-input v-model="upgradeForm.version" placeholder="如: 0.2.1" />
        </el-form-item>
        <el-form-item label="架构推荐">
          <el-select v-model="upgradeForm.arch" style="width:100%" @change="applyArchCandidate">
            <el-option label="amd64" value="amd64" />
            <el-option label="arm64" value="arm64" />
          </el-select>
        </el-form-item>
        <el-form-item label="下载地址" required>
          <el-input v-model="upgradeForm.download_url" placeholder="https://.../vpn-agent-linux-amd64" />
        </el-form-item>
        <el-form-item label="内网地址">
          <el-input v-model="upgradeForm.download_url_lan" placeholder="http://intranet/.../vpn-agent-linux-amd64 (可选)" />
        </el-form-item>
        <el-form-item label="SHA256" required>
          <el-input v-model="upgradeForm.sha256" placeholder="64 位 sha256" />
        </el-form-item>
        <el-form-item label="灰度节点">
          <el-select v-model="upgradeForm.canary_node_id" clearable placeholder="默认自动选第一个在线节点" style="width:100%">
            <el-option v-for="n in onlineNodes" :key="n.node.id" :label="`${n.node.name} (${n.node.id})`" :value="n.node.id" />
          </el-select>
        </el-form-item>
      </el-form>

      <el-alert v-if="upgradeTask.id" type="info" :closable="false" show-icon style="margin-bottom:12px;">
        任务 #{{ upgradeTask.id }} 状态：{{ upgradeTask.status }}，成功 {{ upgradeTaskSuccessDisplay }}/{{
          upgradeTaskTotalDisplay
        }}，失败 {{ upgradeTaskFailDisplay
        }}<span v-if="upgradeTask.status === 'running'">（进行中按节点汇总；结束后与任务汇总一致）</span>
      </el-alert>
      <div v-if="upgradeItems.length" class="dialog-record-stack">
        <div
          v-for="(it, idx) in upgradeItems"
          :key="idx"
          class="record-card"
          :class="recordCardToneFromTagType(upgradeStatusTagType(it.status))"
        >
          <div class="record-card__head">
            <div class="record-card__title mono-text min-w-0">{{ it.node_id }}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end">
              <el-tag size="small" effect="plain">{{ formatUpgradeStage(it.stage) }}</el-tag>
              <el-tag size="small" :type="upgradeStatusTagType(it.status)">
                {{ formatUpgradeStatus(it.status) }}
              </el-tag>
            </div>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">版本 / 步骤</span>
              <span class="kv-value">{{ it.result_version || '—' }} · {{ it.step || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">错误码</span>
              <span class="kv-value">{{ it.error_code || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">信息</span>
              <span class="kv-value">{{ it.message || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">日志摘要</span>
              <span class="kv-value">{{ it.stderr_tail || '—' }}</span>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showUpgrade = false">关闭</el-button>
        <el-button type="primary" :loading="upgradeLoading" @click="startUpgrade">开始灰度+全量</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElLoading, ElMessage, ElNotification } from 'element-plus'
import { Search, EditPen, Plus, Delete } from '@element-plus/icons-vue'
import http from '../api/http'
import { getAdminProfile, isSuperAdminSession } from '../utils/adminSession'
import { getStatusInfo, recordCardToneClass, recordCardToneFromTagType } from '../utils'

const rows = ref([])
/** 列表接口 403 时用于空状态文案，避免显示「暂无节点」误导 */
const nodesListForbidden = ref(false)
const loading = ref(false)
const search = ref('')
const statusFilter = ref('')
const showAdd = ref(false)
const addLoading = ref(false)
const router = useRouter()
const showDelete = ref(false)
const deleteLoading = ref(false)
const deletePassword = ref('')
const deleteTargetId = ref('')
const segmentOptions = ref([])
const addForm = reactive({ name: '', region: '', public_ip: '', segment_ids: ['default'] })
const showUpgrade = ref(false)
const upgradeLoading = ref(false)
const upgradeTask = ref({})
const upgradeItems = ref([])
const upgradePollTimer = ref(null)
const latestAgentVersion = ref('')
const nodeUpgradeStatusMap = ref({})
const upgradeForm = reactive({
  version: '',
  arch: 'amd64',
  download_url: '',
  download_url_lan: '',
  sha256: '',
  canary_node_id: ''
})
const upgradeCandidates = ref({})
/** 正在执行「刷新WG」的节点 id，用于按钮 loading */
const wgRefreshLoadingId = ref('')

/**
 * 运行中任务仅在结束时写入 success_count；进行中按各节点子项聚合，避免「成功 0/5」与卡片已显示成功不一致。
 */
const upgradeTaskSuccessDisplay = computed(() => {
  const t = upgradeTask.value
  if (t?.status === 'running') {
    return upgradeItems.value.filter((i) => i.status === 'succeeded').length
  }
  return t?.success_count ?? 0
})

/** @returns {number} */
const upgradeTaskFailDisplay = computed(() => {
  const t = upgradeTask.value
  if (t?.status === 'running') {
    return upgradeItems.value.filter((i) => i.status === 'failed' || i.status === 'timeout').length
  }
  return t?.failed_count ?? 0
})

/** @returns {number} */
const upgradeTaskTotalDisplay = computed(() => {
  const t = upgradeTask.value
  if (t?.total_nodes != null && t.total_nodes !== '') return Number(t.total_nodes)
  return upgradeItems.value.length
})

const displayAgentVersion = (v) => {
  const s = String(v || '').trim().replace(/^v/i, '').replace(/-unknown$/i, '')
  return s
}

/** 列表卡片：在线绿圈 / 离线红圈，圈内为在线用户数 */
const isNodeOnline = (status) => String(status || '').toLowerCase() === 'online'

const nodeUserOrbitSizeClass = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return ''
  if (v > 999) return 'node-user-orbit--digits-4'
  if (v > 99) return 'node-user-orbit--digits-3'
  if (v > 9) return 'node-user-orbit--digits-2'
  return ''
}

/** 悬停在「版本状态」标签上：完整版本与补充信息 */
const agentVersionTooltip = (node) => {
  const raw = String(node?.agent_version || '').trim()
  const verLine = raw ? `版本：${raw}` : '版本：未上报'
  const arch = node?.agent_arch ? `架构：${node.agent_arch}` : ''
  const lat = latestAgentVersion.value ? `仓库参考：${latestAgentVersion.value}` : ''
  return [verLine, arch, lat].filter(Boolean).join('\n')
}

/**
 * 仅全局可新建节点、发起全量 Agent 升级。
 * 须与 JWT 优先的 `isSuperAdminSession` 对齐：勿仅依赖本地 profile（丢失时超管会误隐藏按钮）。
 */
const canManageAllNodes = computed(() => {
  if (isSuperAdminSession()) return true
  const p = getAdminProfile()
  return p?.node_scope === 'all'
})

const nodesEmptyDescription = computed(() => {
  if (nodesListForbidden.value) {
    return '当前账号无权查看节点列表（需具备「节点管理」模块权限）'
  }
  const p = getAdminProfile()
  if (p?.node_scope === 'scoped' && Array.isArray(p.node_ids) && p.node_ids.length === 0) {
    return '当前账号未分配任何可管理节点，请联系超级管理员在「管理员管理」中配置节点范围'
  }
  return '暂无节点'
})

const filteredRows = computed(() => {
  let list = rows.value
  if (statusFilter.value) {
    list = list.filter(r => r.node?.status === statusFilter.value)
  }
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(r =>
      (r.node?.name || '').toLowerCase().includes(q) ||
      (r.node?.public_ip || '').includes(q)
    )
  }
  return list
})

const enabledInstances = (list) => (list || []).filter((i) => i.enabled === true)
const onlineNodes = computed(() => rows.value.filter(r => r.node?.status === 'online'))
const modeLabel = (mode) => {
  const m = {
    'node-direct': '节点直连',
    'cn-split': '国内分流',
    global: '全局'
  }
  return m[mode] || mode || '-'
}

/** 列表标签：直连/分流/全局 + U/T + 端口 */
const modeShortLabel = (mode) => {
  const m = { 'node-direct': '直连', 'cn-split': '分流', global: '全局' }
  return m[mode] || (mode ? String(mode) : '—')
}

const instanceTagLabel = (inst) => {
  const p = (inst.proto || 'udp').toLowerCase() === 'tcp' ? 'T' : 'U'
  return `${modeShortLabel(inst.mode)}${p}${inst.port}`
}

const instanceTagTooltip = (inst) => {
  const seg = inst.segment_id || 'default'
  const proto = (inst.proto || 'udp').toUpperCase()
  const parts = [
    `${modeLabel(inst.mode)} ${proto}/${inst.port}`,
    `网段实例: ${seg}`
  ]
  if (inst.subnet) parts.push(`子网: ${inst.subnet}`)
  if (inst.mode) parts.push(`mode: ${inst.mode}`)
  return parts.join('\n')
}

const loadSegments = async () => {
  try {
    const res = await http.get('/api/network-segments')
    segmentOptions.value = res.data.items || []
    if (!addForm.segment_ids?.length && segmentOptions.value.length) {
      addForm.segment_ids = ['default'].filter(id =>
        segmentOptions.value.some(s => s.id === id)
      )
      if (!addForm.segment_ids.length) {
        addForm.segment_ids = [segmentOptions.value[0].id]
      }
    }
  } catch {
    segmentOptions.value = []
  }
}

const loadNodes = async () => {
  loading.value = true
  nodesListForbidden.value = false
  try {
    rows.value = (await http.get('/api/nodes')).data.items || []
  } catch (e) {
    const st = e.response?.status
    if (st === 403) {
      nodesListForbidden.value = true
      rows.value = []
    }
  } finally {
    loading.value = false
  }
}

const loadNodeUpgradeStatus = async () => {
  try {
    const res = await http.get('/api/nodes/upgrade-status', {
      // Backward compatible: old api may not have this endpoint.
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404
    })
    if (res.status === 404) {
      nodeUpgradeStatusMap.value = {}
      return
    }
    const items = res.data?.items || []
    if (res.data?.latest_version) latestAgentVersion.value = displayAgentVersion(res.data.latest_version)
    const m = {}
    for (const it of items) {
      if (it.node_id) m[it.node_id] = it
    }
    nodeUpgradeStatusMap.value = m
  } catch {
    nodeUpgradeStatusMap.value = {}
  }
}

const doAdd = async () => {
  if (!addForm.segment_ids?.length) {
    ElMessage.warning('请至少选择一个组网网段')
    return
  }
  addLoading.value = true
  try {
    const res = await http.post('/api/nodes', {
      name: addForm.name,
      region: addForm.region,
      public_ip: addForm.public_ip,
      segment_ids: addForm.segment_ids
    })
    ElMessage.success(
      '节点创建成功。默认仅启用“节点直连”，其它模式请在节点详情「组网接入」中手动启用并保存。'
    )
    showAdd.value = false
    Object.assign(addForm, { name: '', region: '', public_ip: '', segment_ids: ['default'] })
    await loadNodes()
    const nid = res.data?.node?.id
    const postCreateDeploy = {
      token: res.data.bootstrap_token || '',
      online: res.data.deploy_command || '',
      offline: res.data.deploy_offline || '',
      scriptUrl: res.data.script_url || '',
      onlineLan: res.data.deploy_command_lan || '',
      offlineLan: res.data.deploy_offline_lan || '',
      scriptUrlLan: res.data.script_url_lan || '',
      apiUrlLan: res.data.api_url_lan || '',
      deployUrlWarning: res.data.deploy_url_warning || '',
      deployUrlNote: res.data.deploy_url_note || ''
    }
    if (nid) {
      await router.push({ path: `/nodes/${nid}`, state: { postCreateDeploy } })
    } else {
      ElMessage.warning('已创建但响应缺少节点 ID，请从列表进入详情')
    }
  } finally {
    addLoading.value = false
  }
}

const openDeleteDialog = (node) => {
  deleteTargetId.value = node.id
  deletePassword.value = ''
  showDelete.value = true
}

const confirmDelete = async () => {
  if (!deletePassword.value) {
    ElMessage.warning('请输入密码')
    return
  }
  deleteLoading.value = true
  try {
    await http.post(`/api/nodes/${deleteTargetId.value}/delete`, { password: deletePassword.value })
    ElMessage.success('已删除')
    showDelete.value = false
    loadNodes()
  } catch {
    // http.js 已统一处理
  } finally {
    deleteLoading.value = false
  }
}

/**
 * 解析「刷新 WG」请求失败时的展示文案（与拦截器 silent 配合，避免无提示）。
 * @param {unknown} e - axios 错误对象
 * @returns {string}
 */
const wgRefreshErrorText = (e) => {
  const st = e?.response?.status
  const data = e?.response?.data
  const errStr =
    data && typeof data === 'object' && typeof data.error === 'string'
      ? data.error
      : typeof data === 'string'
        ? data
        : ''
  if (errStr) return errStr
  if (st) return `请求失败（HTTP ${st}）`
  if (e?.code === 'ECONNABORTED' || String(e?.message || '').includes('timeout')) {
    return '请求超时，请确认 vpn-api 可达，且「API 连接」未误填为页面端口'
  }
  return '无法连接 API 或请求被中断，请检查网络与 API 地址'
}

/**
 * 向在线 Agent 下发 WireGuard 快照（与节点详情中的隧道配置一致）。
 * 使用全屏 Loading + 右上角通知，避免仅依赖 ElMessage 时被样式/层级遮挡或静默失败。
 */
const refreshWG = async (node) => {
  if (!node?.id) return
  const id = String(node.id)
  wgRefreshLoadingId.value = id
  /** @type {import('element-plus').LoadingInstance | null} */
  let loadingInst = null
  try {
    loadingInst = ElLoading.service({
      lock: true,
      text: '正在下发 WireGuard 配置…',
      background: 'rgba(0, 0, 0, 0.35)'
    })
    const res = await http.post(`/api/nodes/${id}/wg-refresh`, {}, { meta: { silentGlobalError: true } })
    const data = res?.data && typeof res.data === 'object' ? res.data : {}
    const invalid = Number(data.invalid) || 0
    const total = Number(data.total_tunnel) || 0
    const base =
      invalid > 0
        ? `共 ${total} 条隧道，其中 ${invalid} 条配置校验未通过，请到节点详情「相关隧道」查看并修正。`
        : total > 0
          ? `已向 Agent 下发配置（${total} 条隧道，校验均通过）。`
          : '已向 Agent 下发配置（当前无隧道条目）。'
    const msg =
      data.delivery === 'queued'
        ? `${base} 控制面已先返回；配置正通过 WebSocket 在后台下发至节点。`
        : base
    ElNotification({
      title: invalid > 0 ? 'WireGuard：已下发（有告警）' : 'WireGuard：已下发',
      message: msg,
      type: invalid > 0 ? 'warning' : 'success',
      duration: 10000,
      position: 'top-right'
    })
  } catch (e) {
    if (e?.response?.status === 401) {
      return
    }
    ElNotification({
      title: 'WireGuard 刷新失败',
      message: wgRefreshErrorText(e),
      type: 'error',
      duration: 12000,
      position: 'top-right'
    })
  } finally {
    loadingInst?.close()
    wgRefreshLoadingId.value = ''
  }
}

const stopUpgradePoll = () => {
  if (upgradePollTimer.value) {
    clearInterval(upgradePollTimer.value)
    upgradePollTimer.value = null
  }
}

const loadUpgradeTask = async (taskId) => {
  if (!taskId) return
  const [tRes, iRes] = await Promise.all([
    http.get(`/api/agent-upgrades/${taskId}`),
    http.get(`/api/agent-upgrades/${taskId}/items`)
  ])
  upgradeTask.value = tRes.data.task || {}
  upgradeItems.value = iRes.data.items || []
  if (['succeeded', 'failed'].includes(upgradeTask.value.status)) {
    stopUpgradePoll()
    await loadNodes()
    await loadNodeUpgradeStatus()
  }
}

const openUpgradeDialog = () => {
  upgradeTask.value = {}
  upgradeItems.value = []
  Object.assign(upgradeForm, {
    version: '',
    arch: 'amd64',
    download_url: '',
    download_url_lan: '',
    sha256: '',
    canary_node_id: ''
  })
  showUpgrade.value = true
  loadUpgradeDefaults()
}

const openUpgradeFromNode = async (row) => {
  const nodeID = row?.node?.id
  openUpgradeDialog()
  upgradeForm.canary_node_id = nodeID || ''
  const st = nodeUpgradeStatusMap.value[nodeID]
  if (st?.task_id) {
    await loadUpgradeTask(st.task_id)
  }
}

const openUpgradeIfNeeded = (row) => {
  if (agentUpgradeHintText(row?.node?.agent_version) !== '需更新') return
  openUpgradeFromNode(row)
}

const loadUpgradeDefaults = async () => {
  try {
    const res = await http.get('/api/agent-upgrades/defaults', {
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
      /** 403 时走 catch 内本地 fallback，避免与全局 403 提示重复 */
      meta: { suppress403: true }
    })
    if (res.status === 404) {
      throw new Error('defaults endpoint not available')
    }
    const d = res.data?.defaults || {}
    if (d.version) latestAgentVersion.value = displayAgentVersion(d.version)
    upgradeCandidates.value = d.candidates || {}
    upgradeForm.version = d.version || upgradeForm.version
    upgradeForm.arch = d.recommended_arch || d.arch || upgradeForm.arch
    applyArchCandidate(upgradeForm.arch, d)
  } catch {
    // Backward compatible fallback when backend endpoint is unavailable (e.g. old api binary).
    const origin = window.location.origin
    const fallback = {
      version: '19700101.000000',
      arch: 'amd64',
      recommended_arch: 'amd64',
      download_url: `${origin}/api/downloads/vpn-agent/amd64/vpn-agent+19700101.000000`,
      download_url_lan: '',
      sha256: '',
      candidates: {
        amd64: {
          download_url: `${origin}/api/downloads/vpn-agent/amd64/vpn-agent+19700101.000000`,
          download_url_lan: '',
          sha256: ''
        },
        arm64: {
          download_url: `${origin}/api/downloads/vpn-agent/arm64/vpn-agent+19700101.000000`,
          download_url_lan: '',
          sha256: ''
        }
      }
    }
    upgradeCandidates.value = fallback.candidates
    latestAgentVersion.value = displayAgentVersion(fallback.version)
    upgradeForm.version = fallback.version
    upgradeForm.arch = fallback.recommended_arch
    applyArchCandidate(upgradeForm.arch, fallback)
  }
}

const applyArchCandidate = (arch, fallbackDefaults = null) => {
  const c = upgradeCandidates.value?.[arch]
  if (c) {
    upgradeForm.download_url = c.download_url || ''
    upgradeForm.download_url_lan = c.download_url_lan || ''
    upgradeForm.sha256 = c.sha256 || ''
    return
  }
  const d = fallbackDefaults || {}
  upgradeForm.download_url = d.download_url || upgradeForm.download_url
  upgradeForm.download_url_lan = d.download_url_lan || upgradeForm.download_url_lan
  upgradeForm.sha256 = d.sha256 || upgradeForm.sha256
}

const startUpgrade = async () => {
  if (!upgradeForm.version || !upgradeForm.download_url || !upgradeForm.sha256) {
    ElMessage.warning('请填写版本、下载地址和 SHA256')
    return
  }
  upgradeLoading.value = true
  try {
    const res = await http.post('/api/agent-upgrades', {
      version: upgradeForm.version,
      download_url: upgradeForm.download_url,
      download_url_lan: upgradeForm.download_url_lan || '',
      sha256: upgradeForm.sha256,
      canary_node_id: upgradeForm.canary_node_id || ''
    })
    const taskId = res.data?.task?.id
    if (!taskId) {
      ElMessage.error('创建升级任务失败：无任务 ID')
      return
    }
    ElMessage.success(`已创建升级任务 #${taskId}`)
    await loadUpgradeTask(taskId)
    stopUpgradePoll()
    upgradePollTimer.value = setInterval(() => loadUpgradeTask(taskId), 3000)
  } finally {
    upgradeLoading.value = false
  }
}

const formatUpgradeStage = (stage) => {
  const m = {
    canary: '灰度',
    rollout: '全量',
  }
  return m[stage] || stage || '-'
}

const formatUpgradeStatus = (status) => {
  const m = {
    prechecking: '预检中',
    pending: '待执行',
    running: '执行中',
    verifying: '校验中',
    succeeded: '成功',
    failed: '失败',
    timeout: '超时',
    skipped: '跳过',
  }
  return m[status] || status || '-'
}

const upgradeStatusTagType = (status) => {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'timeout') return 'danger'
  if (status === 'running' || status === 'prechecking' || status === 'verifying') return 'warning'
  if (status === 'skipped') return 'info'
  return 'info'
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

const agentUpgradeHintText = (current) => {
  if (!current) return '未上报'
  if (!parseVersion(current)) return '版本异常'
  if (!parseVersion(latestAgentVersion.value)) return '版本未知'
  const cmp = compareVersion(current, latestAgentVersion.value)
  if (cmp >= 0) return '已最新'
  return '需更新'
}

const agentUpgradeHintType = (current) => {
  if (!current) return 'warning'
  if (!parseVersion(current) || !parseVersion(latestAgentVersion.value)) return 'warning'
  const cmp = compareVersion(current, latestAgentVersion.value)
  return cmp >= 0 ? 'success' : 'danger'
}

onMounted(async () => {
  await loadUpgradeDefaults()
  await loadSegments()
  await loadNodes()
  await loadNodeUpgradeStatus()
})

onUnmounted(() => {
  stopUpgradePoll()
})
</script>

<style scoped>
/* 节点列表：Grid align-items:start + 卡片 height:auto，避免悬停展开时同行卡片被拉高、标签区 flex 吃满留白 */
.record-grid--nodes {
  align-items: start;
}

.record-grid--nodes .node-list-card.record-card {
  height: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
}

/*
 * 全局 .record-card:hover 使用 translateY(-2px)，卡片上移后指针相对落在卡片外，:hover 丢失，
 * 悬停展开的操作区立刻收回且 pointer-events 变回 none →「刷新WG」等按钮无法点击、脚本也无从执行。
 * 节点列表卡片保留阴影反馈，取消位移。
 */
.record-grid--nodes .node-list-card.record-card:hover {
  transform: none;
}

.node-list-card .record-card__head {
  flex-shrink: 0;
}

.instance-tag {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  cursor: default;
  white-space: nowrap;
}

.node-list-card .record-card__tags--node-list :deep(.instance-tag.el-tag) {
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 22px;
  border-radius: 4px;
}

.node-list-card .record-card__tags--node-list {
  flex: 0 1 auto;
  min-height: 36px;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  gap: 4px 6px;
  overflow: visible;
}

/* 默认收起操作区，悬停/键盘焦点时展开；触控或窄屏始终显示 */
.node-list-card .record-card__actions {
  flex-shrink: 0;
  margin-top: 0;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  padding-top: 0;
  border-top: none;
  transition:
    max-height 0.28s ease,
    opacity 0.22s ease,
    padding-top 0.22s ease,
    border-color 0.2s ease;
  /* 与全局卡片 hover 位移修复配合：展开后需始终可点，勿用 none 以免悬停抖动时整区失效 */
  pointer-events: auto;
}

.node-list-card:hover .record-card__actions,
.node-list-card:focus-within .record-card__actions {
  max-height: 96px;
  opacity: 1;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--glass-edge);
}

@media (hover: none), (max-width: 768px) {
  .node-list-card .record-card__actions {
    max-height: none;
    opacity: 1;
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--glass-edge);
  }
}

.record-card__title--with-node-num {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 4px;
  max-width: 100%;
}

.node-title-node-number {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.record-card__tags--node-list {
  margin-top: 2px;
}

.node-agent-status-tag {
  max-width: 100%;
}

.record-card__head-aside {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 避免 EP tooltip 触发器 inline 基线把圆顶歪 */
.node-user-orbit-tooltip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  line-height: 0;
}

/* 线框圆 + 在线时绿色光束绕圈旋转 */
.node-user-orbit-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  line-height: 0;
  cursor: default;
  user-select: none;
}

/* 光带只落在圆环外圈，像「绿色光线」沿圆周旋转 */
.node-user-orbit-spin {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 210deg,
    rgba(74, 222, 128, 0.2) 228deg,
    rgba(34, 197, 94, 1) 258deg,
    rgba(190, 242, 100, 0.95) 275deg,
    rgba(74, 222, 128, 0.35) 292deg,
    transparent 312deg,
    transparent 360deg
  );
  animation: node-user-orbit-rotate 1.8s linear infinite;
  mask: radial-gradient(
    circle closest-side at center,
    transparent 0,
    transparent 52%,
    #000 54%,
    #000 71%,
    transparent 73%
  );
  -webkit-mask: radial-gradient(
    circle closest-side at center,
    transparent 0,
    transparent 52%,
    #000 54%,
    #000 71%,
    transparent 73%
  );
}

@media (prefers-reduced-motion: reduce) {
  .node-user-orbit-spin {
    animation: none;
    opacity: 0.35;
  }
}

@keyframes node-user-orbit-rotate {
  to {
    transform: rotate(360deg);
  }
}

.node-user-orbit-inner {
  position: relative;
  z-index: 1;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  box-sizing: border-box;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
  display: grid;
  place-items: center;
  margin: 0;
  padding: 0;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  line-height: 0;
}

.node-user-orbit-num {
  display: block;
  line-height: 1;
  text-align: center;
  margin: 0;
  padding: 0;
}

.node-user-orbit-wrap--online .node-user-orbit-inner {
  border: 2px solid rgba(22, 163, 74, 0.45);
  background: rgba(255, 255, 255, 0.92);
  color: #166534;
}

.node-user-orbit-wrap--offline .node-user-orbit-inner {
  border: 2px solid rgba(220, 38, 38, 0.5);
  background: rgba(254, 242, 242, 0.95);
  color: #b91c1c;
}

.node-user-orbit-inner.node-user-orbit--digits-2 {
  font-size: 11px;
}

.node-user-orbit-inner.node-user-orbit--digits-3 {
  font-size: 10px;
}

.node-user-orbit-inner.node-user-orbit--digits-4 {
  font-size: 8px;
  letter-spacing: -0.04em;
}
</style>
