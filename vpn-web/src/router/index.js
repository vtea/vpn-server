import { ElMessage } from 'element-plus'
import {
  isSuperAdminSession,
  hasModulePermission
} from '../utils/adminSession'
import { routes } from './routes'

export { routes }

/** @type {import('vue-router').Router | null} */
let _router = null

/**
 * 由 main.js 中 ViteSSG 创建 router 后立即绑定，供 http 拦截器与视图在非 setup 上下文中使用。
 * @param {import('vue-router').Router} r - Vue Router 实例
 */
export function bindRouter (r) {
  _router = r
}

/**
 * 注册全局前置守卫（鉴权、超管页）。
 * SSG 预渲染阶段无 localStorage/token，必须放行，否则所有页面都会生成登录页 HTML。
 * @param {import('vue-router').Router} router - Vue Router 实例
 */
export function installNavigationGuards (router) {
  router.beforeEach((to) => {
    if (import.meta.env.SSR) return true
    if (to.path === '/login' || to.meta?.noAuth) return true
    const token = localStorage.getItem('token')
    if (!token) return '/login'
    if (to.meta?.requiresSuperAdmin && !isSuperAdminSession()) {
      ElMessage.warning(
        to.path.startsWith('/settings')
          ? '仅超级管理员可访问 API 连接'
          : '仅超级管理员可访问该页面'
      )
      return { path: '/', replace: true }
    }
    /** 功能模块页：无对应权限则不调起页面（避免 onMounted 里打 403） */
    const reqMod = to.meta?.requiresModule
    if (reqMod) {
      const mods = Array.isArray(reqMod) ? reqMod : [reqMod]
      const ok = mods.some(
        (m) => typeof m === 'string' && hasModulePermission(m.trim())
      )
      if (!ok) {
        ElMessage.warning('当前账号无权访问该页面')
        return { path: '/', replace: true }
      }
    }
    return true
  })
}

/**
 * 默认导出为 Proxy，在 bindRouter 之前访问会返回 undefined（勿在模块顶层同步使用 router）。
 */
const routerProxy = new Proxy(
  /** @type {import('vue-router').Router} */ ({}),
  {
    get (_, prop) {
      if (!_router) {
        if (import.meta.env.DEV) {
          console.warn(`[router] 在 bindRouter 之前访问: ${String(prop)}`)
        }
        return undefined
      }
      const v = _router[/** @type {keyof import('vue-router').Router} */ (prop)]
      return typeof v === 'function' ? v.bind(_router) : v
    }
  }
)

export default routerProxy
