<template>
  <router-view v-if="isFullPage" />

  <div v-else class="app-layout">
    <aside
      class="layout-sidebar"
      :class="{ 'is-collapsed': isCollapsed, 'is-mobile': isMobile }"
      aria-label="主导航"
    >
      <div class="sidebar-logo" @click="onLogoClick">
        <div class="logo-icon" aria-hidden="true">V</div>
        <span class="logo-text">VPN 管理中心</span>
      </div>
      <div class="sidebar-menu">
        <el-menu
          :default-active="activeMenu"
          :collapse="isCollapsed"
          :collapse-transition="false"
          router
          class="app-sidebar-menu"
          background-color="transparent"
          text-color="rgba(224,242,254,0.82)"
          active-text-color="#f8fafc"
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
          <el-menu-item index="/admins" v-if="hasPerm('admins') && isSuperAdmin">
            <el-icon><Setting /></el-icon>
            <template #title>管理员管理</template>
          </el-menu-item>
          <el-menu-item index="/settings/api" v-if="isSuperAdmin">
            <el-icon><Link /></el-icon>
            <template #title>API 连接</template>
          </el-menu-item>
        </el-menu>
      </div>
    </aside>

    <div class="layout-main" :class="{ 'is-collapsed': isCollapsed }">
      <header class="layout-header">
        <div class="header-left">
          <button
            type="button"
            class="collapse-btn"
            :aria-expanded="String(!isCollapsed)"
            :aria-label="isCollapsed ? '展开侧栏' : '收起侧栏'"
            @click="toggleSidebar"
          >
            <el-icon><Fold v-if="!isCollapsed" /><Expand v-else /></el-icon>
          </button>
          <span v-if="isMobile" class="header-route-title">{{ currentBreadcrumb || 'VPN 管理中心' }}</span>
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
          <transition name="page-fade" mode="default">
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
  clearAuthSession,
  isSuperAdminSession,
  hasModulePermission
} from './utils/adminSession'
import {
  Odometer,
  User,
  Share,
  Monitor,
  Guide,
  Connection,
  Document,
  Setting,
  Link,
  Fold,
  Expand,
  UserFilled,
  ArrowDown,
  Lock,
  SwitchButton
} from '@element-plus/icons-vue'

const route = useRoute()
const isCollapsed = ref(false)
const isMobile = ref(false)

/** 去掉尾部斜杠，避免 /login 与 /login/ 在全屏页、菜单高亮上不一致（History 模式 + 子路径部署时更稳） */
const normalizedPath = computed(() => {
  const p = route.path
  if (p.length > 1 && p.endsWith('/')) return p.replace(/\/+$/, '')
  return p
})

const syncCollapsedForViewport = () => {
  const mobile = window.innerWidth <= 768
  isMobile.value = mobile
  if (mobile) {
    isCollapsed.value = true
  }
}

/** 节流 resize，避免拖拽窗口时频繁触发布局与重绘 */
let resizeRaf = 0
const handleResize = () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    syncCollapsedForViewport()
  })
}

const fullPages = ['/login', '/self-service']
const isFullPage = computed(() => fullPages.includes(normalizedPath.value))

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
  const p = normalizedPath.value
  if (p.startsWith('/nodes/')) return '/nodes'
  if (p.startsWith('/settings')) return '/settings/api'
  if (p === '/network-segments') return '/network-segments'
  return p
})

const currentBreadcrumb = computed(() => {
  const p = normalizedPath.value
  if (p.startsWith('/nodes/')) return '节点管理'
  if (p.startsWith('/settings')) return 'API 连接'
  return menuMap[p] || ''
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
  const nodeScope = typeof info.node_scope === 'string' ? info.node_scope.trim() : ''
  const nodeIds = Array.isArray(info.node_ids) ? info.node_ids.filter((x) => typeof x === 'string') : []
  return { username, role, perms, node_scope: nodeScope, node_ids: nodeIds }
}

/**
 * 与 isSuperAdminSession 一致：JWT 中的 role/perms 覆盖本地缓存，避免顶栏误判「超级管理员」。
 * 合并 profile 是为保留 JWT 不含的 node_scope / node_ids（来自登录或 /api/me）。
 */
const adminInfo = computed(() => {
  const profile = normalizeAdminInfo(getAdminProfile())
  const token = getSessionToken()
  const payload = token ? parseJwtPayload(token) : null
  const fromJwt =
    payload &&
    typeof payload === 'object' &&
    (payload.role || payload.permissions || payload.perms)
      ? normalizeAdminInfo(payload)
      : null
  if (!fromJwt && !(profile.username || profile.role || profile.perms)) {
    return {}
  }
  return {
    ...profile,
    ...(fromJwt || {})
  }
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

const hasPerm = (module) => hasModulePermission(module)

/** 侧栏「API 连接」仅超级管理员可见（与后端 AdminIsUnrestricted 一致） */
const isSuperAdmin = computed(() => isSuperAdminSession())

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value
}

const onLogoClick = () => {
  if (isMobile.value) {
    isCollapsed.value = true
    if (route.path !== '/') router.push('/')
    return
  }
  router.push('/')
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
    // 刷新时拉取资料：401（账号已删）由 http 拦截器清会话；404 为兼容旧后端仍本地处理
    const res = await http.get('/api/me', { meta: { suppress404: true } })
    setAdminProfile(res.data?.admin || null)
  } catch (err) {
    const st = err.response?.status
    if (st === 404) {
      clearAuthSession()
      if (router.currentRoute.value.path !== '/login') {
        router.push('/login')
        ElMessage.warning('登录状态无效（账号不存在或已变更），请重新登录')
      }
    }
    // 401 由 http.js 统一提示并回登录页
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
  height: 100dvh;
  overflow: hidden;
}

@media (max-width: 768px) {
  .app-layout {
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: visible;
  }
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
  background: rgba(14, 165, 233, 0.08);
}

.user-name {
  font-size: var(--font-sm);
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
  background: rgba(15, 40, 70, 0.42);
  z-index: 99;
  animation: sidebar-mask-in 0.36s cubic-bezier(0.16, 1, 0.3, 1);
  backdrop-filter: blur(2px);
}

@keyframes sidebar-mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  min-width: 42px;
  min-height: 42px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-regular);
  font-size: 20px;
  cursor: pointer;
  transition:
    color var(--transition-normal),
    background var(--transition-normal),
    transform var(--transition-fast);
}

.collapse-btn:hover {
  color: var(--color-primary);
  background: rgba(14, 165, 233, 0.09);
}

.collapse-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.header-route-title {
  font-size: var(--font-title);
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
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

/* 主内容路由切换：短淡出，避免 out-in 串行与位移动画带来的卡顿感 */
.layout-content :deep(.page-fade-enter-active),
.layout-content :deep(.page-fade-leave-active) {
  transition: opacity 0.14s ease;
}
.layout-content :deep(.page-fade-enter-from),
.layout-content :deep(.page-fade-leave-to) {
  opacity: 0;
}
</style>
