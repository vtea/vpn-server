import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '../router'
import {
  getApiBaseURL,
  setApiBaseURL,
  clearApiBaseURL,
  getBuildTimeApiBaseURL,
  getUserConfiguredApiBaseForForm
} from '../utils/apiBase'
import { clearAuthSession } from '../utils/adminSession'

export {
  getApiBaseURL,
  setApiBaseURL,
  clearApiBaseURL,
  getBuildTimeApiBaseURL,
  getUserConfiguredApiBaseForForm
}

/** 请求超时（毫秒）。不设超时则 API 挂起时页面 loading 永不结束 */
const REQUEST_TIMEOUT_MS = 45000

/**
 * 当前配置的 API 基址是否与页面不同源（跨域）。用于区分「服务不可达」与「CORS 未放行」。
 * @returns {boolean}
 */
function apiOriginDiffersFromPage() {
  if (typeof window === 'undefined') return false
  const base = getApiBaseURL()
  if (!base || base === '/') return false
  try {
    const apiOrigin = new URL(base, window.location.href).origin
    return apiOrigin !== window.location.origin
  } catch {
    return false
  }
}

/** 无鉴权请求（自助门户等），与 http 共用同一套 baseURL 解析 */
export const publicHttp = axios.create({ timeout: REQUEST_TIMEOUT_MS })
publicHttp.interceptors.request.use(cfg => {
  cfg.baseURL = getApiBaseURL()
  return cfg
})
publicHttp.interceptors.response.use(
  res => res,
  err => {
    const isTimeout =
      err.code === 'ECONNABORTED' ||
      (typeof err.message === 'string' && err.message.includes('timeout'))
    if (isTimeout) {
      ElMessage.error(
        '请求超时：请确认 vpn-api 已启动，且 API 地址配置正确'
      )
    }
    return Promise.reject(err)
  }
)

const http = axios.create({ baseURL: '', timeout: REQUEST_TIMEOUT_MS })

http.interceptors.request.use(cfg => {
  cfg.baseURL = getApiBaseURL()
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

http.interceptors.response.use(
  res => res,
  err => {
    /** 由调用方自行展示结果（如 ElNotification），避免与全局 ElMessage 重复或漏提示 */
    const silentGlobalError = Boolean(err.config?.meta?.silentGlobalError)

    const isTimeout =
      err.code === 'ECONNABORTED' ||
      (typeof err.message === 'string' && err.message.includes('timeout'))
    if (isTimeout) {
      if (!silentGlobalError) {
        ElMessage.error(
          '请求超时：请确认 vpn-api 已启动（默认 56700），且「API 连接」未指向错误地址；开发环境勿将 API 填成页面端口 56701'
        )
      }
      return Promise.reject(err)
    }

    const status = err.response?.status
    const msg = err.response?.data?.error

    // 401 仍须清会话/跳转，不受 silent 影响
    if (status === 401) {
      const onLogin = router.currentRoute.value?.path === '/login'
      if (onLogin) {
        ElMessage.error(msg || '用户名或密码错误')
      } else {
        clearAuthSession()
        router.push('/login')
        ElMessage.error(msg || '登录已过期，请重新登录')
      }
      return Promise.reject(err)
    }

    if (silentGlobalError) {
      return Promise.reject(err)
    }

    const suppress404 = Boolean(err.config?.meta?.suppress404)

    if (!err.response) {
      ElMessage.error(
        apiOriginDiffersFromPage()
          ? `无法访问 API（跨域被浏览器拦截）：请在 vpn-api 设置 CORS_ALLOWED_ORIGINS 或 WEB_APP_ORIGINS 为当前管理台源 ${window.location.origin}，重启 API 后重试（详见 vpn-api README「前后端分离 / 跨域」）`
          : '无法连接 API：请确认 vpn-api 已启动，且端口与前端配置一致（开发环境默认反代到 127.0.0.1:56700）'
      )
    } else if (status === 403) {
      const suppress403 = Boolean(err.config?.meta?.suppress403)
      if (!suppress403) {
        const d = err.response?.data
        const detail =
          d && typeof d === 'object' && typeof d.detail === 'string'
            ? d.detail
            : ''
        ElMessage.error(
          detail ? `${msg || '没有操作权限'}：${detail}` : (msg || '没有操作权限')
        )
      }
    } else if (status === 404) {
      if (suppress404) return Promise.reject(err)
      ElMessage.error(
        msg ||
          '接口不存在 (404)。若管理台在 56701：请确认 vpn-api 已启动于 56700，且 API 地址勿填成页面地址；可到「API 连接」清空或设为 http://127.0.0.1:56700'
      )
    } else if (status === 400) {
      ElMessage.error(
        msg || '请求参数不正确（请检查必填项是否与后端要求一致）'
      )
    } else if (status >= 500) {
      const raw = err.response?.data
      const detail =
        typeof raw === 'string'
          ? raw
          : raw?.error ||
            (raw && typeof raw === 'object' ? JSON.stringify(raw) : '')
      if (import.meta.env.DEV) {
        console.error('[vpn-api]', status, err.config?.url, raw)
      }
      ElMessage.error(
        detail ||
          msg ||
          '服务器错误（若刚升级端口：请确认后端监听 56700，且未将 VITE_API_BASE_URL 指向旧地址）'
      )
    } else if (status >= 400 && status < 500) {
      // 覆盖 412/428 等未单独分支的 4xx，避免仅有 reject、界面无任何提示
      ElMessage.error(msg || `请求失败（HTTP ${status}）`)
    } else if (msg) {
      ElMessage.error(msg)
    }

    return Promise.reject(err)
  }
)

export default http
