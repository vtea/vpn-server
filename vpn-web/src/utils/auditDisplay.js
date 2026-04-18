/**
 * 审计日志 action / target / detail 的界面展示用中文（与 vpn-api 写入的英文 key 对应）。
 * 数据库仍存英文；仅前端展示与导出 CSV 做映射/替换。
 */

/** @type {Record<string, string>} */
const ACTION_ZH = {
  change_password: '修改密码',
  create_node: '创建节点',
  patch_node: '修改节点',
  delete_node: '删除节点',
  rotate_bootstrap_token: '轮换部署令牌',
  patch_tunnel: '修改隧道',
  create_user: '创建用户',
  update_user: '更新用户',
  delete_user: '删除用户',
  repair_tunnel_mesh: '修复隧道组网',
  trigger_iplist_update: '触发 IP 列表更新',
  grant_reissue: '重新签发授权',
  grant_access: '新增授权',
  revoke_grant: '吊销授权',
  purge_grant: '删除授权记录',
  retry_issue_cert: '重试证书签发',
  create_instance: '创建接入实例',
  patch_instance: '修改接入实例',
  wg_refresh: '刷新 WireGuard',
  wg_refresh_auto: '自动刷新 WireGuard',
  wg_refresh_result: 'WireGuard 刷新结果',
  sync_agent_config: '同步 Agent 配置',
  create_exception: '创建分流例外',
  delete_exception: '删除分流例外',
  rollback_config: '回滚节点配置',
  create_admin: '创建管理员',
  update_admin: '更新管理员',
  reset_admin_password: '重置管理员密码',
  delete_admin: '删除管理员',
  create_network_segment: '创建组网网段',
  patch_network_segment: '修改组网网段',
  delete_network_segment: '删除组网网段',
  create_agent_upgrade: '创建 Agent 升级任务',
  seed_admin: '初始化默认管理员',
}

/**
 * 操作类型英文 key → 中文说明（未知 key 原样返回）。
 * @param {string | null | undefined} action
 * @returns {string}
 */
export function auditActionLabelZh(action) {
  const k = typeof action === 'string' ? action.trim() : ''
  if (!k) return '—'
  return ACTION_ZH[k] || k
}

/**
 * 目标字段常见前缀英 → 中（其余原样返回）。
 * @param {string | null | undefined} target
 * @returns {string}
 */
export function auditTargetDisplayZh(target) {
  if (target == null || target === '') return '—'
  const t = String(target).trim()
  const prefixMap = [
    ['user:', '用户：'],
    ['node:', '节点：'],
    ['admin:', '管理员：'],
    ['grant:', '授权记录：'],
    ['tunnel:', '隧道：'],
    ['instance:', '实例：'],
    ['segment:', '网段：'],
    ['exception:', '例外：'],
    ['task:', '任务：'],
  ]
  for (const [en, zh] of prefixMap) {
    if (t.startsWith(en)) return zh + t.slice(en.length)
  }
  if (t === 'tunnels') return '隧道（全局）'
  if (t === 'all_nodes') return '全部节点'
  if (t === 'scoped') return '管辖范围'
  return t
}

/**
 * 详情里常见英文键名 → 中文（值保持原样，避免破坏技术字段）。
 * `instances`/`tunnels`/`segments`/`subnet`/`version`/`canary` 等使用词边界，避免误伤 `multi_instances=`、`subversion=` 等复合键。
 * @param {string | null | undefined} detail
 * @returns {string}
 */
export function auditDetailDisplayZh(detail) {
  if (detail == null || detail === '') return '—'
  let s = String(detail)
  /**
   * 长键名、复合键名优先，避免短模式误伤（如 `public_ip=` 中的 `ip=`、`usergroup=` 中的 `group=`）。
   * 短键使用 \b 词边界，避免匹配复合英文词内部。
   */
  const pairs = [
    [/self\b/g, '本人'],
    [/ok_peers=/g, '成功对等体='],
    [/total_peers=/g, '对等体总数='],
    [/cleaned_tunnels=/g, '清理隧道数='],
    [/cert_cn=/g, '证书CN='],
    [/\binstances=/g, '实例数='],
    [/ip_a=/g, '端点A IP='],
    [/ip_b=/g, '端点B IP='],
    [/wg_port=/g, 'WG端口='],
    [/\bsubnet=/g, '子网='],
    [/\bsegments=/g, '网段='],
    [/\btunnels=/g, '隧道数='],
    [/total_nodes=/g, '节点总数='],
    [/\binstance=/g, '实例='],
    [/\bgroup=/g, '组='],
    [/\brole=/g, '角色='],
    [/\bperms=/g, '权限='],
    [/\bregion=/g, '区域='],
    [/\binvalid=/g, '无效数='],
    [/\bsuccess=/g, '成功='],
    [/\berror=/g, '错误='],
    [/\btotal=/g, '总数='],
    [/\bname=/g, '名称='],
    [/\bip=/g, 'IP='],
  ]
  for (const [re, rep] of pairs) {
    s = s.replace(re, rep)
  }
  s = s.replace(/removed (\d+) grant rows/gi, (_, n) => `已删除 ${n} 条授权记录`)
  s = s.replace(/\bby super admin\b/gi, '由超级管理员操作')
  s = s.replace(/apply_to_instances=(\w+)/g, '是否应用到实例=$1')
  s = s.replace(/\bversion=/g, '版本=')
  s = s.replace(/\bcanary=/g, '金丝雀节点=')
  return s
}
