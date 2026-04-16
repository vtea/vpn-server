<template>
  <router-view v-if="isFullPage" />

  <div v-else class="app-layout">
    <aside class="layout-sidebar" :class="{ 'is-collapsed': isCollapsed, 'is-mobile': isMobile }">
      <div class="sidebar-logo">
        <div class="logo-icon">V</div>
        <span class="logo-text">VPN 管理中心</span>
      </div>
      <div class="sidebar-menu">
        <el-menu
          :default-active="activeMenu"
          :collapse="isCollapsed"
          :collapse-transition="false"
          router
          background-color="transparent"
          text-color="rgba(255,255,255,0.65)"
          active-text-color="#ffffff"
        >
          <el-menu-item index="/">
            <el-icon><Odometer /></el-icon>
            <template #title>仪表盘</template>
          </el-menu-item>
          <el-menu-item index="/users" v-if="hasPerm('users')">
            <el-icon><User /></el-icon>
            <template #title>授权管理</template>
          </el-menu-item>
          <el-menu-item index="/network-segments" v-if="hasPerm('nodes')">
            <el-icon><Share /></el-icon>
            <template #title>组网网段</template>
          </el-menu-item>
          <el-menu-item index="/nodes" v-if="hasPerm('nodes')">
            <el-icon><Monitor /></el-icon>
            <template #title>节点管理</template>
          </el-menu-item>
          <el-menu-item index="/rules" v-if="hasPerm('rules')">
            <el-icon><Guide /></el-icon>
            <template #title>分流规则</template>
          </el-menu-item>
          <el-menu-item index="/tunnels" v-if="hasPerm('tunnels')">
            <el-icon><Connection /></el-icon>
            <template #title>隧道状态</template>
          </el-menu-item>
          <el-menu-item index="/audit" v-if="hasPerm('audit')">
            <el-icon><Document /></el-icon>
            <template #title>审计日志</template>
          </el-menu-item>
          <el-menu-item index="/admins" v-if="hasPerm('admins')">
            <el-icon><Setting /></el-icon>
            <template #title>管理员管理</template>
          </el-menu-item>
          <el-menu-item index="/settings/api">
            <el-icon><Link /></el-icon>
            <template #title>API 连接</template>
          </el-menu-item>
        </el-menu>
      </div>
    </aside>

    <div class="layout-main" :class="{ 'is-collapsed': isCollapsed }">
      <header class="layout-header">
        <div class="header-left">
          <span class="collapse-btn" @click="isCollapsed = !isCollapsed">
            <el-icon><Fold v-if="!isCollapsed" /><Expand v-else /></el-icon>
          </span>
          <el-breadcrumb v-if="!isMobile" separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="currentBreadcrumb">{{ currentBreadcrumb }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-dropdown trigger="click" @command="handleCommand">
            <span class="user-dropdown">
              <el-avatar :size="32" style="background: var(--color-primary)">
                <el-icon><UserFilled /></el-icon>
              </el-avatar>
              <span class="user-name">{{ adminInfo.username || '管理员' }}</span>
              <el-tag :type="roleTagType" size="small" style="margin-left:4px;">{{ roleLabel }}</el-tag>
              <el-icon class="dropdown-arrow"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="changePwd">
                  <el-icon><Lock /></el-icon>修改密码
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="layout-content">
        <router-view v-slot="{ Component }">
          <transition name="fade-transform" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
    <div
      v-if="isMobile && !isCollapsed"
      class="mobile-sidebar-mask"
      @click="isCollapsed = true"
    />
  </div>

  <el-dialog v-model="changePwdVisible" title="修改密码" width="400px" destroy-on-close>
    <el-form :model="pwdForm" label-width="80px">
      <el-form-item label="旧密码">
        <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入当前密码" />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少6位" />
      </el-form-item>
      <el-form-item label="确认密码">
        <el-input v-model="pwdForm.confirmPassword" type="password" show-password placeholder="再次输入新密码" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="changePwdVisible = false">取消</el-button>
      <el-button type="primary" :loading="changingPwd" @click="handleChangePwd">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import router from './router'
import http from './api/http'
import { parseJwtPayload } from './utils/jwt'
import {
  getAdminProfile,
  getSessionToken,
  setAdminProfile,
  clearAuthSession
} from './utils/adminSession'

const route = useRoute()
const isCollapsed = ref(false)
const isMobile = ref(false)

const syncCollapsedForViewport = () => {
  const mobile = window.innerWidth <= 768
  isMobile.value = mobile
  if (mobile) {
    isCollapsed.value = true
  }
}

const handleResize = () => {
  syncCollapsedForViewport()
}

const fullPages = ['/login', '/self-service']
const isFullPage = computed(() => fullPages.includes(route.path))

const menuMap = {
  '/': '仪表盘',
  '/settings/api': 'API 连接',
  '/network-segments': '组网网段',
  '/nodes': '节点管理',
  '/users': '授权管理',
  '/rules': '分流规则',
  '/tunnels': '隧道状态',
  '/audit': '审计日志',
  '/admins': '管理员管理',
}

const activeMenu = computed(() => {
  if (route.path.startsWith('/nodes/')) return '/nodes'
  if (route.path.startsWith('/settings')) return '/settings/api'
  if (route.path === '/network-segments') return '/network-segments'
  return route.path
})

const currentBreadcrumb = computed(() => {
  if (route.path.startsWith('/nodes/')) return '节点管理'
  if (route.path.startsWith('/settings')) return 'API 连接'
  return menuMap[route.path] || ''
})

const normalizeAdminInfo = (info) => {
  if (!info || typeof info !== 'object') return {}
  const roleRaw = typeof info.role === 'string' ? info.role.trim() : ''
  const role = roleRaw.toLowerCase()
  const username =
    typeof info.username === 'string'
      ? info.username.trim()
      : typeof info.sub === 'string'
        ? info.sub.trim()
        : ''
  const permsSource = info.perms ?? info.permissions ?? ''
  const perms = typeof permsSource === 'string' ? permsSource.trim() : ''
  return { username, role, perms }
}

const adminInfo = computed(() => {
  const profile = normalizeAdminInfo(getAdminProfile())
  if (profile.username || profile.role || profile.perms) return profile
  const token = getSessionToken()
  if (!token) return {}
  const payload = parseJwtPayload(token)
  if (!payload) return {}
  return normalizeAdminInfo(payload)
})

const roleLabel = computed(() => {
  const r = adminInfo.value.role
  if (r === 'admin') return '超级管理员'
  if (r === 'operator') return '运维管理员'
  if (r === 'viewer') return '只读查看'
  return r || '未知'
})

const roleTagType = computed(() => {
  const r = adminInfo.value.role
  if (r === 'admin') return 'danger'
  if (r === 'operator') return 'warning'
  return 'info'
})

const hasPerm = (module) => {
  const info = adminInfo.value
  if (info.role === 'admin') return true
  if (info.perms === '*') return true
  if (!info.perms) return false
  return info.perms.split(',').map(s => s.trim()).includes(module)
}

watch(
  () => route.path,
  () => {
    if (isMobile.value && !isCollapsed.value) {
      isCollapsed.value = true
    }
  }
)

onMounted(async () => {
  syncCollapsedForViewport()
  window.addEventListener('resize', handleResize)
  const token = getSessionToken()
  if (!token) return
  try {
    const res = await http.get('/api/me')
    setAdminProfile(res.data?.admin || null)
  } catch {
    // http.js handles error display
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
})

const changePwdVisible = ref(false)
const changingPwd = ref(false)
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

const handleChangePwd = async () => {
  if (!pwdForm.oldPassword) { ElMessage.warning('请输入旧密码'); return }
  if (pwdForm.newPassword.length < 6) { ElMessage.warning('新密码至少6位'); return }
  if (pwdForm.newPassword !== pwdForm.confirmPassword) { ElMessage.warning('两次输入的密码不一致'); return }
  changingPwd.value = true
  try {
    await http.post('/api/me/password', { old_password: pwdForm.oldPassword, new_password: pwdForm.newPassword })
    ElMessage.success('密码修改成功，请重新登录')
    changePwdVisible.value = false
    clearAuthSession()
    router.push('/login')
  } catch {
    // http.js handles error display
  } finally {
    changingPwd.value = false
  }
}

const handleCommand = (cmd) => {
  if (cmd === 'changePwd') {
    Object.assign(pwdForm, { oldPassword: '', newPassword: '', confirmPassword: '' })
    changePwdVisible.value = true
  } else if (cmd === 'logout') {
    clearAuthSession()
    router.push('/login')
  }
}
</script>

<style scoped>
.app-layout {
  height: 100vh;
  overflow: hidden;
}

.user-dropdown {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.user-dropdown:hover {
  background: var(--border-lighter);
}

.user-name {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.dropdown-arrow {
  font-size: 12px;
  color: var(--text-secondary);
}

.mobile-sidebar-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
}

@media (max-width: 768px) {
  .user-dropdown {
    gap: 4px;
    padding: 2px 4px;
  }
  .user-name,
  .dropdown-arrow {
    display: none;
  }
  .user-dropdown :deep(.el-tag) {
    display: none;
  }
}
</style>
