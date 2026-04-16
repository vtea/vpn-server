<template>
  <div class="portal-page">
    <div class="portal-shell">
      <header class="portal-brand">
        <div class="portal-brand__logo">V</div>
        <div class="portal-brand__text">
          <h1 class="portal-brand__title">员工自助门户</h1>
          <p class="portal-brand__desc">使用用户名查询并下载个人 VPN 配置（与管理中心同一套视觉规范）</p>
        </div>
      </header>

      <div v-if="!loggedIn" class="record-card portal-card">
        <h2 class="portal-card__title">查找我的配置</h2>
        <p class="portal-card__subtitle">输入你在系统中登记的用户名</p>
        <el-form class="portal-form" @submit.prevent="doLogin">
          <el-form-item label="用户名">
            <el-input v-model="username" placeholder="输入你的用户名" clearable />
          </el-form-item>
          <el-button type="primary" class="portal-submit" :loading="loading" @click="doLogin">
            查看我的配置
          </el-button>
        </el-form>
      </div>

      <template v-else>
        <div class="record-card portal-card portal-card--header">
          <el-page-header class="portal-page-header" @back="loggedIn = false">
            <template #content>
              <span class="portal-page-header__title">我的 VPN 配置</span>
              <el-tag type="info" size="small" effect="plain" class="portal-page-header__user">{{ username }}</el-tag>
            </template>
          </el-page-header>
        </div>

        <el-alert
          v-if="!grants.length"
          type="info"
          title="暂无可用配置"
          description="管理员尚未为你分配 VPN 访问权限，请联系 IT 部门。"
          :closable="false"
          class="portal-alert"
        />

        <div v-else class="record-grid record-grid--single portal-grants">
          <div
            v-for="g in grants"
            :key="g.id"
            class="record-card grant-card"
            :class="recordCardToneClass('cert', g.cert_status)"
          >
            <div class="record-card__head grant-card__head">
              <div class="min-w-0">
                <div class="record-card__title mono-text">{{ g.cert_cn }}</div>
                <div class="record-card__meta grant-card__hint">与节点实例协议一致的配置文件</div>
              </div>
              <el-tag
                :type="g.cert_status === 'active' ? 'success' : g.cert_status === 'placeholder' ? 'warning' : 'danger'"
                size="small"
              >
                {{ g.cert_status === 'active' ? '可用' : g.cert_status === 'placeholder' ? '待签发' : '已吊销' }}
              </el-tag>
            </div>
            <div class="record-card__actions grant-card__actions">
              <el-button
                type="primary"
                :disabled="!['active', 'placeholder'].includes(g.cert_status)"
                @click="download(g.id)"
              >
                下载配置
              </el-button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { publicHttp, getApiBaseURL } from '../api/http'
import { recordCardToneClass } from '../utils'

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

<style scoped>
.portal-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--spacing-lg) var(--spacing-md);
  padding-top: max(var(--spacing-lg), env(safe-area-inset-top, 0px));
  padding-bottom: max(var(--spacing-lg), env(safe-area-inset-bottom, 0px));
  background: transparent;
  box-sizing: border-box;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.portal-shell {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.portal-brand {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: 0 var(--spacing-xs);
}

.portal-brand__logo {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-primary), #1890ff);
  color: #fff;
  font-size: 22px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-sm);
}

.portal-brand__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.portal-brand__desc {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.portal-card {
  padding: var(--spacing-xl) var(--spacing-lg);
  box-shadow: var(--shadow-md);
}

.portal-card--header {
  padding: var(--spacing-md) var(--spacing-lg);
}

.portal-card__title {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.portal-card__subtitle {
  margin: 0 0 var(--spacing-lg);
  font-size: 14px;
  color: var(--text-secondary);
}

.portal-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.portal-submit {
  width: 100%;
  height: 44px;
  border-radius: var(--radius-md);
}

.portal-page-header {
  margin: 0;
}

.portal-page-header :deep(.el-page-header__content) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.portal-page-header__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.portal-alert {
  border-radius: var(--radius-md);
}

.portal-grants {
  gap: var(--spacing-sm);
}

.grant-card__head {
  align-items: flex-start !important;
}

.grant-card__hint {
  margin-top: 4px;
}

.grant-card__actions {
  margin-top: var(--spacing-sm);
  padding-top: var(--spacing-sm);
}

@media (max-width: 480px) {
  .portal-card {
    padding: var(--spacing-lg) var(--spacing-md);
  }
}
</style>
