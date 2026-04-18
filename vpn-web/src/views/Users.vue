<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">授权管理</span>
        <el-button v-if="hasModulePermission('users')" type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon> 添加用户
        </el-button>
      </div>

      <el-alert
        v-if="scopedWithoutNodesHint"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      >
        {{ scopedWithoutNodesHint }}
      </el-alert>
      <el-alert
        v-if="scopedNodeHint"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      >
        {{ scopedNodeHint }}
      </el-alert>

      <div class="action-bar">
        <div class="filter-group">
          <el-input
            v-model="search"
            placeholder="搜索用户名 / 姓名..."
            clearable
            style="width: 220px"
            :prefix-icon="Search"
          />
          <el-select v-model="groupFilter" placeholder="按组筛选" clearable style="width: 140px">
            <el-option v-for="g in groups" :key="g" :label="g" :value="g" />
          </el-select>
        </div>
        <el-text type="info" size="small">共 {{ filteredRows.length }} 个用户</el-text>
      </div>

      <div v-loading="loading" class="record-grid">
        <div
          v-for="row in filteredRows"
          :key="row.id"
          class="record-card"
          :class="recordCardToneClass('user', row.status)"
        >
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title">{{ row.username }}</div>
              <div class="record-card__meta">{{ row.display_name || '—' }} · {{ row.group_name || 'default' }}</div>
            </div>
            <span>
              <span class="status-dot" :class="`status-dot--${row.status}`" />
              {{ getStatusInfo('user', row.status).label }}
            </span>
          </div>
          <div class="record-card__actions">
            <el-button size="small" plain type="primary" @click="openGrants(row)">
              <el-icon><Key /></el-icon> 授权
            </el-button>
            <el-tooltip
              :disabled="!row.cross_scope_edit_blocked"
              content="该用户在其它节点仍有有效 VPN 授权，无法在此编辑整户资料；请联系超级管理员。"
              placement="top"
            >
              <span class="action-tooltip-wrap">
                <el-button
                  size="small"
                  plain
                  type="primary"
                  :disabled="!!row.cross_scope_edit_blocked"
                  @click="openEdit(row)"
                >
                  <el-icon><Edit /></el-icon> 编辑
                </el-button>
              </span>
            </el-tooltip>
            <el-tooltip
              :disabled="!row.cross_scope_edit_blocked"
              content="该用户在其它节点仍有有效 VPN 授权，无法在此删除整户；请联系超级管理员。"
              placement="top"
            >
              <span class="action-tooltip-wrap">
                <el-popconfirm title="删除用户并吊销所有证书？" @confirm="deleteUser(row.id)">
                  <template #reference>
                    <el-button size="small" plain type="danger" :disabled="!!row.cross_scope_edit_blocked">
                      <el-icon><Delete /></el-icon> 删除
                    </el-button>
                  </template>
                </el-popconfirm>
              </span>
            </el-tooltip>
          </div>
        </div>
        <el-empty v-if="!loading && !filteredRows.length" description="暂无用户" :image-size="60" />
      </div>
    </div>

    <!-- 添加用户 -->
    <el-dialog v-model="showAdd" title="添加用户" width="min(450px, 92vw)" destroy-on-close class="user-form-dialog">
      <el-form :model="addForm" label-width="80px">
        <el-form-item label="用户名">
          <el-input
            v-model="addForm.username"
            :readonly="!isSuperAdminSession()"
            placeholder="与登录名一致"
          />
          <el-text v-if="!isSuperAdminSession()" type="info" size="small" style="display: block; margin-top: 4px">
            非超级管理员仅可创建与当前登录名一致的 VPN 用户，用于后续在本账户下签发证书。
          </el-text>
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="addForm.display_name" />
        </el-form-item>
        <el-form-item label="组">
          <el-input v-model="addForm.group_name" placeholder="default" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="addLoading" @click="doAdd">确认</el-button>
      </template>
    </el-dialog>

    <!-- 编辑用户 -->
    <el-dialog v-model="showEdit" title="编辑用户" width="min(450px, 92vw)" destroy-on-close class="user-form-dialog">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="姓名">
          <el-input v-model="editForm.display_name" />
        </el-form-item>
        <el-form-item label="组">
          <el-input v-model="editForm.group_name" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="editForm.status" style="width: 100%">
            <el-option label="正常" value="active" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" @click="doEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 授权管理 -->
    <el-dialog
      v-model="showGrants"
      width="min(720px, 94vw)"
      destroy-on-close
      :show-close="false"
      class="grant-dialog"
    >
      <template #header="{ titleId, titleClass, close }">
        <div class="grant-dialog-header">
          <span :id="titleId" :class="titleClass">
            授权管理 - {{ grantUser.display_name || grantUser.username }}
          </span>
          <span class="grant-dialog-header__actions">
            <el-tooltip content="刷新状态" placement="bottom">
              <el-button
                text
                circle
                :loading="grantsRefreshLoading"
                @click="refreshGrants"
              >
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
            <el-button text circle class="grant-dialog-header__close" @click="close">
              <el-icon class="el-dialog__close"><Close /></el-icon>
            </el-button>
          </span>
        </div>
      </template>
      <div class="dialog-record-stack mb-md">
        <div
          v-for="row in grants"
          :key="row.id"
          class="record-card"
          :class="recordCardToneClass('cert', row.cert_status)"
        >
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title mono-text">{{ row.cert_cn }}</div>
            </div>
            <el-tag :type="getStatusInfo('cert', row.cert_status).type" size="small">
              {{ getStatusInfo('cert', row.cert_status).label }}
            </el-tag>
          </div>
          <div class="record-card__actions grant-card__actions">
            <el-button
              size="small"
              plain
              type="warning"
              v-if="['pending','placeholder','failed'].includes(row.cert_status)"
              @click="retryIssue(row.id)"
            >
              重试签发
            </el-button>
            <el-button
              size="small"
              plain
              type="primary"
              @click="downloadOVPN(row.id, row.cert_cn)"
              :disabled="!['active','placeholder'].includes(row.cert_status)"
            >
              <el-icon><Download /></el-icon> 下载
            </el-button>
            <el-button
              size="small"
              plain
              type="danger"
              @click="revokeGrant(row.id)"
              :disabled="['revoked','revoking'].includes(row.cert_status)"
            >
              <el-icon><CircleClose /></el-icon> 吊销
            </el-button>
            <el-button
              size="small"
              plain
              type="danger"
              @click="purgeGrant(row.id)"
              :disabled="row.cert_status === 'active'"
            >
              删除
            </el-button>
          </div>
        </div>
        <el-empty v-if="!grants.length" description="暂无授权" :image-size="48" />
      </div>
      <el-text type="info" size="small" style="display: block; margin-top: 8px">
        下载将自动返回与节点实例协议一致的配置文件。
      </el-text>

      <el-divider>添加新授权</el-divider>
      <el-text v-if="grantableInstances.length === 0" type="info" size="small" class="mb-md" style="display: block">
        当前没有可新增的实例（实例可能已关闭、已全部授权，或仅存在可重新签发的已吊销项——请在上方列表操作）。
      </el-text>
      <div class="filter-group grant-create-row">
        <el-select v-model="newGrantInstanceId" placeholder="选择实例" class="grant-instance-select" clearable>
          <el-option
            v-for="inst in grantableInstances"
            :key="inst.id"
            :label="grantInstanceOptionLabel(inst)"
            :value="inst.id"
          />
        </el-select>
        <el-button
          type="primary"
          class="grant-create-btn"
          @click="doGrant"
          :loading="grantLoading"
          :disabled="grantableInstances.length === 0"
        >
          <el-icon><Plus /></el-icon> 授权
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Search,
  Plus,
  Key,
  Edit,
  Delete,
  Refresh,
  Close,
  Download,
  CircleClose
} from '@element-plus/icons-vue'
import http from '../api/http'
import {
  getAdminProfile,
  getSessionAdminUsername,
  hasModulePermission,
  isSuperAdminSession,
} from '../utils/adminSession'
import { getStatusInfo, recordCardToneClass } from '../utils'

