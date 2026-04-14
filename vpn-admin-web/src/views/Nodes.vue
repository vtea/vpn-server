<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">节点管理</span>
        <div style="display:flex;gap:8px;">
          <el-button @click="openUpgradeDialog">批量升级 Agent</el-button>
          <el-button type="primary" @click="showAdd = true">
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

      <el-table :data="filteredRows" v-loading="loading" stripe>
        <el-table-column prop="node.name" label="名称" min-width="120">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/nodes/${row.node.id}`)">
              {{ row.node.name }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column prop="node.region" label="地域" width="100" />
        <el-table-column prop="node.public_ip" label="公网 IP" width="140" />
        <el-table-column prop="node.node_number" label="节点号" width="80" align="center" />
        <el-table-column prop="node.status" label="状态" width="90">
          <template #default="{ row }">
            <span>
              <span class="status-dot" :class="`status-dot--${row.node.status}`" />
              {{ getStatusInfo('node', row.node.status).label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="node.online_users" label="在线" width="70" align="center" />
        <el-table-column label="Agent版本" width="220">
          <template #default="{ row }">
            <span>{{ displayAgentVersion(row.node?.agent_version) || '-' }}</span>
            <el-text v-if="row.node?.agent_arch" type="info" size="small"> / {{ row.node.agent_arch }}</el-text>
            <el-text type="info" size="small"> (latest: {{ latestAgentVersion || '-' }})</el-text>
          </template>
        </el-table-column>
        <el-table-column label="升级提示" width="120" align="center">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="agentUpgradeHintType(row.node?.agent_version)"
              :style="{ cursor: agentUpgradeHintText(row.node?.agent_version) === '需更新' ? 'pointer' : 'default' }"
              @click="openUpgradeIfNeeded(row)"
            >
              {{ agentUpgradeHintText(row.node?.agent_version) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="接入/网段" min-width="220">
          <template #default="{ row }">
            <el-tag
              v-for="inst in enabledInstances(row.instances)"
              :key="inst.id"
              size="small"
              class="instance-tag"
            >
              {{ inst.segment_id || 'default' }} · {{ inst.mode }} {{ (inst.proto || 'udp').toUpperCase() }}/{{ inst.port }}
            </el-tag>
            <el-text v-if="!enabledInstances(row.instances).length" type="info" size="small">暂无</el-text>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" align="center" class-name="op-col">
          <template #default="{ row }">
            <el-button size="small" plain @click="refreshWG(row.node)">
              刷新WG
            </el-button>
            <el-button size="small" type="primary" plain @click="$router.push(`/nodes/${row.node.id}`)">
              <el-icon><EditPen /></el-icon> 编辑
            </el-button>
            <el-button size="small" type="danger" plain @click="openDeleteDialog(row.node)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
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
        <el-form-item label="公网 IP">
          <el-input v-model="addForm.public_ip" placeholder="如: 1.2.3.4" />
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
        任务 #{{ upgradeTask.id }} 状态：{{ upgradeTask.status }}，成功 {{ upgradeTask.success_count || 0 }}/{{ upgradeTask.total_nodes || 0 }}，失败 {{ upgradeTask.failed_count || 0 }}
      </el-alert>
      <el-table v-if="upgradeItems.length" :data="upgradeItems" size="small" stripe max-height="220">
        <el-table-column prop="node_id" label="节点" min-width="120" />
        <el-table-column prop="stage" label="阶段" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ formatUpgradeStage(row.stage) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="upgradeStatusTagType(row.status)">
              {{ formatUpgradeStatus(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="result_version" label="版本" width="100" />
        <el-table-column prop="step" label="步骤" width="110" />
        <el-table-column prop="error_code" label="错误码" width="130" />
        <el-table-column prop="message" label="信息" min-width="220" show-overflow-tooltip />
        <el-table-column prop="stderr_tail" label="日志摘要" min-width="220" show-overflow-tooltip />
      </el-table>
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
import { ElMessage } from 'element-plus'
import { Search, EditPen } from '@element-plus/icons-vue'
import http from '../api/http'
import { getStatusInfo } from '../utils'

const rows = ref([])
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

const displayAgentVersion = (v) => {
  const s = String(v || '').trim().replace(/^v/i, '').replace(/-unknown$/i, '')
  return s
}

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
  try {
    rows.value = (await http.get('/api/nodes')).data.items || []
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
      '节点创建成功。默认仅启用 local-only 接入，其它模式请在节点详情「组网接入」中手动启用并保存。'
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

const refreshWG = async (node) => {
  if (!node?.id) return
  try {
    const res = await http.post(`/api/nodes/${node.id}/wg-refresh`)
    const invalid = res.data?.invalid || 0
    ElMessage.success(`已下发WG刷新任务（无效peer: ${invalid}）`)
  } catch {
    // http.js 已统一处理
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
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404
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
  return ''
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
.instance-tag {
  margin: 2px 4px 2px 0;
}
</style>
