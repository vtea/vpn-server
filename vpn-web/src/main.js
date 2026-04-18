import { ViteSSG } from 'vite-ssg'
import { createPinia } from 'pinia'
import { ID_INJECTION_KEY } from 'element-plus/es/hooks/use-id/index.mjs'
import { ZINDEX_INJECTION_KEY } from 'element-plus/es/hooks/use-z-index/index.mjs'
import './assets/styles/global.scss'
import App from './App.vue'
import { routes } from './router/routes'
import { bindRouter, installNavigationGuards } from './router'
import { repairStoredApiBaseIfNeeded } from './utils/apiBase'

repairStoredApiBaseIfNeeded()

/**
 * vite-ssg 入口：构建期为每条静态路由生成独立 HTML，便于纯静态托管下无「整站伪静态」也能刷新深链。
 * 动态路由（如 /nodes/:id）不包含在生成列表中，刷新该路径仍可能 404，需从站内进入。
 */
export const createApp = ViteSSG(
  App,
  { routes, base: import.meta.env.BASE_URL },
  ({ app, router }) => {
    bindRouter(router)
    installNavigationGuards(router)

    /** Element Plus 在 SSG/SSR 下需要注入，避免 useId / z-index 告警并保证水合一致 */
    app.provide(ID_INJECTION_KEY, {
      prefix: Math.floor(Math.random() * 10000),
      current: 0
    })
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 })

    /** 图标在各视图按需 `@element-plus/icons-vue` 引入，避免全量注册拖慢首屏 */

    app.use(createPinia())
  }
)

/**
 * 构建期只预渲染无动态参数的路径，避免 /nodes/:id 等无法枚举的段。
 * @param {string[]} paths - vite-ssg 解析出的路径列表
 * @returns {Promise<string[]>}
 */
export async function includedRoutes (paths) {
  return paths.filter((p) => !p.includes(':'))
}