/** 已选「按节点」但未分配任何节点时：授权列表恒为空，需超管配置 */
const scopedWithoutNodesHint = computed(() => {
  const p = getAdminProfile()
  if (p?.node_scope !== 'scoped') return ''
  const ids = Array.isArray(p.node_ids) ? p.node_ids : []
  if (ids.length > 0) return ''
  return '当前账号未分配任何节点，无法查看或新增 VPN 授权；请联系超级管理员在「管理员管理」中为您勾选可管辖节点。'
})

/** 超级管理员按节点管辖时的跨区说明；普通管理员仅能见同名 VPN 用户 */
const scopedNodeHint = computed(() => {
  const p = getAdminProfile()
  if (isSuperAdminSession()) {
    if (p?.node_scope !== 'scoped') return ''
    if (!Array.isArray(p.node_ids) || p.node_ids.length === 0) return ''
    return '列表已隐藏「仅在其它节点存在未结授权、且与您管辖节点无任何授权记录」的用户（超级管理员仍可见全量）。您仅能管理所选节点上的 VPN 授权；外区授权在已吊销、吊销中或失败状态下不计入跨区占用；若仍存在其它跨区未结授权，对其「编辑」或「删除」将被禁用，请联系超级管理员处理。'
  }
  return '超级管理员可查看全部用户并为任意名称创建 VPN 用户。当前列表仅显示「VPN 用户名与登录名一致」的账户；可通过「添加用户」创建同名 VPN 用户后再发起证书授权；若尚未创建则列表为空。'
})

