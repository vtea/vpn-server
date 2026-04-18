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
