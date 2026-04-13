import { ElMessage } from 'element-plus'

export function formatDate(val) {
  if (!val) return '-'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatRelativeTime(val) {
  if (!val) return '-'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return formatDate(val)
}

const nodeStatusMap = {
  online: { label: '在线', type: 'success' },
  offline: { label: '离线', type: 'danger' },
}

const userStatusMap = {
  active: { label: '正常', type: 'success' },
  disabled: { label: '禁用', type: 'info' },
}

const certStatusMap = {
  pending: { label: '待签发', type: 'warning' },
  active: { label: '可用', type: 'success' },
  placeholder: { label: '节点离线（可重试签发）', type: 'warning' },
  revoked: { label: '已吊销', type: 'danger' },
  revoking: { label: '吊销中', type: 'warning' },
  failed: { label: '签发失败', type: 'danger' },
}

const tunnelStatusMap = {
  ok: { label: '正常', type: 'success' },
  down: { label: '中断', type: 'danger' },
  pending: { label: '等待', type: 'warning' },
}

export function getStatusInfo(category, status) {
  const maps = { node: nodeStatusMap, user: userStatusMap, cert: certStatusMap, tunnel: tunnelStatusMap }
  return maps[category]?.[status] || { label: status || '-', type: 'info' }
}

export async function confirmAction(message, action) {
  try {
    await action()
    ElMessage.success(message)
    return true
  } catch {
    return false
  }
}

export function downloadBlob(content, filename, type = 'text/csv') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
