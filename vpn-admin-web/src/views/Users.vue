<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">用户管理</span>
        <el-button type="primary" @click="showAdd = true">
          <el-icon><Plus /></el-icon> 添加用户
        </el-button>
      </div>

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

      <el-table :data="filteredRows" v-loading="loading" stripe>
        <el-table-column prop="username" label="用户名" width="130" />
        <el-table-column prop="display_name" label="姓名" width="130" />
        <el-table-column prop="group_name" label="组" width="110" />
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <span>
              <span class="status-dot" :class="`status-dot--${row.status}`" />
              {{ getStatusInfo('user', row.status).label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column :width="isMobileViewport ? 220 : 240" label="操作" align="center" class-name="op-col">
          <template #default="{ row }">
            <el-button size="small" plain type="primary" @click="openGrants(row)">
              <el-icon><Key /></el-icon> 授权
            </el-button>
            <el-button size="small" plain type="primary" @click="openEdit(row)">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-popconfirm title="删除用户并吊销所有证书？" @confirm="deleteUser(row.id)">
              <template #reference>
                <el-button size="small" plain type="danger">
                  <el-icon><Delete /></el-icon> 删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 添加用户 -->
    <el-dialog v-model="showAdd" title="添加用户" width="min(450px, 92vw)" destroy-on-close class="user-form-dialog">
      <el-form :model="addForm" label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="addForm.username" />
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
      <el-table :data="grants" size="small" stripe class="mb-md">
        <el-table-column prop="cert_cn" label="证书 CN" min-width="140" />
        <el-table-column prop="cert_status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusInfo('cert', row.cert_status).type" size="small">
              {{ getStatusInfo('cert', row.cert_status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column :width="isMobileViewport ? 420 : 420" label="操作" align="center" class-name="op-col">
          <template #default="{ row }">
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
              @click="downloadOVPN(row.id)"
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
          </template>
        </el-table-column>
      </el-table>
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
            :label="`${inst.node_name || inst.node_id} (${inst.node_id}) / ${inst.mode} (${(inst.proto || 'udp').toUpperCase()}) :${inst.port}`"
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
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import http from '../api/http'
import { getStatusInfo } from '../utils'

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
const isMobileViewport = ref(false)

const updateViewportState = () => {
  isMobileViewport.value = window.innerWidth <= 768
}

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
    http.get('/api/nodes'),
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
  } catch {
    // http 拦截器已提示 error 文案
  } finally {
    grantLoading.value = false
  }
}

const downloadOVPN = async (id) => {
  try {
    const res = await http.get(`/api/grants/${id}/download`, { responseType: 'blob' })
    const disposition = res.headers['content-disposition'] || ''
    const match = disposition.match(/filename="?(.+?)"?$/)
    const filename = match ? match[1] : `grant-${id}.ovpn`
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
  } catch {
    // 用户取消或 http.js 已处理
  }
}

const retryIssue = async (id) => {
  try {
    await http.post(`/api/grants/${id}/retry-issue`)
    ElMessage.success('已重新向节点下发签发任务，请稍后刷新查看状态')
    grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || []
  } catch {
    // http 拦截器已提示
  }
}

onMounted(() => void loadUsers().catch(() => {}))
onMounted(() => {
  updateViewportState()
  window.addEventListener('resize', updateViewportState)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewportState)
})
</script>

<style scoped>
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
.grant-instance-select {
  width: 320px;
  max-width: 100%;
}
.grant-create-btn {
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .grant-create-row {
    flex-wrap: wrap;
    align-items: stretch;
    gap: 8px;
  }
  .grant-instance-select {
    width: 100%;
  }
  .grant-create-btn {
    width: 100%;
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
  .grant-dialog :deep(.el-table .el-button),
  .page-card :deep(.el-table .el-button) {
    margin: 2px 4px 2px 0;
    white-space: nowrap;
  }
  .grant-dialog :deep(.el-table__cell) {
    white-space: nowrap;
  }
}
</style>
