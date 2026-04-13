<template>
  <div class="login-page">
    <div class="login-container">
      <div class="login-banner">
        <div class="banner-content">
          <div class="banner-icon">
            <el-icon :size="48"><Lock /></el-icon>
          </div>
          <h2>VPN 管理中心</h2>
          <p>安全、高效的企业级 VPN 管理平台</p>
        </div>
      </div>
      <div class="login-form-wrap">
        <div class="login-form-inner">
          <h3 class="login-title">管理员登录</h3>
          <p class="login-subtitle">请输入您的账号和密码</p>
          <el-form :model="form" @submit.prevent="onSubmit" size="large">
            <el-form-item>
              <el-input
                v-model="form.username"
                placeholder="用户名"
                :prefix-icon="User"
              />
            </el-form-item>
            <el-form-item>
              <el-input
                v-model="form.password"
                type="password"
                placeholder="密码"
                show-password
                :prefix-icon="Lock"
                @keyup.enter="onSubmit"
              />
            </el-form-item>
            <el-button
              type="primary"
              :loading="loading"
              @click="onSubmit"
              class="login-btn"
            >
              登 录
            </el-button>
          </el-form>
          <div class="login-hint">
            <el-text type="info" size="small">默认账号：admin / admin123</el-text>
          </div>
          <el-collapse class="login-api-collapse">
            <el-collapse-item title="API 地址（前后端分离时配置）" name="api">
              <el-input
                v-model="apiBaseInput"
                placeholder="留空则使用构建配置或同域 /api/…"
                clearable
                size="small"
              />
              <div class="api-base-actions">
                <el-button size="small" type="primary" @click="saveApiBase">保存</el-button>
              </div>
              <p class="api-base-tip">登录后可在侧栏「API 连接」中修改。</p>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import http, { setApiBaseURL } from '../api/http'
import { API_BASE_STORAGE_KEY } from '../utils/apiBase'
import { setAuthSession } from '../utils/adminSession'
import router from '../router'

const loading = ref(false)
const form = reactive({ username: 'admin', password: 'admin123' })
const apiBaseInput = ref('')

onMounted(() => {
  const raw = localStorage.getItem(API_BASE_STORAGE_KEY)
  apiBaseInput.value = raw !== null ? raw : ''
})

const saveApiBase = () => {
  setApiBaseURL(apiBaseInput.value)
  ElMessage.success('API 地址已保存')
}

const onSubmit = async () => {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  loading.value = true
  try {
    const res = await http.post('/api/auth/login', form)
    setAuthSession({ token: res.data.token, admin: res.data.admin })
    ElMessage.success('登录成功')
    router.push('/')
  } catch {
    // http.js 已统一处理错误提示
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}

.login-container {
  display: flex;
  width: 800px;
  max-width: 100%;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.login-banner {
  width: 340px;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.banner-content {
  text-align: center;
  color: #fff;
  padding: 40px;
}

.banner-icon {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 24px;
}

.banner-content h2 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
}

.banner-content p {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0;
}

.login-form-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 40px;
}

.login-form-inner {
  width: 100%;
  max-width: 320px;
}

.login-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.login-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 32px;
}

.login-btn {
  width: 100%;
  height: 44px;
  font-size: 16px;
  border-radius: var(--radius-sm);
}

.login-hint {
  text-align: center;
  margin-top: 16px;
}

.login-api-collapse {
  margin-top: 20px;
  border: none;
  --el-collapse-header-bg-color: transparent;
}
.login-api-collapse :deep(.el-collapse-item__header) {
  font-size: 13px;
  color: var(--text-secondary);
}
.api-base-actions {
  margin-top: 8px;
}
.api-base-tip {
  font-size: 12px;
  color: var(--text-placeholder);
  margin: 8px 0 0;
}

@media (max-width: 640px) {
  .login-banner { display: none; }
  .login-container { width: 100%; }
}
</style>
