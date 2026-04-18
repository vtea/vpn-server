import { ref } from 'vue'
import { parseJwtPayload } from './jwt'

const TOKEN_KEY = 'token'
const ADMIN_PROFILE_KEY = 'admin_profile'

function readProfileFromStorage() {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(ADMIN_PROFILE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const tokenRef = ref(
  typeof localStorage !== 'undefined' ? (localStorage.getItem(TOKEN_KEY) || '') : ''
)
const adminProfileRef = ref(
  typeof localStorage !== 'undefined' ? readProfileFromStorage() : null
)

export function getSessionToken() {
  return tokenRef.value
}

export function getAdminProfile() {
  return adminProfileRef.value
}

export function setSessionToken(token) {
  const safeToken = typeof token === 'string' ? token : ''
  if (typeof localStorage !== 'undefined') {
    if (safeToken) localStorage.setItem(TOKEN_KEY, safeToken)
    else localStorage.removeItem(TOKEN_KEY)
  }
  tokenRef.value = safeToken
}

export function setAdminProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(ADMIN_PROFILE_KEY)
    }
    adminProfileRef.value = null
    return
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(ADMIN_PROFILE_KEY, JSON.stringify(profile))
  }
  adminProfileRef.value = profile
}

export function setAuthSession({ token, admin }) {
  setSessionToken(token)
  setAdminProfile(admin || null)
}

export function clearAuthSession() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(ADMIN_PROFILE_KEY)
  }
  tokenRef.value = ''
  adminProfileRef.value = null
}

/**
 * 从 `/me` 或 JWT payload 对象解析 role / perms（与 App.vue 中 normalize 逻辑一致）。
 * @param {Record<string, unknown> | null | undefined} info
 * @returns {{ role: string, perms: string }}
 */
function normalizeRolePerms(info) {
  if (!info || typeof info !== 'object') return { role: '', perms: '' }
  const roleRaw = typeof info.role === 'string' ? info.role.trim() : ''
  const role = roleRaw.toLowerCase()
  const permsSource = 'perms' in info ? info.perms : info.permissions
  const perms = typeof permsSource === 'string' ? permsSource.trim() : ''
  return { role, perms }
}

/**
 * 当前会话是否为超级管理员（role=admin 或 permissions=*），供路由守卫与侧栏使用。
 * **优先使用 JWT payload**（登录时由后端签发，与当时库中账号一致），再回退到本地缓存的 `/me` 资料。
 * 避免仅因 localStorage 中过期的 `admin_profile` 误判为超管，导致界面显示「超级管理员」但接口 403。
 * @returns {boolean}
 */
export function isSuperAdminSession() {
  const token = getSessionToken()
  const fromJwt = token ? parseJwtPayload(token) : null
  let info = null
  if (
    fromJwt &&
    typeof fromJwt === 'object' &&
    (fromJwt.role || fromJwt.permissions || fromJwt.perms)
  ) {
    info = fromJwt
  }
  if (!info) {
    const p = getAdminProfile()
    if (p && typeof p === 'object') info = p
  }
  if (!info) return false
  const { role, perms } = normalizeRolePerms(info)
  return role === 'admin' || perms === '*'
}

/**
 * 当前登录管理员用户名（优先本地 `/me` 缓存，其次 JWT `sub`），用于非超管自助创建同名 VPN 用户。
 * @returns {string}
 */
export function getSessionAdminUsername() {
  const token = getSessionToken()
  const fromJwt = token ? parseJwtPayload(token) : null
  const sub =
    fromJwt && typeof fromJwt.sub === 'string' ? fromJwt.sub.trim() : ''
  const p = getAdminProfile()
  const fromProfile =
    p && typeof p.username === 'string' ? p.username.trim() : ''
  return fromProfile || sub || ''
}

/**
 * 与 vpn-api middleware.permissionTokens 一致：逗号/分号/中文逗号/空格分隔的权限串。
 * @param {string} perms
 * @returns {string[]}
 */
function permissionTokensFromString(perms) {
  const s = typeof perms === 'string' ? perms.trim() : ''
  if (!s) return []
  if (/[,;，]/.test(s)) {
    return s
      .split(/[,;，]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return s.split(/\s+/).filter(Boolean)
}

/**
 * 会话是否对某功能模块有权（与 `/me` 及 JWT 的 `permissions` / `perms` 一致；超管视为全模块）。
 * @param {string} module
 * @returns {boolean}
 */
export function hasModulePermission(module) {
  const mod = typeof module === 'string' ? module.trim() : ''
  if (!mod) return false
  const token = getSessionToken()
  const fromJwt = token ? parseJwtPayload(token) : null
  let info = null
  if (
    fromJwt &&
    typeof fromJwt === 'object' &&
    (fromJwt.role || fromJwt.permissions || fromJwt.perms)
  ) {
    info = fromJwt
  }
  if (!info) {
    const p = getAdminProfile()
    if (p && typeof p === 'object') info = p
  }
  if (!info) return false
  const { role, perms } = normalizeRolePerms(info)
  if (role === 'admin' || perms === '*') return true
  if (!perms) return false
  return permissionTokensFromString(perms).includes(mod)
}

/**
 * 是否具备任一模块权限（与 `/me`、JWT 一致；超管视为全部具备）。
 * @param {string[]} modules
 * @returns {boolean}
 */
export function hasAnyModulePermission(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return false
  return modules.some((m) =>
    hasModulePermission(typeof m === 'string' ? m.trim() : '')
  )
}
