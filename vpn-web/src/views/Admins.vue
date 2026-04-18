<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">管理员管理</span>
        <el-button type="primary" @click="openCreate" :disabled="!canManageAdmins">
          <el-icon><Plus /></el-icon> 添加管理员
        </el-button>
      </div>

      <div class="action-bar">
        <div class="filter-group">
          <el-tag v-for="r in roleOptions" :key="r.value" :type="r.tagType">
            {{ r.label }}
          </el-tag>
        </div>
        <el-text type="info" size="small">共 {{ admins.length }} 个管理员</el-text>
      </div>

      <div v-loading="loading" class="record-grid">
        <div
          v-for="row in admins"
          :key="row.id"
          class="record-card"
          :class="recordCardToneFromTagType(roleTagType(row.role))"
        >
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title">
                {{ row.username }}
                <el-tag v-if="row.username === 'admin'" size="small" type="danger" style="margin-left: 6px">默认</el-tag>
              </div>
              <div class="record-card__meta">#{{ row.id }} · {{ formatDate(row.created_at) }}</div>
            </div>
            <el-tag :type="roleTagType(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
          </div>
          <div class="record-card__tags">
            <template v-if="row.permissions === '*' || row.role === 'admin'">
              <el-tag size="small" type="danger">全部权限</el-tag>
            </template>
            <template v-else>
              <el-tag v-for="p in parsePerms(row.permissions)" :key="p" size="small" class="perm-tag">
                {{ permLabel(p) }}
              </el-tag>
            </template>
            <el-tag v-if="row.node_scope === 'scoped'" size="small" type="info" style="margin-left: 4px">
              节点 {{ (row.node_ids && row.node_ids.length) || 0 }} 个
            </el-tag>
          </div>
          <div class="record-card__actions">
            <el-button size="small" plain type="primary" @click="openEdit(row)" :disabled="!canManageAdmins">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button size="small" plain type="warning" @click="openResetPwd(row)" :disabled="!canManageAdmins">
              <el-icon><Lock /></el-icon> 重置密码
            </el-button>
            <el-button size="small" plain type="danger" @click="handleDelete(row)" :disabled="!canManageAdmins || row.username === 'admin'">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </div>
        </div>
        <el-alert
          v-if="!canManageAdmins"
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        >
          仅超级管理员可查看管理员列表并进行添加、编辑、重置密码、删除（角色为 admin 或权限为 *）。非超管不再从接口拉取列表。
        </el-alert>
        <el-empty v-if="!loading && !admins.length" description="暂无管理员" :image-size="60" />
      </div>
    </div>

    <!-- 创建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="isEditing ? '编辑管理员' : '添加管理员'" width="560px" destroy-on-close>
      <el-form :model="form" label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="form.username" :disabled="isEditing" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item v-if="!isEditing" label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少6位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option label="超级管理员" value="admin" />
            <el-option label="运维管理员" value="operator" />
            <el-option label="只读查看" value="viewer" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限" v-if="form.role !== 'admin'">
          <el-checkbox-group v-model="form.permList">
            <el-checkbox v-for="m in allModules" :key="m.value" :label="m.value">{{ m.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="form.role !== 'admin'" label="节点范围">
          <el-select
            v-model="form.nodeIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择可管理的节点（不选则列表为空）"
            style="width: 100%"
            :loading="nodeOptsLoading"
          >
            <el-option
              v-for="n in nodeOptions"
              :key="n.id"
              :label="`${n.name} (${n.id})`"
              :value="n.id"
            />
          </el-select>
          <el-text type="info" size="small" style="display: block; margin-top: 6px">
            决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。
          </el-text>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">确定</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码对话框 -->
    <el-dialog v-model="resetPwdVisible" title="重置密码" width="400px" destroy-on-close>
      <el-form :model="resetForm" label-width="80px">
        <el-form-item label="管理员">
          <el-input :model-value="resetForm.username" disabled />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="resetForm.newPassword" type="password" show-password placeholder="至少6位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetPwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="resetting" @click="handleResetPwd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Lock, Delete } from '@element-plus/icons-vue'
import http from '../api/http'
import { formatDate, recordCardToneFromTagType } from '../utils'
import { isSuperAdminSession } from '../utils/adminSession'

const admins = ref([])
const nodeOptions = ref([])
const nodeOptsLoading = ref(false)
const loading = ref(false)
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref(null)
const saving = ref(false)
const resetPwdVisible = ref(false)
const resetting = ref(false)

const allModules = [
  { value: 'nodes', label: '节点管理' },
  { value: 'users', label: '授权管理' },
  { value: 'rules', label: '分流规则' },
  { value: 'tunnels', label: '隧道状态' },
  { value: 'audit', label: '审计日志' },
  { value: 'admins', label: '管理员管理' },
]

const roleOptions = [
  { value: 'admin', label: '超级管理员 - 全部权限', tagType: 'danger' },
  { value: 'operator', label: '运维管理员 - 可配置指定模块', tagType: 'warning' },
  { value: 'viewer', label: '只读查看 - 仅查看指定模块', tagType: 'info' },
]

const form = ref({ username: '', password: '', role: 'operator', permList: [], nodeIds: [] })
const resetForm = ref({ id: null, username: '', newPassword: '' })

/** 与侧栏、后端一致：超级管理员 = role=admin 或 permissions=* */
const canManageAdmins = computed(() => isSuperAdminSession())

const parsePerms = (s) => {
  if (!s) return []
  return s.split(',').map(p => p.trim()).filter(Boolean)
}

const permLabel = (p) => {
  const m = allModules.find(mod => mod.value === p)
  return m ? m.label : p
}

const roleLabel = (r) => {
  if (r === 'admin') return '超级管理员'
  if (r === 'operator') return '运维管理员'
  if (r === 'viewer') return '只读查看'
  return r
}

const roleTagType = (r) => {
  if (r === 'admin') return 'danger'
  if (r === 'operator') return 'warning'
  return 'info'
}

const fetchAdmins = async () => {
  if (!canManageAdmins.value) {
    admins.value = []
    return
  }
  loading.value = true
  try {
    admins.value = (await http.get('/api/admins')).data.items || []
  } finally {
    loading.value = false
  }
}

const loadNodeOptions = async () => {
  if (!canManageAdmins.value) return
  nodeOptsLoading.value = true
  try {
    const { data } = await http.get('/api/nodes', { meta: { suppress403: true } })
    nodeOptions.value = (data.items || []).map((item) => item.node).filter(Boolean)
  } catch {
    nodeOptions.value = []
  } finally {
    nodeOptsLoading.value = false
  }
}

const openCreate = async () => {
  isEditing.value = false
  editingId.value = null
  form.value = {
    username: '',
    password: '',
    role: 'operator',
    permList: ['nodes', 'users', 'rules', 'tunnels', 'audit'],
    nodeIds: [],
  }
  await loadNodeOptions()
  dialogVisible.value = true
}

const openEdit = async (row) => {
  isEditing.value = true
  editingId.value = row.id
  const perms = row.permissions === '*' ? allModules.map(m => m.value) : parsePerms(row.permissions)
  const nids = row.node_scope === 'scoped' && Array.isArray(row.node_ids) ? [...row.node_ids] : []
  form.value = { username: row.username, password: '', role: row.role, permList: perms, nodeIds: nids }
  await loadNodeOptions()
  dialogVisible.value = true
}

const handleSave = async () => {
  const permissions = form.value.role === 'admin' ? '*' : form.value.permList.join(',')
  if (isEditing.value) {
    saving.value = true
    try {
      const body = { role: form.value.role, permissions }
      if (form.value.role !== 'admin') {
        body.node_ids = form.value.nodeIds || []
      }
      await http.patch(`/api/admins/${editingId.value}`, body)
      ElMessage.success('更新成功')
      dialogVisible.value = false
      fetchAdmins()
    } finally {
      saving.value = false
    }
  } else {
    if (!form.value.username || !form.value.password) {
      ElMessage.warning('请填写用户名和密码')
      return
    }
    if (form.value.password.length < 6) {
      ElMessage.warning('密码至少6位')
      return
    }
    saving.value = true
    try {
      const payload = {
        username: form.value.username,
        password: form.value.password,
        role: form.value.role,
        permissions,
      }
      if (form.value.role !== 'admin') {
        payload.node_ids = form.value.nodeIds || []
      }
      await http.post('/api/admins', payload)
      ElMessage.success('创建成功')
      dialogVisible.value = false
      fetchAdmins()
    } finally {
      saving.value = false
    }
  }
}

const openResetPwd = (row) => {
  resetForm.value = { id: row.id, username: row.username, newPassword: '' }
  resetPwdVisible.value = true
}

const handleResetPwd = async () => {
  if (resetForm.value.newPassword.length < 6) {
    ElMessage.warning('密码至少6位')
    return
  }
  resetting.value = true
  try {
    await http.post(`/api/admins/${resetForm.value.id}/reset-password`, {
      new_password: resetForm.value.newPassword,
    })
    ElMessage.success('密码重置成功')
    resetPwdVisible.value = false
  } finally {
    resetting.value = false
  }
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm(`确定删除管理员 "${row.username}" 吗？`, '确认删除', { type: 'warning' })
    await http.delete(`/api/admins/${row.id}`)
    ElMessage.success('删除成功')
    fetchAdmins()
  } catch {
    // 用户取消或 http.js 已处理
  }
}

onMounted(fetchAdmins)
</script>

<style scoped>
.perm-tag {
  margin: 2px 4px 2px 0;
}
</style>
