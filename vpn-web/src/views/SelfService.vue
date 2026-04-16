<template>
  <div style="max-width:600px;margin:40px auto">
    <el-card v-if="!loggedIn">
      <template #header>员工自助门户</template>
      <el-form @submit.prevent="doLogin">
        <el-form-item label="用户名"><el-input v-model="username" placeholder="输入你的用户名" /></el-form-item>
        <el-button type="primary" @click="doLogin" :loading="loading" style="width:100%">查看我的配置</el-button>
      </el-form>
    </el-card>

    <template v-else>
      <el-page-header @back="loggedIn = false" :content="'我的 VPN 配置 — ' + username" style="margin-bottom:20px" />

      <el-alert v-if="!grants.length" type="info" title="暂无可用配置" description="管理员尚未为你分配 VPN 访问权限，请联系 IT 部门。" :closable="false" />

      <el-card v-for="g in grants" :key="g.id" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-weight:600">{{ g.cert_cn }}</div>
            <el-tag :type="g.cert_status === 'active' ? 'success' : g.cert_status === 'placeholder' ? 'warning' : 'danger'" size="small" style="margin-top:4px">
              {{ g.cert_status === 'active' ? '可用' : g.cert_status === 'placeholder' ? '待签发' : '已吊销' }}
            </el-tag>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <el-button type="primary" size="small" @click="download(g.id)" :disabled="!['active','placeholder'].includes(g.cert_status)">
              下载
            </el-button>
            <el-text type="info" size="small">下载将自动返回与节点实例协议一致的配置文件</el-text>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { publicHttp, getApiBaseURL } from '../api/http'

const username = ref('')
const loggedIn = ref(false)
const loading = ref(false)
const grants = ref([])

const doLogin = async () => {
  if (!username.value) return
  loading.value = true
  try {
    const res = await publicHttp.get('/api/self-service/lookup', { params: { username: username.value } })
    grants.value = res.data.grants || []
    loggedIn.value = true
  } catch (err) {
    const msg = err?.response?.data?.error
    if (err?.response?.status === 404) {
      ElMessage.error('用户名不存在')
    } else {
      ElMessage.error(msg || '查询失败，请联系管理员')
    }
  } finally {
    loading.value = false
  }
}

const download = (grantId) => {
  const path = `/api/self-service/grants/${grantId}/download?username=${encodeURIComponent(username.value)}`
  const root = getApiBaseURL()
  window.open(root ? `${root}${path}` : path, '_blank')
}
</script>