const rows = ref([])
const loading = ref(false)
const search = ref('')
const groupFilter = ref('')

const showAdd = ref(false)
const addLoading = ref(false)
const addForm = reactive({ username: '', display_name: '', group_name: '' })

const showEdit = ref(false)
const editUserId = ref(null)
const editForm = reactive({ display_name: '', group_name: '', status: 'active' })

const showGrants = ref(false)
const grantUser = ref({})
const grants = ref([])
const allInstances = ref([])
const newGrantInstanceId = ref(null)
const grantLoading = ref(false)
const grantsRefreshLoading = ref(false)

const groups = computed(() => [...new Set(rows.value.map(r => r.group_name))].sort())

const filteredRows = computed(() => {
  let list = rows.value
  if (groupFilter.value) {
    list = list.filter(r => r.group_name === groupFilter.value)
  }
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(r =>
      (r.username || '').toLowerCase().includes(q) ||
      (r.display_name || '').toLowerCase().includes(q)
    )
  }
  return list
})

/** 组网模式中文简称（与节点列表一致） */
const modeMeshLabel = (mode) => {
  const m = { 'node-direct': '直连', 'cn-split': '分流', global: '全局' }
  return m[mode] || (mode ? String(mode) : '—')
}

/** 下拉展示：节点名称 (节点id) / 组网名称 (端口号) */
const grantInstanceOptionLabel = (inst) => {
  const nm = (inst.node_name || '').trim() || inst.node_id || '—'
  const nid = inst.node_id || '—'
  const mesh = modeMeshLabel(inst.mode)
  const port = inst.port != null && inst.port !== '' ? inst.port : '—'
  return `${nm} (${nid}) / ${mesh} (${port})`
}

/** 排除「已有待签发/可用等有效授权」的实例，避免重复提交触发 cert_cn 唯一约束 */
const grantableInstances = computed(() => {
  const blocked = new Set()
  for (const g of grants.value) {
    if (!['revoked', 'failed'].includes(g.cert_status)) {
      blocked.add(g.instance_id)
    }
  }
  return allInstances.value.filter(inst => inst.enabled === true && !blocked.has(inst.id))
})

const loadUsers = async () => {
  loading.value = true
  try {
    rows.value = (await http.get('/api/users')).data.items || []
  } finally {
    loading.value = false
  }
}

const openAddDialog = () => {
  if (isSuperAdminSession()) {
    Object.assign(addForm, { username: '', display_name: '', group_name: '' })
  } else {
    const u = getSessionAdminUsername()
    Object.assign(addForm, { username: u, display_name: '', group_name: '' })
  }
  showAdd.value = true
}

const doAdd = async () => {
  addLoading.value = true
  try {
    await http.post('/api/users', addForm)
    ElMessage.success('创建成功')
    showAdd.value = false
    Object.assign(addForm, { username: '', display_name: '', group_name: '' })
    loadUsers()
  } finally {
    addLoading.value = false
  }
}

const openEdit = (user) => {
  editUserId.value = user.id
  editForm.display_name = user.display_name
  editForm.group_name = user.group_name
  editForm.status = user.status
  showEdit.value = true
}

