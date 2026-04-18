/** localStorage 中保存用户选择的 API 根地址；未设置时使用构建时 VITE_API_BASE_URL */
export const API_BASE_STORAGE_KEY = 'vpn_admin_api_base_url'

/**
 * 用户曾在登录页或「API 连接」中点击过保存时置为 `1`。
 * 用于登录页输入框：不展示「仅由构建注入、从未经用户保存」的隐式地址。
 */
export const API_BASE_USER_EXPLICIT_KEY = 'vpn_admin_api_base_user_explicit'

/**
 * 规范化用户输入的 API 根地址：去空白、去尾部斜杠、剥离误填的 `/api`（避免请求变成 `/api/api/...`）。
 * @param {string} s - 原始输入
 * @returns {string} 无尾部斜杠的 origin 或空串
 */
export function normalizeApiBase (s) {
  if (typeof s !== 'string') return ''
  let t = s.trim()
  if (t === '') return ''
  // 前端请求路径均为 /api/...；误填 .../api、.../api/、.../api/api 时会拼成 /api/api/... → 404
  for (let i = 0; i < 8; i++) {
    const before = t
    while (t.endsWith('/')) t = t.slice(0, -1)
    if (t.endsWith('/api')) t = t.slice(0, -4)
    if (t === before) break
  }
  return t
}

function isLoopbackHostname (h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** 开发环境：localhost / 127.0.0.1 / ::1 同端口视为同一「页面地址」，避免误用绝对 URL 绕开 Vite 代理 */
function devLoopbackSamePage (base, origin) {
  try {
    const b = new URL(base)
    const o = new URL(origin)
    if (!isLoopbackHostname(b.hostname) || !isLoopbackHostname(o.hostname)) return false
    return b.port === o.port && b.protocol === o.protocol
  } catch (_) {
    return false
  }
}

/**
 * 本地 Vite dev / vite preview（默认 56701，或 package 中 56702）：页面与 API 均为回环但 origin 不同时，
 * 直连 vpn-api 会触发 CORS；未配置 CORS_ALLOWED_ORIGINS 时预检失败。改用当前页相对路径 /api 走 Vite 代理。
 */
function viteLocalShell () {
  if (import.meta.env.DEV) return true
  if (typeof window === 'undefined') return false
  try {
    const p = window.location
    if (!isLoopbackHostname(p.hostname)) return false
    const port = p.port || (p.protocol === 'https:' ? '443' : '80')
    return port === '56701' || port === '56702'
  } catch (_) {
    return false
  }
}

/**
 * 页面与 API 均为本机回环但 origin 不同（如 localhost:56701 与 127.0.0.1:56700）时走相对路径，避免跨域。
 */
function preferRelativeToAvoidLoopbackCors (base) {
  if (!base || typeof window === 'undefined') return false
  try {
    const b = new URL(base)
    const p = window.location
    if (!isLoopbackHostname(b.hostname) || !isLoopbackHostname(p.hostname)) return false
    return b.origin !== p.origin
  } catch (_) {
    return false
  }
}

/**
 * 实际请求使用的 API 根地址（无尾部斜杠）。
 * 优先级：localStorage 覆盖 > VITE_API_BASE_URL > 空（同域相对路径 /api/...）
 */
export function getApiBaseURL () {
  let base = ''
  const stored =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(API_BASE_STORAGE_KEY)
      : null
  if (stored !== null) {
    base = normalizeApiBase(stored)
  } else {
    base = normalizeApiBase(import.meta.env.VITE_API_BASE_URL || '')
  }

  // 本地 Vite：若把「管理台页面地址」误存为 API 根，或 localhost 与 127.0.0.1 混用导致跨域，一律用相对路径走代理
  if (viteLocalShell() && typeof window !== 'undefined' && base !== '') {
    try {
      const origin = window.location.origin
      if (
        preferRelativeToAvoidLoopbackCors(base) ||
        base === origin ||
        devLoopbackSamePage(base, origin)
      ) {
        return ''
      }
    } catch (_) {
      /* ignore */
    }
  }

  return base
}

/**
 * 启动时调用：若历史保存值含错误后缀（如 .../api），写回规范化后的值，避免长期 404。
 */
export function repairStoredApiBaseIfNeeded () {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(API_BASE_STORAGE_KEY)
    if (raw === null) return
    const fixed = normalizeApiBase(raw)
    if (fixed !== raw) {
      localStorage.setItem(API_BASE_STORAGE_KEY, fixed)
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * 保存用户输入的 API 根地址；传空字符串表示「强制同域」；需恢复构建默认请用 clearApiBaseURL。
 * 会标记为「用户显式配置」，登录页才会在折叠区中回填。
 * @param {string} url - 原始输入
 */
export function setApiBaseURL (url) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(API_BASE_STORAGE_KEY, normalizeApiBase(url))
  try {
    localStorage.setItem(API_BASE_USER_EXPLICIT_KEY, '1')
  } catch (_) {
    /* ignore */
  }
}

/** 删除覆盖项，重新使用 VITE_API_BASE_URL 或同域 */
export function clearApiBaseURL () {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(API_BASE_STORAGE_KEY)
  try {
    localStorage.removeItem(API_BASE_USER_EXPLICIT_KEY)
  } catch (_) {
    /* ignore */
  }
}

/**
 * 供登录页「API 根地址」输入框使用：仅当用户曾显式保存过时返回已保存值，否则返回空串（不展示构建默认或历史隐式值）。
 * @returns {string}
 */
export function getUserConfiguredApiBaseForForm () {
  if (typeof localStorage === 'undefined') return ''
  try {
    if (localStorage.getItem(API_BASE_USER_EXPLICIT_KEY) !== '1') return ''
    const raw = localStorage.getItem(API_BASE_STORAGE_KEY)
    if (raw === null) return ''
    return normalizeApiBase(raw)
  } catch (_) {
    return ''
  }
}

/** 构建时默认（不受 localStorage 影响），用于设置页展示说明 */
export function getBuildTimeApiBaseURL () {
  return normalizeApiBase(import.meta.env.VITE_API_BASE_URL || '')
}
