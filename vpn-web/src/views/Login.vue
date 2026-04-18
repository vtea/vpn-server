<template>
  <div class="login-page">
    <div class="login-stack">
      <header class="login-brand">
        <div class="brand-logo" aria-hidden="true">V</div>
        <h1 class="brand-title">VPN 管理中心</h1>
        <p class="brand-sub">
          企业级 VPN 控制面 · 与控制台同一套界面规范
        </p>
      </header>

      <div class="login-card">
        <section class="card-block">
          <el-form :model="form" @submit.prevent="onSubmit" size="large" class="login-form">
            <el-form-item>
              <el-input
                v-model="form.username"
                placeholder="用户名"
                :prefix-icon="User"
                autocomplete="username"
              />
            </el-form-item>
            <el-form-item>
              <el-input
                v-model="form.password"
                type="password"
                placeholder="密码"
                show-password
                :prefix-icon="Lock"
                autocomplete="current-password"
                @keyup.enter="onSubmit"
              />
            </el-form-item>
            <el-button
              type="primary"
              :loading="loading"
              class="login-btn"
              @click="onSubmit"
            >
              登录
            </el-button>
          </el-form>
        </section>

        <div class="card-divider" />

        <section class="card-block api-block">
          <button
            type="button"
            class="api-header"
            :aria-expanded="apiOpen"
            @click="apiOpen = !apiOpen"
          >
            <span class="api-header-main">
              <span class="api-title">API 根地址</span>
              <span class="api-badge">前后端分离时填写</span>
            </span>
            <el-icon class="api-chevron" :class="{ open: apiOpen }">
              <ArrowDown />
            </el-icon>
          </button>
          <div v-show="apiOpen" class="api-body">
            <div class="api-row">
              <el-input
                v-model="apiBaseInput"
                placeholder="例如 https://vpnapi.example.com"
                clearable
              />
              <el-button type="primary" @click="saveApiBase">保存</el-button>
            </div>
            <p class="api-tip">
              无尾部斜杠、不要带 /api。登录后可在侧栏「API 连接」修改。
            </p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { User, Lock, ArrowDown } from '@element-plus/icons-vue'
import http, { setApiBaseURL, getUserConfiguredApiBaseForForm } from '../api/http'
import { setAuthSession } from '../utils/adminSession'
import router from '../router'

/** 登录页草稿：关标签后再开可恢复（勿与 token 混用） */
const LOGIN_DRAFT_KEY = 'vpn_web_login_draft'

const loading = ref(false)
/** 默认折叠「API 根地址」；展开后才显示输入区 */
const apiOpen = ref(false)
const form = reactive({ username: '', password: '' })
const apiBaseInput = ref('')

function loadLoginDraft () {
  try {
    const raw = localStorage.getItem(LOGIN_DRAFT_KEY)
    if (!raw) return
    const o = JSON.parse(raw)
    if (o && typeof o.username === 'string') form.username = o.username
    if (o && typeof o.password === 'string') form.password = o.password
  } catch {
    // ignore corrupt draft
  }
}

function saveLoginDraft () {
  try {
    localStorage.setItem(
      LOGIN_DRAFT_KEY,
      JSON.stringify({ username: form.username, password: form.password })
    )
  } catch {
    // quota / private mode
  }
}

onMounted(() => {
  // 仅回填用户曾在登录页或「API 连接」中保存过的地址，不展示构建默认或其它隐式来源
  apiBaseInput.value = getUserConfiguredApiBaseForForm()
  loadLoginDraft()
})

watch(
  () => [form.username, form.password],
  () => {
    saveLoginDraft()
  }
)

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
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  background: linear-gradient(
    165deg,
    #e0f2fe 0%,
    #bae6fd 38%,
    #7dd3fc 100%
  );
}

.login-stack {
  width: 100%;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
}

.login-brand {
  text-align: center;
}

.brand-logo {
  width: 52px;
  height: 52px;
  margin: 0 auto 14px;
  border-radius: 12px;
  background: linear-gradient(145deg, #0ea5e9, #0284c7);
  color: #fff;
  font-size: 26px;
  font-weight: 700;
  line-height: 52px;
  letter-spacing: -0.02em;
  box-shadow:
    0 8px 24px rgba(2, 132, 199, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.brand-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: #0c4a6e;
  letter-spacing: 0.02em;
}

.brand-sub {
  margin: 8px 0 0;
  font-size: 13px;
  color: #0369a1;
  opacity: 0.88;
  line-height: 1.5;
  max-width: 360px;
}

.login-card {
  width: 100%;
  background: #fff;
  border-radius: 16px;
  box-shadow:
    0 4px 24px rgba(14, 116, 144, 0.12),
    0 1px 3px rgba(15, 23, 42, 0.06);
  border: 1px solid rgba(186, 230, 253, 0.9);
  padding: 32px 28px 28px;
}

.card-block {
  margin: 0;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.login-btn {
  width: 100%;
  height: 44px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 10px;
  margin-top: 4px;
}

.card-divider {
  height: 1px;
  margin: 26px 0 22px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(148, 163, 184, 0.35) 12%,
    rgba(148, 163, 184, 0.35) 88%,
    transparent
  );
}

.api-block {
  padding-bottom: 2px;
}

.api-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.api-header-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 10px;
}

.api-title {
  font-size: 15px;
  font-weight: 600;
  color: #0f172a;
}

.api-badge {
  font-size: 12px;
  font-weight: 400;
  color: #94a3b8;
}

.api-chevron {
  font-size: 18px;
  color: #94a3b8;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.api-chevron.open {
  transform: rotate(180deg);
}

.api-body {
  margin-top: 14px;
}

.api-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.api-row :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.api-row :deep(.el-button) {
  flex-shrink: 0;
}

.api-tip {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: #94a3b8;
}

@media (max-width: 480px) {
  .login-card {
    padding: 24px 18px 20px;
  }

  .api-row {
    flex-direction: column;
  }

  .api-row :deep(.el-button) {
    width: 100%;
  }
}
</style>