const doEdit = async () => {
  try {
    await http.patch(`/api/users/${editUserId.value}`, editForm)
    ElMessage.success('已保存')
    showEdit.value = false
    loadUsers()
  } catch {
    // http.js 已统一处理
  }
}

const deleteUser = async (id) => {
  try {
    await http.delete(`/api/users/${id}`)
    ElMessage.success('已删除')
    loadUsers()
  } catch {
    // http.js 已统一处理
  }
}

const openGrants = async (user) => {
  grantUser.value = user
  showGrants.value = true
  const [g, n] = await Promise.all([
    http.get(`/api/users/${user.id}/grants`),
    /** GET /api/grantable-nodes：仅需 users 模块，且路径不与 /api/users/:id 冲突 */
    http.get('/api/grantable-nodes'),
  ])
  grants.value = g.data.items || []
  const insts = []
  for (const item of (n.data.items || [])) {
    for (const inst of (item.instances || [])) {
      insts.push({
        ...inst,
        node_id: item.node?.id || inst.node_id,
        node_name: item.node?.name || ''
      })
    }
  }
  allInstances.value = insts
}

const refreshGrants = async () => {
  const uid = grantUser.value?.id
  if (!uid) return
  grantsRefreshLoading.value = true
  try {
    const { data } = await http.get(`/api/users/${uid}/grants`)
    grants.value = data.items || []
  } catch {
    // http 拦截器已提示
  } finally {
    grantsRefreshLoading.value = false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitGrantStatus = async (grantId, expectedStatus, maxAttempts = 8, intervalMs = 1500) => {
  const uid = grantUser.value?.id
  if (!uid) return false
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await http.get(`/api/users/${uid}/grants`)
    grants.value = data.items || []
    const target = grants.value.find((g) => g.id === grantId)
    if (target?.cert_status === expectedStatus) return true
    await sleep(intervalMs)
  }
  return false
}

const doGrant = async () => {
  if (!newGrantInstanceId.value) return
  grantLoading.value = true
  try {
    const { data } = await http.post(`/api/users/${grantUser.value.id}/grants`, {
      instance_id: newGrantInstanceId.value
    })
    ElMessage.success(data.reissued ? '已重新发起证书签发' : '授权成功')
    newGrantInstanceId.value = null
    grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || []
    await loadUsers()
  } catch {
    // http 拦截器已提示 error 文案
  } finally {
    grantLoading.value = false
  }
}

const safeOvpnBaseName = (cn) => {
  if (!cn || typeof cn !== 'string') return ''
  const s = cn.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return s || ''
}

const filenameFromContentDisposition = (cd) => {
  if (!cd) return ''
  const mStar = /filename\*=UTF-8''([^;\s]+)/i.exec(cd)
  if (mStar) {
    try {
      return decodeURIComponent(mStar[1].replace(/^"|"$/g, ''))
    } catch {
      return mStar[1].replace(/^"|"$/g, '')
    }
  }
  const mQ = /filename="([^"]+)"/i.exec(cd)
  if (mQ) return mQ[1]
  const mU = /filename=([^;\s]+)/i.exec(cd)
  if (mU) return mU[1].replace(/^"|"$/g, '')
  return ''
}

const downloadOVPN = async (id, certCN) => {
  try {
    const res = await http.get(`/api/grants/${id}/download`, { responseType: 'blob' })
    const disposition = res.headers['content-disposition'] || res.headers['Content-Disposition'] || ''
    const fromHeader = filenameFromContentDisposition(disposition)
    const fromCn = safeOvpnBaseName(certCN)
    const filename =
      fromHeader || (fromCn ? `${fromCn}.ovpn` : '') || `grant-${id}.ovpn`
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败')
  }
}

const revokeGrant = async (id) => {
  try {
    await ElMessageBox.confirm('确定吊销？', '确认', { type: 'warning' })
    const { data } = await http.delete(`/api/grants/${id}`)
    const status = data?.grant?.cert_status
    if (status === 'revoked') {
      ElMessage.success('已吊销')
    } else {
      ElMessage.success('已提交吊销请求，正在自动刷新状态...')
      const done = await waitGrantStatus(id, 'revoked')
      if (done) {
        ElMessage.success('吊销已完成')
      } else {
        ElMessage.warning('吊销请求已提交，状态同步稍慢，请稍后手动刷新')
      }
    }
    grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || []
    await loadUsers()
  } catch {
    // 用户取消或 http.js 已处理
  }
}

