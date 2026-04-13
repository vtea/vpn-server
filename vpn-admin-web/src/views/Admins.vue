<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">管理员管理</span>
        <el-button type="primary" @click="openCreate" :disabled="!isAdmin">
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

      <el-table :data="admins" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="60" align="center" />
        <el-table-column prop="username" label="用户名" width="160">
          <template #default="{ row }">
            <span>{{ row.username }}</span>
            <el-tag v-if="row.username === 'admin'" size="small" type="danger" style="margin-left: 6px">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="role" label="角色" width="120">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="权限模块" min-width="260">
          <template #default="{ row }">
            <template v-if="row.permissions === '*' || row.role === 'admin'">
              <el-tag size="small" type="danger">全部权限</el-tag>
            </template>
            <template v-else>
              <el-tag v-for="p in parsePerms(row.permissions)" :key="p" size="small" class="perm-tag">
                {{ permLabel(p) }}
              </el-tag>
            </template>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right" align="center" class-name="op-col">
          <template #default="{ row }">
            <el-button size="small" plain type="primary" @click="openEdit(row)" :disabled="!isAdmin">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button size="small" plain type="warning" @click="openResetPwd(row)" :disabled="!isAdmin">
              <el-icon><Lock /></el-icon> 重置密码
            </el-button>
            <el-button size="small" plain type="danger" @click="handleDelete(row)" :disabled="!isAdmin || row.username === 'admin'">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 创建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="isEditing ? '编辑管理员' : '添加管理员'" width="500px" destroy-on-close>
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
import http from '../api/http'
import { formatDate } from '../utils'
import { parseJwtPayload } from '../utils/jwt'

const admins = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref(null)
const saving = ref(false)
const resetPwdVisible = ref(false)
const resetting = ref(false)

const allModules = [
  { value: 'nodes', label: '节点管理' },
  { value: 'users', label: '用户管理' },
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

const form = ref({ username: '', password: '', role: 'operator', permList: [] })
const resetForm = ref({ id: null, username: '', newPassword: '' })

const currentAdmin = computed(() => {
  const token = localStorage.getItem('token')
  if (!token) return {}
  const p = parseJwtPayload(token)
  return p || {}
})

const isAdmin = computed(() => currentAdmin.value.role === 'admin')

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
  loading.value = true
  try {
    admins.value = (await http.get('/api/admins')).data.items || []
  } finally {
    loading.value = false
  }
}

const openCreate = () => {
  isEditing.value = false
  editingId.value = null
  form.value = {
    username: '',
    password: '',
    role: 'operator',
    permList: ['nodes', 'users', 'rules', 'tunnels', 'audit'],
  }
  dialogVisible.value = true
}

const openEdit = (row) => {
  isEditing.value = true
  editingId.value = row.id
  const perms = row.permissions === '*' ? allModules.map(m => m.value) : parsePerms(row.permissions)
  form.value = { username: row.username, password: '', role: row.role, permList: perms }
  dialogVisible.value = true
}

const handleSave = async () => {
  const permissions = form.value.role === 'admin' ? '*' : form.value.permList.join(',')
  if (isEditing.value) {
    saving.value = true
    try {
      await http.patch(`/api/admins/${editingId.value}`, { role: form.value.role, permissions })
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
      await http.post('/api/admins', {
        username: form.value.username,
        password: form.value.password,
        role: form.value.role,
        permissions,
      })
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
