import { ref } from 'vue'

const TOKEN_KEY = 'token'
const ADMIN_PROFILE_KEY = 'admin_profile'

function readProfileFromStorage() {
  const raw = localStorage.getItem(ADMIN_PROFILE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const tokenRef = ref(localStorage.getItem(TOKEN_KEY) || '')
const adminProfileRef = ref(readProfileFromStorage())

export function getSessionToken() {
  return tokenRef.value
}

export function getAdminProfile() {
  return adminProfileRef.value
}

export function setSessionToken(token) {
  const safeToken = typeof token === 'string' ? token : ''
  if (safeToken) localStorage.setItem(TOKEN_KEY, safeToken)
  else localStorage.removeItem(TOKEN_KEY)
  tokenRef.value = safeToken
}

export function setAdminProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    localStorage.removeItem(ADMIN_PROFILE_KEY)
    adminProfileRef.value = null
    return
  }
  localStorage.setItem(ADMIN_PROFILE_KEY, JSON.stringify(profile))
  adminProfileRef.value = profile
}

export function setAuthSession({ token, admin }) {
  setSessionToken(token)
  setAdminProfile(admin || null)
}

export function clearAuthSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(ADMIN_PROFILE_KEY)
  tokenRef.value = ''
  adminProfileRef.value = null
}