const purgeGrant = async (id) => {
  try {
    await ElMessageBox.confirm(
      '将永久从数据库中删除该授权记录（含已吊销项），以便同一实例可重新授权且不再触发证书 CN 冲突。确定删除？',
      '删除授权记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    await http.delete(`/api/grants/${id}/purge`)
    ElMessage.success('已删除记录')
    grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || []
    await loadUsers()
  } catch {
    // 用户取消或 http.js 已处理
  }
}

const retryIssue = async (id) => {
  try {
    await http.post(`/api/grants/${id}/retry-issue`)
    ElMessage.success('已重新向节点下发签发任务，请稍后刷新查看状态')
    grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || []
    await loadUsers()
  } catch {
    // http 拦截器已提示
  }
}

onMounted(() => void loadUsers().catch(() => {}))
</script>

<style scoped>
.action-tooltip-wrap {
  display: inline-flex;
  vertical-align: middle;
}

.grant-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 0;
}
.grant-dialog-header__actions {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.grant-dialog-header__close {
  margin-left: 0;
}
.grant-create-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
}

.grant-instance-select {
  flex: 1 1 auto;
  min-width: 0;
  width: 0;
  max-width: 100%;
}

.grant-create-btn {
  flex-shrink: 0;
  margin-left: auto;
}

/** 授权弹窗内证书卡片：减轻玻璃/色光阴影，避免在 dialog 内过重 */
.grant-dialog :deep(.dialog-record-stack .record-card) {
  background-image: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  transition:
    border-color var(--transition-normal, 0.2s ease),
    box-shadow var(--transition-normal, 0.2s ease);
}
.grant-dialog :deep(.dialog-record-stack .record-card:hover) {
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
  transform: none;
}
.grant-dialog :deep(.dialog-record-stack .record-card::after) {
  opacity: 0.2;
}
.grant-dialog :deep(.dialog-record-stack .record-card:hover::after) {
  opacity: 0.26;
}
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-success) {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.06),
    0 0 0 1px rgba(167, 243, 208, 0.55);
}
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-success:hover) {
  box-shadow:
    0 2px 8px rgba(15, 23, 42, 0.08),
    0 0 0 1px rgba(110, 231, 183, 0.65);
}
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-warning) {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.06),
    0 0 0 1px rgba(253, 230, 138, 0.65);
}
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-danger) {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.06),
    0 0 0 1px rgba(252, 165, 165, 0.55);
}
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-info),
.grant-dialog :deep(.dialog-record-stack .record-card.record-card--tone-muted) {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.06),
    0 0 0 1px rgba(203, 213, 225, 0.55);
}

/** 授权卡片：四按钮单行均分，覆盖全局 .record-card__actions 的 flex-wrap:wrap */
.grant-dialog :deep(.dialog-record-stack) {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
}
.grant-dialog :deep(.record-card__actions.grant-card__actions) {
  flex-wrap: nowrap !important;
  justify-content: space-between;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
}
.grant-dialog :deep(.record-card__actions.grant-card__actions .el-button) {
  flex: 1 1 0;
  min-width: 0;
  margin-inline: 0 !important;
  padding-inline: 6px;
  white-space: nowrap;
}
.grant-dialog :deep(.record-card__actions.grant-card__actions .el-button + .el-button) {
  margin-left: 0 !important;
}

@media (max-width: 768px) {
  .grant-create-row {
    flex-wrap: wrap;
    align-items: stretch;
    gap: 8px;
  }
  .grant-instance-select {
    width: 100%;
    flex: none;
  }
  .grant-create-btn {
    width: 100%;
    margin-left: 0;
  }
  .grant-dialog-header {
    gap: 8px;
  }
  .grant-dialog-header :deep(.el-dialog__title) {
    font-size: 15px;
  }
  .grant-dialog :deep(.el-dialog) {
    margin-top: 4vh !important;
  }
  .grant-dialog :deep(.el-dialog__body),
  .user-form-dialog :deep(.el-dialog__body) {
    padding: 12px;
  }
}
</style>
