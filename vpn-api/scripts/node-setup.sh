#!/usr/bin/env bash
set -euo pipefail

API_URL=""
NODE_TOKEN=""
DRY_RUN=1
NON_INTERACTIVE=0
FORCE_REINSTALL=0
OPEN_HOST_FIREWALL=0
OPEN_HOST_FIREWALL_MODE="auto"
# 空=完全按控制面 instances[].proto；udp/tcp=本机统一覆盖（并写入 bootstrap-node.json）
OPENVPN_PROTO_OVERRIDE=""
# 端口冲突策略：prompt(交互询问) / abort(直接中止) / cleanup(自动清理白名单进程)
PORT_CONFLICT_POLICY=""
FIREWALL_BACKEND="none"
FIREWALL_ACTIVE=0
SKIPPED_OPENVPN_MODES=()

usage() {
  cat <<'EOF'
Usage:
  node-setup.sh --api-url <url> --token <node-token> [--apply] [--non-interactive] [--force-reinstall] [--open-host-firewall|--no-open-host-firewall] [--openvpn-proto udp|tcp] [--port-conflict-policy prompt|abort|cleanup]

无参数或缺少 URL/Token 时，若在 TTY 下运行将显示交互菜单（查看信息 / 卸载 / 部署）。

This script:
  1. Registers the node with the control plane API
  2. Installs openvpn, wireguard-tools, ipset, easy-rsa, jq
  3. Initializes easy-rsa PKI and builds server certificate
  4. Renders per-instance OpenVPN server.conf files
  5. Deploys WireGuard backbone tunnels to all peer nodes
  6. Configures policy routing (ip rule + routing tables)
  7. Configures NAT/split-routing rules (iptables + ipset)
  8. Creates systemd service units for all components
  9. Downloads the current vpn-agent from the control plane (always overwrites /usr/local/bin/vpn-agent) and starts it

Default mode is dry-run. Use --apply to execute.
  --force-reinstall      若本机已有 /etc/vpn-agent，实际安装前会先卸载再装（需配合 --apply）
  --open-host-firewall     强制在本机防火墙放行 OpenVPN 与 WireGuard 监听端口（需 root）
  --no-open-host-firewall  禁用本机防火墙自动放行（默认 auto：若检测到 ufw/firewalld 启用则自动放行）
  --openvpn-proto udp|tcp  注册成功后强制将所有 OpenVPN 实例统一为该协议（写入本机 bootstrap）；默认完全按控制面下发
                            交互式且未加本参数时，注册后会询问是否改为全 UDP / 全 TCP
  --port-conflict-policy   端口冲突处理策略：prompt(询问管理员) / abort(直接中止) / cleanup(自动清理白名单进程)
                            默认：交互模式 prompt；非交互模式 abort

提示：curl … | bash 时 stdin 为管道；若需交互询问「是否重装」，脚本会从 /dev/tty 读取。
无人值守或 CI 请使用 --force-reinstall。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)  API_URL="${2:-}"; shift 2 ;;
    --token)    NODE_TOKEN="${2:-}"; shift 2 ;;
    --apply)    DRY_RUN=0; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --force-reinstall) FORCE_REINSTALL=1; shift ;;
    --open-host-firewall) OPEN_HOST_FIREWALL=1; OPEN_HOST_FIREWALL_MODE="on"; shift ;;
    --no-open-host-firewall) OPEN_HOST_FIREWALL_MODE="off"; shift ;;
    --openvpn-proto)
      OPENVPN_PROTO_OVERRIDE="${2:-}"
      shift 2
      ;;
    --port-conflict-policy)
      PORT_CONFLICT_POLICY="${2:-}"
      shift 2
      ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "Unknown: $1"; usage; exit 1 ;;
  esac
done

if [[ -n "${OPENVPN_PROTO_OVERRIDE:-}" ]]; then
  case "${OPENVPN_PROTO_OVERRIDE,,}" in
    udp|tcp) ;;
    *) echo "错误: --openvpn-proto 仅支持 udp 或 tcp，当前: ${OPENVPN_PROTO_OVERRIDE}" >&2; exit 1 ;;
  esac
fi

if [[ -n "${PORT_CONFLICT_POLICY:-}" ]]; then
  case "${PORT_CONFLICT_POLICY,,}" in
    prompt|abort|cleanup) ;;
    *) echo "错误: --port-conflict-policy 仅支持 prompt / abort / cleanup，当前: ${PORT_CONFLICT_POLICY}" >&2; exit 1 ;;
  esac
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[1;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }

TOTAL_STEPS=9
LEGACY_OPENVPN_UNITS=(
  "openvpn-server@server.service"
  "openvpn@server.service"
)

# 预检：是否运行 ufw / firewalld（仅提示，不修改规则）
detect_firewall_backend() {
  FIREWALL_BACKEND="none"
  FIREWALL_ACTIVE=0
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qiE 'Status:\s*active'; then
    FIREWALL_BACKEND="ufw"
    FIREWALL_ACTIVE=1
    echo "$FIREWALL_BACKEND"
    return 0
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -qi running; then
    FIREWALL_BACKEND="firewalld"
    FIREWALL_ACTIVE=1
    echo "$FIREWALL_BACKEND"
    return 0
  fi
  if command -v iptables >/dev/null 2>&1; then
    FIREWALL_BACKEND="iptables"
  fi
  echo "$FIREWALL_BACKEND"
}

should_apply_host_firewall_open() {
  case "$OPEN_HOST_FIREWALL_MODE" in
    on) return 0 ;;
    off) return 1 ;;
  esac
  detect_firewall_backend >/dev/null
  [[ "$FIREWALL_ACTIVE" -eq 1 ]]
}

detect_host_firewall_precheck() {
  echo ""
  log "检查本机防火墙框架 ..."
  detect_firewall_backend >/dev/null
  case "$OPEN_HOST_FIREWALL_MODE" in
    on) log "防火墙放行策略: 强制放行 (--open-host-firewall)" ;;
    off) warn "防火墙放行策略: 已禁用 (--no-open-host-firewall)" ;;
    *) log "防火墙放行策略: 自动（检测到启用中的 ufw/firewalld 时自动放行）" ;;
  esac
  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -qiE 'Status:\s*active'; then
      warn "ufw 已启用：若 VPN 连不上，请在 ufw 放行下方「外部放行清单」中的端口，或使用 --open-host-firewall"
    else
      ok "ufw 存在但未 active（或已关闭）"
    fi
  else
    ok "未安装 ufw（可跳过）"
  fi
  if command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --state 2>/dev/null | grep -qi running; then
      warn "firewalld 运行中：请在 firewalld 放行清单中的端口，或使用 --open-host-firewall"
    else
      ok "firewalld 存在但未 running"
    fi
  else
    ok "未安装 firewalld（可跳过）"
  fi
}

# 注册后：按控制面下发的实例检测端口是否已被占用
check_instance_ports_from_bootstrap_json() {
  local json="$1"
  [[ -z "$json" ]] && return 0
  local ic port p mode conflicts policy action
  ic="$(echo "$json" | jq '.instances | length')"
  [[ "$ic" -eq 0 ]] && return 0
  echo ""
  log "检查 OpenVPN 监听端口占用（控制面下发） ..."
  for i in $(seq 0 $((ic - 1))); do
    inst_en="$(echo "$json" | jq -r ".instances[$i].enabled // true")"
    [[ "$inst_en" == "false" ]] && continue
    mode="$(echo "$json" | jq -r ".instances[$i].mode // \"unknown\"")"
    port="$(echo "$json" | jq -r ".instances[$i].port")"
    p="$(echo "$json" | jq -r ".instances[$i].proto // \"udp\"" | tr '[:upper:]' '[:lower:]')"
    [[ "$p" != "tcp" ]] && p="udp"
    conflicts="$(collect_port_conflicts_by_proto_port "$p" "$port" || true)"
    if [[ -z "$conflicts" ]]; then
      ok "$(echo "$p" | tr '[:lower:]' '[:upper:]') :${port} 可用（OpenVPN）"
      continue
    fi
    warn "$(echo "$p" | tr '[:lower:]' '[:upper:]') 端口 ${port} 已被占用（OpenVPN）"
    while IFS= read -r c; do
      [[ -z "$c" ]] && continue
      echo "    ${c##*|}"
    done <<< "$conflicts"

    policy="$(effective_port_conflict_policy)"
    case "$policy" in
      cleanup)
        log "  端口冲突策略: cleanup（自动清理白名单进程）"
        cleanup_conflicting_processes "$mode" "" "$p" "$port" "$conflicts" || return 1
        ;;
      abort)
        fail "  端口冲突策略: abort（中止部署）"
        return 1
        ;;
      prompt|*)
        action="$(prompt_admin_conflict_action "$mode" "$p" "$port")"
        case "$action" in
          cleanup) cleanup_conflicting_processes "$mode" "" "$p" "$port" "$conflicts" || return 1 ;;
          skip) warn "  管理员选择暂不清理 mode=${mode}，后续启动前将再次检查" ;;
          *) fail "  管理员选择中止部署"; return 1 ;;
        esac
        ;;
    esac
  done
  local tc
  tc="$(echo "$json" | jq '.tunnels | length')"
  if [[ "$tc" -gt 0 ]]; then
    local wgport
    wgport="$(echo "$json" | jq -r '.tunnels[0].wg_port')"
    if [[ -n "$wgport" && "$wgport" != "null" ]]; then
      conflicts="$(collect_port_conflicts_by_proto_port "udp" "$wgport" || true)"
      if [[ -z "$conflicts" ]]; then
        ok "UDP :${wgport} 可用（WireGuard 首隧道监听）"
      else
        warn "UDP 端口 ${wgport} 已被占用（WireGuard 监听）"
        while IFS= read -r c; do
          [[ -z "$c" ]] && continue
          echo "    ${c##*|}"
        done <<< "$conflicts"
        policy="$(effective_port_conflict_policy)"
        case "$policy" in
          cleanup)
            log "  端口冲突策略: cleanup（自动清理白名单进程）"
            cleanup_conflicting_processes "wireguard-first-tunnel" "" "udp" "$wgport" "$conflicts" || return 1
            ;;
          abort)
            fail "  端口冲突策略: abort（中止部署）"
            return 1
            ;;
          prompt|*)
            action="$(prompt_admin_conflict_action "wireguard-first-tunnel" "udp" "$wgport")"
            case "$action" in
              cleanup) cleanup_conflicting_processes "wireguard-first-tunnel" "" "udp" "$wgport" "$conflicts" || return 1 ;;
              skip) warn "  管理员选择暂不清理 WireGuard 端口，后续流程继续" ;;
              *) fail "  管理员选择中止部署"; return 1 ;;
            esac
            ;;
        esac
      fi
    fi
  fi
}

# 清理可能与本脚本生成实例冲突的历史 OpenVPN 单元（例如 openvpn-server@server）
cleanup_legacy_openvpn_units() {
  local touched=0
  for unit in "${LEGACY_OPENVPN_UNITS[@]}"; do
    if ! systemctl list-unit-files --type=service --all --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$unit"; then
      continue
    fi
    touched=1
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      log "  Stopping legacy OpenVPN unit: $unit"
      systemctl stop "$unit" 2>/dev/null || warn "stop $unit failed (ignored)"
    fi
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      log "  Disabling legacy OpenVPN unit: $unit"
      systemctl disable "$unit" 2>/dev/null || warn "disable $unit failed (ignored)"
    fi
  done
  if [[ "$touched" -eq 1 ]]; then
    systemctl daemon-reload 2>/dev/null || true
  fi
}

extract_openvpn_conf_port_proto() {
  local conf="$1"
  local port proto
  port="$(awk '/^[[:space:]]*port[[:space:]]+/ {print $2; exit}' "$conf" 2>/dev/null || true)"
  proto="$(awk '/^[[:space:]]*proto[[:space:]]+/ {print tolower($2); exit}' "$conf" 2>/dev/null || true)"
  [[ -z "$proto" ]] && proto="udp"
  if [[ "$proto" != tcp* ]]; then
    proto="udp"
  else
    proto="tcp"
  fi
  echo "${port}|${proto}"
}

effective_port_conflict_policy() {
  local p="${PORT_CONFLICT_POLICY,,}"
  if [[ -n "$p" ]]; then
    echo "$p"
    return 0
  fi
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    echo "abort"
  else
    echo "prompt"
  fi
}

collect_port_conflicts_for_mode() {
  local mode="$1"
  local conf="$2"
  local proto="$3"
  local port="$4"
  local listeners line pid args

  if [[ "$proto" == "tcp" ]]; then
    listeners="$(ss -tlnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print}')"
  else
    listeners="$(ss -ulnp 2>/dev/null | awk -v p=":${port}" '$5 ~ p {print}')"
  fi
  [[ -z "$listeners" ]] && return 0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    pid="$(echo "$line" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1)"
    if [[ -n "$pid" ]]; then
      args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      if [[ "$args" == *"--config ${conf}"* ]]; then
        continue
      fi
      echo "${pid}|${args}|${line}"
    else
      echo "|unknown|${line}"
    fi
  done <<< "$listeners"
}

collect_port_conflicts_by_proto_port() {
  local proto="$1"
  local port="$2"
  local listeners line pid args
  if [[ "$proto" == "tcp" ]]; then
    listeners="$(ss -tlnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print}')"
  else
    listeners="$(ss -ulnp 2>/dev/null | awk -v p=":${port}" '$5 ~ p {print}')"
  fi
  [[ -z "$listeners" ]] && return 0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    pid="$(echo "$line" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1)"
    if [[ -n "$pid" ]]; then
      args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      echo "${pid}|${args}|${line}"
    else
      echo "|unknown|${line}"
    fi
  done <<< "$listeners"
}

is_cleanup_whitelisted_process() {
  local args="$1"
  [[ -z "$args" ]] && return 1
  if [[ "$args" == *"openvpn"* && "$args" == *"--config /etc/openvpn/server/"* ]]; then
    return 0
  fi
  if [[ "$args" == *"wg-quick"* && "$args" == *"wg-"* ]]; then
    return 0
  fi
  return 1
}

prompt_admin_conflict_action() {
  local mode="$1"
  local proto="$2"
  local port="$3"
  local ans=""
  local prompt="  mode=${mode} ${proto}/${port} 端口冲突：输入 [k]=清理并继续 [s]=跳过该实例 [a]=中止部署: "
  if [[ -r /dev/tty ]]; then
    printf '%s' "$prompt" >&2
    read -r ans < /dev/tty || true
  else
    echo "abort"
    return 0
  fi
  ans="$(echo "$ans" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$ans" in
    k|cleanup) echo "cleanup" ;;
    s|skip) echo "skip" ;;
    a|abort|'') echo "abort" ;;
    *) echo "abort" ;;
  esac
}

cleanup_conflicting_processes() {
  local mode="$1"
  local conf="$2"
  local proto="$3"
  local port="$4"
  local records="$5"
  local line pid args raw
  local unsafe=0
  declare -a kill_pids=()

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    pid="${line%%|*}"
    raw="${line#*|}"
    args="${raw%%|*}"
    if [[ -z "$pid" ]]; then
      warn "  无法解析 PID，拒绝自动清理：${line##*|}"
      unsafe=1
      continue
    fi
    if ! is_cleanup_whitelisted_process "$args"; then
      warn "  非白名单进程，拒绝自动清理: pid=${pid} cmd=${args:-unknown}"
      unsafe=1
      continue
    fi
    kill_pids+=("$pid")
  done <<< "$records"

  if [[ "$unsafe" -ne 0 ]]; then
    fail "  检测到非白名单/不可识别占用，请管理员手动处理后重试"
    return 1
  fi

  local p
  for p in "${kill_pids[@]}"; do
    log "  清理冲突进程 pid=${p}"
    kill "$p" 2>/dev/null || true
  done
  sleep 1
  for p in "${kill_pids[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      warn "  pid=${p} 仍在运行，尝试强制结束"
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  sleep 1

  local remained
  if [[ -n "$conf" ]]; then
    remained="$(collect_port_conflicts_for_mode "$mode" "$conf" "$proto" "$port" || true)"
  else
    remained="$(collect_port_conflicts_by_proto_port "$proto" "$port" || true)"
  fi
  if [[ -n "$remained" ]]; then
    fail "  清理后端口仍有冲突: ${proto}/${port}"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      echo "    ${line##*|}"
    done <<< "$remained"
    return 1
  fi
  ok "  端口已释放: ${proto}/${port}"
  return 0
}

check_openvpn_port_conflict_for_mode() {
  local mode="$1"
  local conf="/etc/openvpn/server/${mode}/server.conf"
  if [[ ! -f "$conf" ]]; then
    warn "  Missing server.conf for mode=${mode}, skip conflict check"
    return 0
  fi
  local pp port proto
  pp="$(extract_openvpn_conf_port_proto "$conf")"
  port="${pp%%|*}"
  proto="${pp##*|}"
  if [[ -z "$port" ]]; then
    warn "  mode=${mode} has no port in server.conf, skip conflict check"
    return 0
  fi

  local conflicts policy action c
  conflicts="$(collect_port_conflicts_for_mode "$mode" "$conf" "$proto" "$port" || true)"
  if [[ -z "$conflicts" ]]; then
    ok "  Port check passed for mode=${mode}: ${proto}/${port}"
    return 0
  fi

  fail "  Port conflict for mode=${mode}: ${proto}/${port} already in use"
  while IFS= read -r c; do
    [[ -z "$c" ]] && continue
    echo "    ${c##*|}"
  done <<< "$conflicts"

  policy="$(effective_port_conflict_policy)"
  case "$policy" in
    cleanup)
      log "  端口冲突策略: cleanup（自动清理白名单进程）"
      cleanup_conflicting_processes "$mode" "$conf" "$proto" "$port" "$conflicts"
      return $?
      ;;
    abort)
      fail "  端口冲突策略: abort（中止部署）"
      return 1
      ;;
    prompt|*)
      action="$(prompt_admin_conflict_action "$mode" "$proto" "$port")"
      case "$action" in
        cleanup)
          cleanup_conflicting_processes "$mode" "$conf" "$proto" "$port" "$conflicts"
          return $?
          ;;
        skip)
          warn "  管理员选择跳过实例 mode=${mode}"
          return 2
          ;;
        *)
          fail "  管理员选择中止部署"
          return 1
          ;;
      esac
      ;;
  esac
}

start_openvpn_mode_with_health_check() {
  local mode="$1"
  local unit="openvpn-${mode}.service"
  local conf="/etc/openvpn/server/${mode}/server.conf"
  if [[ ! -f "$conf" ]]; then
    fail "  Missing config: $conf"
    return 1
  fi
  check_openvpn_port_conflict_for_mode "$mode"
  local rc=$?
  if [[ "$rc" -eq 2 ]]; then
    return 2
  fi
  if [[ "$rc" -ne 0 ]]; then
    return 1
  fi
  systemctl enable "$unit"
  if ! systemctl restart "$unit"; then
    fail "  Failed to restart $unit"
    journalctl -u "$unit" -n 30 --no-pager -o cat | sed 's/^/    /'
    return 1
  fi
  local tries=0
  while [[ "$tries" -lt 3 ]]; do
    if systemctl is-active --quiet "$unit"; then
      ok "  Service $unit is active"
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done
  fail "  Service $unit failed health check"
  journalctl -u "$unit" -n 30 --no-pager -o cat | sed 's/^/    /'
  return 1
}

collect_required_ports_from_bootstrap_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local ic i inst_en mode port p tc wgport
  ic="$(jq '.instances | length' "$f")"
  for i in $(seq 0 $((ic - 1))); do
    inst_en="$(jq -r ".instances[$i].enabled // true" "$f")"
    [[ "$inst_en" == "false" ]] && continue
    mode="$(jq -r ".instances[$i].mode // \"unknown\"" "$f")"
    port="$(jq -r ".instances[$i].port" "$f")"
    p="$(jq -r ".instances[$i].proto // \"udp\"" "$f" | tr '[:upper:]' '[:lower:]')"
    [[ "$p" != "tcp" ]] && p="udp"
    echo "openvpn|${mode}|${p}|${port}"
  done
  tc="$(jq '.tunnels | length' "$f")"
  if [[ "$tc" -gt 0 ]]; then
    wgport="$(jq -r '.tunnels[0].wg_port' "$f")"
    if [[ -n "$wgport" && "$wgport" != "null" ]]; then
      echo "wireguard|first-tunnel|udp|${wgport}"
    fi
  fi
}

# 在 ufw / firewalld / iptables 上放行 bootstrap JSON 中的监听端口（需 root）
apply_host_firewall_open() {
  local f="$1"
  [[ ! -f "$f" ]] && { warn "无 $f，跳过本机防火墙放行"; return 0; }
  [[ "$(id -u)" -ne 0 ]] && { warn "非 root，跳过本机防火墙放行"; return 1; }

  local backend proto port component mode
  backend="$(detect_firewall_backend)"
  if [[ "$backend" == "none" ]]; then
    warn "未检测到可用防火墙后端，无法自动放行"
    return 1
  fi

  log "尝试本机防火墙放行（backend=${backend}, mode=${OPEN_HOST_FIREWALL_MODE}）..."
  while IFS='|' read -r component mode proto port; do
    [[ -z "$port" ]] && continue
    if [[ "$backend" == "ufw" ]]; then
      if ufw allow "${port}/${proto}" 2>/dev/null; then
        ok "ufw allow ${port}/${proto} (${component}:${mode})"
      else
        warn "ufw allow ${port}/${proto} 失败（${component}:${mode}）"
      fi
    elif [[ "$backend" == "firewalld" ]]; then
      if firewall-cmd --permanent --add-port="${port}/${proto}" 2>/dev/null; then
        ok "firewalld add-port ${port}/${proto} (${component}:${mode})"
      else
        warn "firewalld add-port ${port}/${proto} 失败（${component}:${mode}）"
      fi
    else
      if ! iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment "vpn-node-setup" -j ACCEPT 2>/dev/null; then
        if iptables -I INPUT 1 -p "$proto" --dport "$port" -m comment --comment "vpn-node-setup" -j ACCEPT 2>/dev/null; then
          ok "iptables INPUT 放行 ${proto} :${port} (${component}:${mode})"
        else
          warn "iptables 放行 ${proto} :${port} 失败（${component}:${mode}）"
        fi
      else
        ok "iptables 已存在 ${proto} :${port}（${component}:${mode}）"
      fi
    fi
  done < <(collect_required_ports_from_bootstrap_file "$f")

  if [[ "$backend" == "firewalld" ]]; then
    firewall-cmd --reload 2>/dev/null && ok "firewalld --reload 完成" || warn "firewalld reload 失败"
  fi
}

verify_host_firewall_rules() {
  local f="$1"
  [[ ! -f "$f" ]] && { warn "无 $f，跳过本机防火墙规则验收"; return 1; }
  [[ "$(id -u)" -ne 0 ]] && { warn "非 root，无法验证本机防火墙规则"; return 1; }
  local backend proto port component mode errors
  backend="$(detect_firewall_backend)"
  errors=0
  while IFS='|' read -r component mode proto port; do
    [[ -z "$port" ]] && continue
    if [[ "$backend" == "ufw" ]]; then
      if ufw status 2>/dev/null | grep -qiE "(^|[[:space:]])${port}/${proto}([[:space:]]|$)"; then
        ok "规则验收通过: ufw ${port}/${proto} (${component}:${mode})"
      else
        fail "规则缺失: ufw ${port}/${proto} (${component}:${mode})"
        errors=$((errors + 1))
      fi
    elif [[ "$backend" == "firewalld" ]]; then
      if firewall-cmd --query-port="${port}/${proto}" 2>/dev/null | grep -qi "^yes$"; then
        ok "规则验收通过: firewalld ${port}/${proto} (${component}:${mode})"
      else
        fail "规则缺失: firewalld ${port}/${proto} (${component}:${mode})"
        errors=$((errors + 1))
      fi
    elif [[ "$backend" == "iptables" ]]; then
      if iptables -C INPUT -p "$proto" --dport "$port" -m comment --comment "vpn-node-setup" -j ACCEPT 2>/dev/null || \
         iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null; then
        ok "规则验收通过: iptables ${port}/${proto} (${component}:${mode})"
      else
        fail "规则缺失: iptables ${port}/${proto} (${component}:${mode})"
        errors=$((errors + 1))
      fi
    else
      fail "未识别防火墙后端，无法验收规则 (${port}/${proto})"
      errors=$((errors + 1))
    fi
  done < <(collect_required_ports_from_bootstrap_file "$f")
  [[ "$errors" -eq 0 ]]
}

is_mode_skipped() {
  local mode="$1"
  local m
  for m in "${SKIPPED_OPENVPN_MODES[@]:-}"; do
    [[ "$m" == "$mode" ]] && return 0
  done
  return 1
}

verify_required_ports_listening_file() {
  local f="$1"
  [[ ! -f "$f" ]] && { warn "无 $f，无法执行监听验收"; return 1; }
  local proto port component mode listeners errors
  errors=0
  while IFS='|' read -r component mode proto port; do
    [[ -z "$port" ]] && continue
    if [[ "$component" == "openvpn" && "$mode" != "unknown" ]] && is_mode_skipped "$mode"; then
      warn "监听验收跳过: ${component}:${mode}（管理员选择跳过）"
      continue
    fi
    if [[ "$proto" == "tcp" ]]; then
      listeners="$(ss -tlnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print}')"
    else
      listeners="$(ss -ulnp 2>/dev/null | awk -v p=":${port}" '$5 ~ p {print}')"
    fi
    if [[ -z "$listeners" ]]; then
      fail "监听缺失: ${component}:${mode} ${proto}/${port}"
      errors=$((errors + 1))
      continue
    fi
    if [[ "$component" == "openvpn" ]] && ! echo "$listeners" | grep -qi "openvpn"; then
      fail "监听进程异常: ${component}:${mode} ${proto}/${port} 非 openvpn"
      echo "$listeners" | sed 's/^/    /'
      errors=$((errors + 1))
      continue
    fi
    ok "监听验收通过: ${component}:${mode} ${proto}/${port}"
  done < <(collect_required_ports_from_bootstrap_file "$f")
  [[ "$errors" -eq 0 ]]
}

post_deploy_health_check() {
  local f="$1"
  local errors mode inst_en ic i
  errors=0
  echo ""
  log "部署后健康检查 ..."

  if systemctl is-active --quiet vpn-agent.service; then
    ok "服务健康: vpn-agent.service"
  else
    fail "服务异常: vpn-agent.service"
    errors=$((errors + 1))
  fi
  if systemctl is-active --quiet vpn-routing.service; then
    ok "服务健康: vpn-routing.service"
  else
    fail "服务异常: vpn-routing.service"
    errors=$((errors + 1))
  fi

  ic="$(jq '.instances | length' "$f")"
  for i in $(seq 0 $((ic - 1))); do
    inst_en="$(jq -r ".instances[$i].enabled // true" "$f")"
    [[ "$inst_en" == "false" ]] && continue
    mode="$(jq -r ".instances[$i].mode // \"unknown\"" "$f")"
    if is_mode_skipped "$mode"; then
      warn "服务健康跳过: openvpn-${mode}.service（管理员选择跳过）"
      continue
    fi
    if systemctl is-active --quiet "openvpn-${mode}.service"; then
      ok "服务健康: openvpn-${mode}.service"
    else
      fail "服务异常: openvpn-${mode}.service"
      errors=$((errors + 1))
    fi
  done

  if ! verify_required_ports_listening_file "$f"; then
    errors=$((errors + 1))
  fi

  if should_apply_host_firewall_open; then
    if ! verify_host_firewall_rules "$f"; then
      errors=$((errors + 1))
    fi
  else
    warn "未启用本机防火墙自动放行/验收（mode=${OPEN_HOST_FIREWALL_MODE}）"
  fi

  if [[ "$errors" -gt 0 ]]; then
    fail "部署后健康检查失败（错误项: ${errors}），节点可能不可访问"
    echo "请按上方缺失项执行修复后重试，或参考 docs/node-troubleshooting.md。" >&2
    return 1
  fi
  ok "部署后健康检查通过"
  return 0
}

# 收尾：提醒云安全组 / 路由器需放行的端口（与脚本生成的监听一致）
print_external_firewall_reminder() {
  local json="$1"
  [[ -z "$json" ]] && return 0
  echo ""
  log "════════════════ 外部放行清单（云安全组 / 路由器 / 上游防火墙）════════════════"
  log "以下端口需在「公网入站」方向对本机公网 IP 放行（本机未启用 ufw/firewalld 时亦须配置）："
  local ic i port p inst_mode pup
  ic="$(echo "$json" | jq '.instances | length')"
  for i in $(seq 0 $((ic - 1))); do
    inst_en="$(echo "$json" | jq -r ".instances[$i].enabled // true")"
    [[ "$inst_en" == "false" ]] && continue
    port="$(echo "$json" | jq -r ".instances[$i].port")"
    p="$(echo "$json" | jq -r ".instances[$i].proto // \"udp\"" | tr '[:upper:]' '[:lower:]')"
    [[ "$p" != "tcp" ]] && p="udp"
    pup="$(echo "$p" | tr '[:lower:]' '[:upper:]')"
    inst_mode="$(echo "$json" | jq -r ".instances[$i].mode")"
    log "  - OpenVPN [${inst_mode}]  ${pup} ${port}   （协议 ${p}，端口 ${port}）"
  done
  local tc wgport
  tc="$(echo "$json" | jq '.tunnels | length')"
  if [[ "$tc" -gt 0 ]]; then
    wgport="$(echo "$json" | jq -r '.tunnels[0].wg_port')"
    if [[ -n "$wgport" && "$wgport" != "null" ]]; then
      log "  - WireGuard 首隧道监听  UDP ${wgport}"
    fi
  fi
  log "若客户端仍无法连接：检查云厂商安全组、机房边界 ACL、家用路由器端口映射是否包含上述项。"
  log "════════════════════════════════════════════════════════════════════════════"
}

# 交互：注册成功后询问是否将 OpenVPN 全部统一为 UDP 或 TCP（未传 --openvpn-proto 且非 NON_INTERACTIVE）
prompt_openvpn_proto_interactive() {
  [[ "$NON_INTERACTIVE" -eq 1 ]] && return 0
  [[ -n "${OPENVPN_PROTO_OVERRIDE:-}" ]] && return 0
  local ic
  ic="$(echo "$NODE_JSON" | jq '.instances | length')"
  [[ "$ic" -eq 0 ]] && return 0
  echo ""
  log "OpenVPN 传输协议（以下为控制面当前下发）"
  local i m p
  for i in $(seq 0 $((ic - 1))); do
    m="$(echo "$NODE_JSON" | jq -r ".instances[$i].mode")"
    p="$(echo "$NODE_JSON" | jq -r ".instances[$i].proto // \"udp\"")"
    printf '  • %s → %s\n' "$m" "$(echo "$p" | tr '[:lower:]' '[:upper:]')"
  done
  echo ""
  local choice=""
  if [[ -r /dev/tty ]]; then
    printf '  全部实例使用: 输入 [u]=UDP  [t]=TCP  [回车]=按上表控制面下发: ' >&2
    read -r choice </dev/tty || true
  else
    return 0
  fi
  choice="$(echo "$choice" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$choice" in
    u|udp) OPENVPN_PROTO_OVERRIDE=udp ;;
    t|tcp) OPENVPN_PROTO_OVERRIDE=tcp ;;
    '') return 0 ;;
    *) warn "未识别输入「$choice」，按控制面下发继续"; return 0 ;;
  esac
}

# 将 OPENVPN_PROTO_OVERRIDE 应用到内存中的 NODE_JSON（供后续写 bootstrap、生成 server.conf）
apply_openvpn_proto_override_to_node_json() {
  [[ -z "${OPENVPN_PROTO_OVERRIDE:-}" ]] && return 0
  local p="${OPENVPN_PROTO_OVERRIDE,,}"
  case "$p" in
    tcp|udp) ;;
    *) fail "--openvpn-proto 须为 udp 或 tcp"; exit 1 ;;
  esac
  NODE_JSON="$(echo "$NODE_JSON" | jq --arg p "$p" '.instances |= map(.proto = $p)')"
  log "已将各 OpenVPN 实例 proto 统一为 ${p}（本机 bootstrap 与 server.conf）"
  warn "请在控制面「节点详情 → 组网接入」将各实例协议改为 $(echo "$p" | tr '[:lower:]' '[:upper:]') 并保存，避免 Agent 同步后与现场不一致。"
}

is_deployed() {
  [[ -f /etc/vpn-agent/agent.json ]]
}

read_api_url_from_agent_json() {
  local f="/etc/vpn-agent/agent.json"
  [[ -f "$f" ]] || { echo ""; return; }
  if command -v jq >/dev/null 2>&1; then
    jq -r '.api_url // empty' "$f" 2>/dev/null
    return
  fi
  sed -n 's/.*"api_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" 2>/dev/null | head -1
}

print_current_deploy_info() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  当前本机部署信息（未执行重新安装）"
  echo "═══════════════════════════════════════════════════════════════"
  local u
  u="$(read_api_url_from_agent_json)"
  echo "  所连接控制面 API (api_url): ${u:-（未知）}"
  if [[ -f /etc/vpn-agent/bootstrap-node.json ]] && command -v jq >/dev/null 2>&1; then
    echo "  节点 ID: $(jq -r '.node_id // empty' /etc/vpn-agent/bootstrap-node.json 2>/dev/null)"
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
}

do_uninstall() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "卸载需要 root 权限。" >&2
    exit 1
  fi
  log "正在卸载 VPN 节点组件 ..."
  systemctl stop vpn-agent.service 2>/dev/null || true
  systemctl disable vpn-agent.service 2>/dev/null || true
  systemctl stop vpn-routing.service 2>/dev/null || true
  systemctl disable vpn-routing.service 2>/dev/null || true
  for m in local-only hk-smart-split hk-global us-global; do
    systemctl stop "openvpn-${m}.service" 2>/dev/null || true
    systemctl disable "openvpn-${m}.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/openvpn-${m}.service"
  done
  cleanup_legacy_openvpn_units
  if [[ -d /etc/wireguard ]]; then
    shopt -s nullglob
    for cf in /etc/wireguard/wg-*.conf; do
      bn="$(basename "$cf" .conf)"
      systemctl stop "wg-quick@${bn}" 2>/dev/null || true
      systemctl disable "wg-quick@${bn}" 2>/dev/null || true
    done
    shopt -u nullglob
  fi
  systemctl daemon-reload 2>/dev/null || true
  rm -rf /etc/vpn-agent
  ok "已停止相关服务并移除 /etc/vpn-agent（如需可手动清理 /etc/openvpn /etc/wireguard）"
}

do_purge() {
  do_uninstall
}

# 无参或缺 URL/Token：TTY 下进入菜单；否则报错
resolve_args_or_menu() {
  if [[ -n "$API_URL" && -n "$NODE_TOKEN" ]]; then
    return 0
  fi
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    echo "非交互模式必须同时提供 --api-url 与 --token。" >&2
    usage
    exit 1
  fi
  if [[ ! -t 0 ]] || [[ ! -t 1 ]]; then
    echo "缺少 --api-url 或 --token，且非交互终端无法显示菜单。" >&2
    usage
    exit 1
  fi
  while true; do
    echo ""
    echo "VPN 节点部署 — 请选择："
    echo "  1) 部署 / 重新安装（需控制面 URL 与 Bootstrap Token）"
    echo "  2) 查看当前本机已连接的控制面信息（不修改系统）"
    echo "  3) 卸载本机 VPN 节点组件"
    echo "  4) 退出"
    read -r -p "选择 [1-4]: " _choice
    case "$_choice" in
      1) break ;;
      2) print_current_deploy_info; exit 0 ;;
      3) do_uninstall; exit 0 ;;
      4|q|Q) exit 0 ;;
      *) echo "无效选择，请输入 1-4。" ;;
    esac
  done
  read -r -p "控制面 API 基础 URL（如 https://vpn.example.com）: " API_URL
  read -r -p "节点 Bootstrap Token: " NODE_TOKEN
  echo ""
  read -r -p "是否执行实际安装（等价 --apply）？否则仅预检 [y/N]: " _yn
  if [[ "${_yn,,}" == "y" ]]; then DRY_RUN=0; else DRY_RUN=1; fi
}

maybe_reinstall_on_deployed() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  is_deployed || return 0
  if [[ "$FORCE_REINSTALL" -eq 1 ]]; then
    log "已指定 --force-reinstall，将先卸载再安装 ..."
    do_purge
    return 0
  fi
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    echo "检测到本机已有 /etc/vpn-agent 部署。请使用 --force-reinstall 先卸载再装，或先手动卸载。" >&2
    exit 1
  fi
  # curl … | bash 时 stdin 是管道，read 会读到 EOF，误当成「不重装」并只打印信息。
  # 交互式 SSH 下改从真实终端 /dev/tty 读；完全无终端时再要求 --force-reinstall。
  local _purge=""
  local _prompt="检测到已有部署，是否清空并重装？否则仅显示当前信息 [y/N]: "
  if [[ -t 0 ]]; then
    read -r -p "$_prompt" _purge
  elif [[ -r /dev/tty ]]; then
    read -r -p "$_prompt" _purge < /dev/tty
  else
    echo "检测到本机已有 /etc/vpn-agent 部署，且当前无交互终端（如纯管道/无人值守执行）。" >&2
    echo "请追加 --force-reinstall 清空后重装，或先卸载再运行本脚本。" >&2
    exit 1
  fi
  if [[ "${_purge,,}" != "y" ]]; then
    print_current_deploy_info
    exit 0
  fi
  do_purge
}

# ── 环境预检 ──────────────────────────────────────────────────────────────────

precheck_node() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  VPN 节点部署 — 环境预检"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  local ERRORS=0 WARNINGS=0 TO_INSTALL=()

  if [[ "$(id -u)" -ne 0 ]]; then
    fail "需要 root 权限"; exit 1
  fi
  ok "root 权限"

  # OS 检测
  OS_ID="unknown"; OS_VERSION="0"; PKG=""
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="$ID"; OS_VERSION="${VERSION_ID:-0}"
  fi
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then PKG="yum"
  fi

  echo "  系统: ${PRETTY_NAME:-$OS_ID $OS_VERSION}  包管理器: ${PKG:-无}"

  case "$OS_ID" in
    ubuntu)
      case "${OS_VERSION%%.*}" in
        20|22|24) ok "Ubuntu $OS_VERSION 受支持" ;;
        *) warn "Ubuntu $OS_VERSION 未经测试"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    debian)
      case "${OS_VERSION%%.*}" in
        11|12) ok "Debian $OS_VERSION 受支持" ;;
        *) warn "Debian $OS_VERSION 未经测试"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    centos|rocky|almalinux|rhel)
      case "${OS_VERSION%%.*}" in
        8|9) ok "$OS_ID $OS_VERSION 受支持" ;;
        *) warn "$OS_ID $OS_VERSION 未经测试"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    *) warn "未识别: $OS_ID"; WARNINGS=$((WARNINGS+1)) ;;
  esac

  [[ -z "$PKG" ]] && { fail "无包管理器"; ERRORS=$((ERRORS+1)); }

  # 逐项检查
  echo ""
  log "检查依赖项 ..."

  for cmd in curl jq; do
    if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; else fail "$cmd 未安装"; TO_INSTALL+=("$cmd"); fi
  done

  for cmd in openvpn wg ipset iptables; do
    local pkg="$cmd"
    [[ "$cmd" == "wg" ]] && pkg="wireguard-tools"
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd ($(command -v "$cmd"))"
    else
      warn "$cmd 未安装，将自动安装 $pkg"
      TO_INSTALL+=("$pkg")
    fi
  done

  if command -v easyrsa >/dev/null 2>&1 || [[ -f /usr/share/easy-rsa/easyrsa ]] || [[ -f /usr/share/easy-rsa/3/easyrsa ]]; then
    ok "easy-rsa"
  else
    warn "easy-rsa 未安装，将自动安装或下载"
    TO_INSTALL+=("easy-rsa")
  fi

  if command -v dnsmasq >/dev/null 2>&1; then
    ok "dnsmasq"
  else
    warn "dnsmasq 未安装 (域名分流需要)，将自动安装"
    TO_INSTALL+=("dnsmasq")
  fi

  # 网络连通性
  echo ""
  log "检查网络 ..."
  if curl -sf --max-time 5 "$API_URL/api/health" >/dev/null 2>&1; then
    ok "控制面可达: $API_URL"
  else
    fail "无法连接控制面: $API_URL"
    ERRORS=$((ERRORS+1))
  fi

  detect_host_firewall_precheck

  # 端口：注册前无法获知控制面下发的监听端口；注册成功后将按 bootstrap JSON 再检一次
  echo ""
  log "监听端口占用检查将在节点注册成功后，按控制面下发的实例端口执行（并在启动阶段按冲突策略处理）。"

  # IP 转发
  local fwd="$(sysctl -n net.ipv4.ip_forward 2>/dev/null)"
  if [[ "$fwd" == "1" ]]; then
    ok "IP 转发已启用"
  else
    warn "IP 转发未启用，将自动开启"
  fi

  # 汇总
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  if [[ "$ERRORS" -gt 0 ]]; then
    echo -e "  ${RED}错误: $ERRORS${NC}  ${YELLOW}警告: $WARNINGS${NC}"
    echo -e "  ${RED}存在阻塞性错误，无法继续。${NC}"
    exit 1
  fi

  if [[ ${#TO_INSTALL[@]} -gt 0 ]]; then
    echo "  需要安装: ${TO_INSTALL[*]}"
  fi
  echo -e "  ${GREEN}错误: 0${NC}  ${YELLOW}警告: $WARNINGS${NC}"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
}

resolve_args_or_menu
maybe_reinstall_on_deployed
precheck_node

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "=== DRY-RUN MODE (will NOT register with API) ==="
  log "Step 1: Register node with control plane"
  log "Step 2: Install openvpn wireguard-tools ipset easy-rsa jq"
  log "Step 3: Init easy-rsa PKI"
  log "Step 4: Render server.conf files"
  log "Step 5: Deploy WireGuard tunnels"
  log "Step 6: Configure policy routing tables"
  log "Step 7: Configure NAT rules (iptables + ipset china-ip)"
  log "Step 8: Create systemd units"
  log "Step 9: Install vpn-agent"
  log "Done (dry-run). Use --apply to execute."
  exit 0
fi

# ── Step 1: Register with control plane ──────────────────────────────────────

command -v jq >/dev/null 2>&1 || {
  log "jq not found, installing ..."
  apt-get update -qq 2>/dev/null && apt-get install -y -qq jq 2>/dev/null || \
  dnf install -y jq 2>/dev/null || yum install -y jq 2>/dev/null || true
}

log "Step 1/${TOTAL_STEPS}: Registering node ..."
REG_TMP="${TMPDIR:-/tmp}/vpn-node-register-$$.json"
HTTP_CODE="$(curl -sS -o "$REG_TMP" -w "%{http_code}" -X POST \
  -H "X-Node-Token: $NODE_TOKEN" \
  "$API_URL/api/agent/register")" || {
  echo "无法连接控制面: $API_URL" >&2
  rm -f "$REG_TMP"
  exit 1
}
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "" >&2
  echo "节点注册失败 (HTTP $HTTP_CODE)。" >&2
  if command -v jq >/dev/null 2>&1 && jq -e . "$REG_TMP" >/dev/null 2>&1; then
    jq -r '.error // .' "$REG_TMP" >&2
  else
    cat "$REG_TMP" >&2
  fi
  echo "" >&2
  if [[ "$HTTP_CODE" == "403" ]]; then
    echo "说明：Bootstrap Token 为一次性令牌，某次成功注册后即失效。" >&2
    echo "请在管理后台对该节点「轮换 Bootstrap Token」，用新令牌重新执行本脚本（--token 新值）。" >&2
  elif [[ "$HTTP_CODE" == "401" ]]; then
    echo "说明：令牌无效或错误，请从控制面复制当前节点最新的 Bootstrap Token。" >&2
  fi
  rm -f "$REG_TMP"
  exit 1
fi
NODE_JSON="$(cat "$REG_TMP")"
rm -f "$REG_TMP"

[[ -z "$NODE_JSON" ]] && { echo "Empty register response"; exit 1; }

NODE_ID="$(echo "$NODE_JSON" | jq -r '.node_id')"
NODE_NUMBER="$(echo "$NODE_JSON" | jq -r '.node_number')"
PUBLIC_IP="$(echo "$NODE_JSON" | jq -r '.public_ip')"
INSTANCE_COUNT="$(echo "$NODE_JSON" | jq '.instances | length')"
TUNNEL_COUNT="$(echo "$NODE_JSON" | jq '.tunnels | length')"

log "  Node ID:     $NODE_ID"
log "  Node Number: $NODE_NUMBER"
log "  Public IP:   $PUBLIC_IP"
log "  Instances:   $INSTANCE_COUNT"
log "  Tunnels:     $TUNNEL_COUNT"

prompt_openvpn_proto_interactive
apply_openvpn_proto_override_to_node_json

mkdir -p /etc/vpn-agent
echo "$NODE_JSON" > /etc/vpn-agent/bootstrap-node.json

if ! check_instance_ports_from_bootstrap_json "$NODE_JSON"; then
  fail "端口冲突处理未完成，已中止部署。请按提示清理后重试。"
  exit 1
fi
if should_apply_host_firewall_open; then
  if ! apply_host_firewall_open "/etc/vpn-agent/bootstrap-node.json"; then
    fail "本机防火墙放行失败，已中止部署。"
    exit 1
  fi
  if ! verify_host_firewall_rules "/etc/vpn-agent/bootstrap-node.json"; then
    fail "本机防火墙规则验收失败，已中止部署。"
    exit 1
  fi
else
  warn "本机防火墙自动放行未启用（mode=${OPEN_HOST_FIREWALL_MODE}）；若防火墙已启用请手动放行。"
fi

# ── Step 2: Install packages ─────────────────────────────────────────────────

log "Step 2/${TOTAL_STEPS}: Installing packages ..."

install_easyrsa_manual() {
  local VER="3.2.1"
  curl -fsSL "https://github.com/OpenVPN/easy-rsa/releases/download/v${VER}/EasyRSA-${VER}.tgz" \
    -o /tmp/easyrsa.tgz
  mkdir -p /etc/openvpn/server/easy-rsa
  tar xzf /tmp/easyrsa.tgz --strip-components=1 -C /etc/openvpn/server/easy-rsa
  rm -f /tmp/easyrsa.tgz
}

CORE_PKGS="openvpn wireguard-tools ipset iptables jq curl dnsmasq"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq $CORE_PKGS
  apt-get install -y -qq easy-rsa 2>/dev/null || install_easyrsa_manual
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y epel-release 2>/dev/null || true
  dnf install -y $CORE_PKGS easy-rsa
elif command -v yum >/dev/null 2>&1; then
  yum install -y epel-release 2>/dev/null || true
  yum install -y $CORE_PKGS easy-rsa
else
  echo "Unsupported package manager"; exit 1
fi

mkdir -p /etc/dnsmasq.d
systemctl enable dnsmasq 2>/dev/null || true
systemctl start dnsmasq 2>/dev/null || true

# ── Step 3: Initialize easy-rsa PKI ──────────────────────────────────────────

log "Step 3/${TOTAL_STEPS}: Initializing easy-rsa PKI ..."

EASYRSA_DIR="/etc/openvpn/server/easy-rsa"
mkdir -p "$EASYRSA_DIR"

if [[ ! -f "$EASYRSA_DIR/easyrsa" ]]; then
  for src in /usr/share/easy-rsa/3 /usr/share/easy-rsa /usr/share/easy-rsa/3.0; do
    if [[ -f "$src/easyrsa" ]]; then
      cp -a "$src"/* "$EASYRSA_DIR/"
      break
    fi
  done
  if [[ ! -f "$EASYRSA_DIR/easyrsa" ]]; then
    log "  easy-rsa not found in system, downloading ..."
    install_easyrsa_manual
  fi
fi

export EASYRSA_BATCH=1

if [[ ! -f "$EASYRSA_DIR/pki/ca.crt" ]]; then
  cd "$EASYRSA_DIR"
  ./easyrsa init-pki
  ./easyrsa build-ca nopass
  ./easyrsa gen-crl
  log "  PKI initialized, CA created"
else
  log "  PKI already exists, skipping"
fi

SERVER_CN="server-${NODE_ID}"
if [[ ! -f "$EASYRSA_DIR/pki/issued/${SERVER_CN}.crt" ]]; then
  cd "$EASYRSA_DIR"
  ./easyrsa --days=3650 build-server-full "$SERVER_CN" nopass
  log "  Server cert issued: $SERVER_CN"
fi

if [[ ! -f "$EASYRSA_DIR/pki/dh.pem" ]]; then
  cd "$EASYRSA_DIR"
  ./easyrsa gen-dh
  log "  DH params generated"
fi

if [[ ! -f "$EASYRSA_DIR/pki/private/easyrsa-tls.key" ]]; then
  mkdir -p "$EASYRSA_DIR/pki/private"
  openvpn --genkey secret "$EASYRSA_DIR/pki/private/easyrsa-tls.key" 2>/dev/null || \
  openvpn --genkey tls-crypt-v2-server "$EASYRSA_DIR/pki/private/easyrsa-tls.key" 2>/dev/null || {
    log "  WARNING: could not generate TLS key, creating placeholder"
    head -c 256 /dev/urandom | base64 > "$EASYRSA_DIR/pki/private/easyrsa-tls.key"
  }
  log "  TLS key generated"
fi

# ── Step 4: Render per-instance OpenVPN server.conf ──────────────────────────

log "Step 4/${TOTAL_STEPS}: Rendering OpenVPN server configs ..."

PKI="$EASYRSA_DIR/pki"
mkdir -p /var/log/openvpn

# management 端口按 mode 固定（56730–56733），与 vpn-agent countOnlineUsers 一致，不依赖 instances JSON 顺序
mgmt_port_for_mode() {
  local m="$1" idx="$2"
  case "$m" in
    local-only) echo $((56730 + 0)) ;;
    hk-smart-split) echo $((56730 + 1)) ;;
    hk-global) echo $((56730 + 2)) ;;
    us-global) echo $((56730 + 3)) ;;
    *)
      echo $((56730 + idx))
      log "  WARNING: unknown mode $m for management port, fallback 56730+$idx"
      ;;
  esac
}

for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
  MODE="$(echo "$NODE_JSON" | jq -r ".instances[$i].mode")"
  INST_EN="$(echo "$NODE_JSON" | jq -r ".instances[$i].enabled // true")"
  if [[ "$INST_EN" == "false" ]]; then
    log "  Skip OpenVPN ${MODE:-?} (instance disabled in control plane)"
    continue
  fi
  PORT="$(echo "$NODE_JSON" | jq -r ".instances[$i].port")"
  SUBNET="$(echo "$NODE_JSON" | jq -r ".instances[$i].subnet")"
  RAW_PROTO="$(echo "$NODE_JSON" | jq -r ".instances[$i].proto // \"udp\"")"
  RAW_PROTO="$(echo "$RAW_PROTO" | tr '[:upper:]' '[:lower:]')"
  if [[ "$RAW_PROTO" == "tcp" ]]; then
    OVPN_PROTO="tcp"
  else
    OVPN_PROTO="udp"
  fi
  SUBNET_IP="${SUBNET%/*}"

  CONF_DIR="/etc/openvpn/server/${MODE}"
  mkdir -p "$CONF_DIR"

  MGMT_PORT="$(mgmt_port_for_mode "$MODE" "$i")"

  cat > "$CONF_DIR/server.conf" <<OVPN
port ${PORT}
proto ${OVPN_PROTO}
dev tun-${MODE}
dev-type tun

ca ${PKI}/ca.crt
cert ${PKI}/issued/${SERVER_CN}.crt
key ${PKI}/private/${SERVER_CN}.key
dh ${PKI}/dh.pem
crl-verify ${PKI}/crl.pem
tls-crypt ${PKI}/private/easyrsa-tls.key

server ${SUBNET_IP} 255.255.255.0
ifconfig-pool-persist /var/log/openvpn/${MODE}-ipp.txt

push "dhcp-option DNS 8.8.8.8"
push "dhcp-option DNS 1.1.1.1"

keepalive 10 120
cipher AES-256-GCM
auth SHA512
persist-key
persist-tun
status /var/log/openvpn/${MODE}-status.log
log-append /var/log/openvpn/${MODE}.log
verb 3
OVPN
  if [[ "$OVPN_PROTO" == "udp" ]]; then
    echo "explicit-exit-notify 1" >> "$CONF_DIR/server.conf"
  fi
  cat >> "$CONF_DIR/server.conf" <<OVPN
management 127.0.0.1 ${MGMT_PORT}
OVPN

  echo 'push "redirect-gateway def1 bypass-dhcp"' >> "$CONF_DIR/server.conf"

  log "  Created $CONF_DIR/server.conf (mode=$MODE port=$PORT proto=$OVPN_PROTO mgmt=$MGMT_PORT subnet=$SUBNET)"
done

# ── Step 5: Deploy WireGuard backbone tunnels ────────────────────────────────

log "Step 5/${TOTAL_STEPS}: Deploying WireGuard tunnels ..."

WG_PRIVKEY="/etc/wireguard/privatekey"
WG_PUBKEY="/etc/wireguard/publickey"

if [[ ! -f "$WG_PRIVKEY" ]]; then
  mkdir -p /etc/wireguard
  wg genkey > "$WG_PRIVKEY"
  chmod 600 "$WG_PRIVKEY"
  wg pubkey < "$WG_PRIVKEY" > "$WG_PUBKEY"
  log "  WireGuard keypair generated"

  curl -fsSL -X POST \
    -H "X-Node-Token: $NODE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"wg_pubkey\":\"$(cat "$WG_PUBKEY")\"}" \
    "$API_URL/api/agent/report" || true
  log "  WG public key reported to control plane"
fi

LOCAL_PRIVKEY="$(cat "$WG_PRIVKEY")"

for i in $(seq 0 $((TUNNEL_COUNT - 1))); do
  PEER_ID="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_node_id")"
  PEER_ENDPOINT="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_endpoint")"
  PEER_PUBKEY="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_pubkey")"
  LOCAL_IP="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].local_ip")"
  PEER_IP="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_ip")"
  WG_PORT="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].wg_port")"
  ALLOWED_IPS="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].allowed_ips")"

  WG_CONF="/etc/wireguard/wg-${PEER_ID}.conf"

  if [[ "$i" -eq 0 ]]; then
    LISTEN_LINE="ListenPort = ${WG_PORT}"
  else
    LISTEN_LINE="# ListenPort auto (avoid conflict with first tunnel)"
  fi

  cat > "$WG_CONF" <<WGCONF
[Interface]
PrivateKey = ${LOCAL_PRIVKEY}
Address = ${LOCAL_IP}/30
${LISTEN_LINE}
Table = off

[Peer]
PublicKey = ${PEER_PUBKEY}
Endpoint = ${PEER_ENDPOINT}:${WG_PORT}
AllowedIPs = ${ALLOWED_IPS}
PersistentKeepalive = 25
WGCONF

  chmod 600 "$WG_CONF"
  systemctl enable "wg-quick@wg-${PEER_ID}" 2>/dev/null || true
  systemctl start "wg-quick@wg-${PEER_ID}" 2>/dev/null || \
    log "  WARNING: wg-${PEER_ID} failed to start (peer may not be ready yet)"
  log "  Tunnel wg-${PEER_ID}: ${LOCAL_IP} <-> ${PEER_IP} via ${PEER_ENDPOINT}"
done

if [[ -f "$WG_PUBKEY" ]]; then
  curl -fsSL -X POST \
    -H "X-Node-Token: $NODE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"wg_pubkey\":\"$(cat "$WG_PUBKEY")\"}" \
    "$API_URL/api/agent/report" || true
  log "  WG public key reported to control plane (after tunnels up)"
fi

# ── Step 6: Configure policy routing ─────────────────────────────────────────

log "Step 6/${TOTAL_STEPS}: Configuring policy routing ..."

sysctl -w net.ipv4.ip_forward=1
grep -q "^net.ipv4.ip_forward" /etc/sysctl.conf 2>/dev/null || \
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf

cat > /etc/vpn-agent/policy-routing.sh <<'POLROUTE'
#!/bin/bash
set -euo pipefail

NODE_JSON_FILE="/etc/vpn-agent/bootstrap-node.json"
[[ ! -f "$NODE_JSON_FILE" ]] && exit 0

INSTANCE_COUNT="$(jq '.instances | length' "$NODE_JSON_FILE")"
TUNNEL_COUNT="$(jq '.tunnels | length' "$NODE_JSON_FILE")"

PEER_MAP_DIR="$(mktemp -d)"
trap "rm -rf $PEER_MAP_DIR" EXIT

for t in $(seq 0 $((TUNNEL_COUNT - 1))); do
  PEER_ID="$(jq -r ".tunnels[$t].peer_node_id" "$NODE_JSON_FILE")"
  PEER_IP="$(jq -r ".tunnels[$t].peer_ip" "$NODE_JSON_FILE")"
  echo "$PEER_IP" > "$PEER_MAP_DIR/$PEER_ID"
done

get_peer_ip() {
  local name="$1"
  for f in "$PEER_MAP_DIR"/*; do
    local bn="$(basename "$f")"
    if [[ "$bn" == "$name" ]]; then
      cat "$f"
      return
    fi
  done
  echo ""
}

# 在 tunnels 里找第一个 peer_node_id 匹配 id1 或 id2 的 wg 设备名（id2 可为空）
pick_wg_dev() {
  local id1="$1"
  local id2="${2:-}"
  for t in $(seq 0 $((TUNNEL_COUNT - 1))); do
    local pid
    pid="$(jq -r ".tunnels[$t].peer_node_id" "$NODE_JSON_FILE")"
    if [[ -n "$id1" && "$pid" == "$id1" ]]; then echo "wg-${pid}"; return; fi
    if [[ -n "$id2" && "$pid" == "$id2" ]]; then echo "wg-${pid}"; return; fi
  done
  echo ""
}

TABLE_NUM=100

for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
  INST_EN="$(jq -r ".instances[$i].enabled // true" "$NODE_JSON_FILE")"
  if [[ "$INST_EN" == "false" ]]; then
    continue
  fi

  MODE="$(jq -r ".instances[$i].mode" "$NODE_JSON_FILE")"
  SUBNET="$(jq -r ".instances[$i].subnet" "$NODE_JSON_FILE")"
  EXIT_NODE="$(jq -r ".instances[$i].exit_node // \"\"" "$NODE_JSON_FILE")"
  [[ "$EXIT_NODE" == "null" ]] && EXIT_NODE=""

  case "$MODE" in
    local-only)
      # 无 exit_node：走主机默认路由 + NAT SNAT 到本机 WAN（不建策略表）
      if [[ -z "$EXIT_NODE" ]]; then
        continue
      fi
      TABLE_NUM=$((TABLE_NUM + 1))
      PEER_IP="$(get_peer_ip "$EXIT_NODE")"
      [[ -z "$PEER_IP" ]] && { echo "No tunnel peer for local-only exit_node=$EXIT_NODE"; continue; }
      PEER_DEV="$(pick_wg_dev "$EXIT_NODE" "")"
      [[ -z "$PEER_DEV" ]] && { echo "No wg dev for local-only exit_node=$EXIT_NODE"; continue; }

      grep -q "^${TABLE_NUM} " /etc/iproute2/rt_tables 2>/dev/null || \
        echo "${TABLE_NUM} vpn_local_exit" >> /etc/iproute2/rt_tables

      ip route flush table $TABLE_NUM 2>/dev/null || true
      ip route add default via "$PEER_IP" dev "$PEER_DEV" table $TABLE_NUM 2>/dev/null || true

      ip rule del from "$SUBNET" lookup $TABLE_NUM 2>/dev/null || true
      ip rule add from "$SUBNET" lookup $TABLE_NUM prio 100
      echo "local-only+exit table $TABLE_NUM: all->$PEER_IP ($PEER_DEV) exit_node=$EXIT_NODE"
      ;;
    hk-smart-split)
      TABLE_NUM=$((TABLE_NUM + 1))
      if [[ -n "$EXIT_NODE" ]]; then
        HK_IP="$(get_peer_ip "$EXIT_NODE")"
      else
        HK_IP="$(get_peer_ip hongkong)"; [[ -z "$HK_IP" ]] && HK_IP="$(get_peer_ip hong-kong)"
      fi
      [[ -z "$HK_IP" ]] && { echo "No HK tunnel found for smart-split (exit_node=${EXIT_NODE:-legacy})"; continue; }

      if [[ -n "$EXIT_NODE" ]]; then
        HK_DEV="$(pick_wg_dev "$EXIT_NODE" "")"
      else
        HK_DEV="$(pick_wg_dev "hongkong" "hong-kong")"
      fi

      grep -q "^${TABLE_NUM} " /etc/iproute2/rt_tables 2>/dev/null || \
        echo "${TABLE_NUM} vpn_hk_split" >> /etc/iproute2/rt_tables

      ip route flush table $TABLE_NUM 2>/dev/null || true
      ip route add default via "$HK_IP" dev "$HK_DEV" table $TABLE_NUM 2>/dev/null || true

      LOCAL_GW="$(ip route show default | awk '{print $3; exit}')"
      LOCAL_DEV="$(ip route show default | awk '{print $5; exit}')"

      if [[ -f /etc/vpn-agent/cn-ip-list.txt ]]; then
        while IFS= read -r cidr; do
          [[ -z "$cidr" || "$cidr" == \#* ]] && continue
          ip route add "$cidr" via "$LOCAL_GW" dev "$LOCAL_DEV" table $TABLE_NUM 2>/dev/null || true
        done < /etc/vpn-agent/cn-ip-list.txt
      fi

      ip rule del from "$SUBNET" lookup $TABLE_NUM 2>/dev/null || true
      ip rule add from "$SUBNET" lookup $TABLE_NUM prio 100
      echo "smart-split table $TABLE_NUM: CN->local, rest->$HK_IP ($HK_DEV) exit_node=${EXIT_NODE:-legacy}"
      ;;
    hk-global)
      TABLE_NUM=$((TABLE_NUM + 1))
      if [[ -n "$EXIT_NODE" ]]; then
        HK_IP="$(get_peer_ip "$EXIT_NODE")"
      else
        HK_IP="$(get_peer_ip hongkong)"; [[ -z "$HK_IP" ]] && HK_IP="$(get_peer_ip hong-kong)"
      fi
      [[ -z "$HK_IP" ]] && { echo "No HK tunnel for hk-global (exit_node=${EXIT_NODE:-legacy})"; continue; }

      if [[ -n "$EXIT_NODE" ]]; then
        HK_DEV="$(pick_wg_dev "$EXIT_NODE" "")"
      else
        HK_DEV="$(pick_wg_dev "hongkong" "hong-kong")"
      fi

      grep -q "^${TABLE_NUM} " /etc/iproute2/rt_tables 2>/dev/null || \
        echo "${TABLE_NUM} vpn_hk_global" >> /etc/iproute2/rt_tables

      ip route flush table $TABLE_NUM 2>/dev/null || true
      ip route add default via "$HK_IP" dev "$HK_DEV" table $TABLE_NUM 2>/dev/null || true

      ip rule del from "$SUBNET" lookup $TABLE_NUM 2>/dev/null || true
      ip rule add from "$SUBNET" lookup $TABLE_NUM prio 100
      echo "hk-global table $TABLE_NUM: all->$HK_IP ($HK_DEV) exit_node=${EXIT_NODE:-legacy}"
      ;;
    us-global)
      TABLE_NUM=$((TABLE_NUM + 1))
      if [[ -n "$EXIT_NODE" ]]; then
        US_IP="$(get_peer_ip "$EXIT_NODE")"
      else
        US_IP="$(get_peer_ip usa)"; [[ -z "$US_IP" ]] && US_IP="$(get_peer_ip us)"
      fi
      [[ -z "$US_IP" ]] && { echo "No US tunnel for us-global (exit_node=${EXIT_NODE:-legacy})"; continue; }

      if [[ -n "$EXIT_NODE" ]]; then
        US_DEV="$(pick_wg_dev "$EXIT_NODE" "")"
      else
        US_DEV="$(pick_wg_dev "usa" "us")"
      fi

      grep -q "^${TABLE_NUM} " /etc/iproute2/rt_tables 2>/dev/null || \
        echo "${TABLE_NUM} vpn_us_global" >> /etc/iproute2/rt_tables

      ip route flush table $TABLE_NUM 2>/dev/null || true
      ip route add default via "$US_IP" dev "$US_DEV" table $TABLE_NUM 2>/dev/null || true

      ip rule del from "$SUBNET" lookup $TABLE_NUM 2>/dev/null || true
      ip rule add from "$SUBNET" lookup $TABLE_NUM prio 100
      echo "us-global table $TABLE_NUM: all->$US_IP ($US_DEV) exit_node=${EXIT_NODE:-legacy}"
      ;;
  esac
done
POLROUTE
chmod +x /etc/vpn-agent/policy-routing.sh
bash /etc/vpn-agent/policy-routing.sh || log "  WARNING: policy routing setup incomplete (tunnels may not be ready)"

# ── Step 7: NAT / split-routing rules ────────────────────────────────────────

log "Step 7/${TOTAL_STEPS}: Configuring NAT rules ..."

ipset create china-ip hash:net -exist

CHINA_LIST="/tmp/china_ip_list.txt"
CHINA_LIST_URL_DEFAULT="https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt"
CHINA_LIST_URL_MIRROR="https://cdn.jsdelivr.net/gh/17mon/china_ip_list@master/china_ip_list.txt"

show_proxy_help() {
  log "  Proxy usage examples (for administrators):"
  log "    HTTP/HTTPS (no auth): export https_proxy=http://127.0.0.1:7890; export http_proxy=http://127.0.0.1:7890"
  log "    HTTP/HTTPS (user/pass): export https_proxy=http://user:password@127.0.0.1:7890; export http_proxy=http://user:password@127.0.0.1:7890"
  log "    SOCKS5 (no auth): export ALL_PROXY=socks5h://127.0.0.1:1080"
  log "    SOCKS5 (user/pass): export ALL_PROXY=socks5h://user:password@127.0.0.1:1080"
}

probe_url() {
  local url="$1"
  curl -fsI --connect-timeout 5 --max-time 8 "$url" >/dev/null 2>&1
}

download_china_list() {
  local url="$1"
  curl -fsSL --connect-timeout 8 --max-time 30 --retry 2 --retry-delay 1 "$url" -o "$CHINA_LIST" 2>/dev/null
}

DEFAULT_REACHABLE=0
MIRROR_REACHABLE=0
probe_url "$CHINA_LIST_URL_DEFAULT" && DEFAULT_REACHABLE=1
probe_url "$CHINA_LIST_URL_MIRROR" && MIRROR_REACHABLE=1

if [[ "$DEFAULT_REACHABLE" -eq 1 && "$MIRROR_REACHABLE" -eq 1 ]]; then
  log "  Both default and CN mirror are reachable; if downloads are unstable, consider using a proxy."
  show_proxy_help
fi

if download_china_list "$CHINA_LIST_URL_DEFAULT"; then
  log "  china_ip_list downloaded from default source"
elif download_china_list "$CHINA_LIST_URL_MIRROR"; then
  log "  default source unavailable, switched to CN mirror"
else
  log "  WARNING: could not download china_ip_list from default or CN mirror"
  show_proxy_help
fi

if [[ -s "$CHINA_LIST" ]]; then
  while IFS= read -r cidr; do
    [[ -z "$cidr" || "$cidr" == \#* ]] && continue
    ipset add china-ip "$cidr" -exist
  done < "$CHINA_LIST"
  cp "$CHINA_LIST" /etc/vpn-agent/cn-ip-list.txt
  rm -f "$CHINA_LIST"
  log "  china-ip ipset loaded"
else
  rm -f "$CHINA_LIST"
  log "  WARNING: china_ip_list is empty, skipped ipset population"
fi

cat > /etc/vpn-agent/nat-rules.sh <<'NATRULES'
#!/bin/bash
set -euo pipefail

DEFAULT_IF="$(ip route show default | awk '/default/ {print $5; exit}')"
[[ -z "$DEFAULT_IF" ]] && DEFAULT_IF="eth0"
LOCAL_IP="$(ip -4 addr show "$DEFAULT_IF" | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)"

iptables -t nat -F VPN_POSTROUTING 2>/dev/null || iptables -t nat -N VPN_POSTROUTING
iptables -t nat -C POSTROUTING -j VPN_POSTROUTING 2>/dev/null || \
  iptables -t nat -A POSTROUTING -j VPN_POSTROUTING

iptables -F VPN_FORWARD 2>/dev/null || iptables -N VPN_FORWARD
iptables -C FORWARD -j VPN_FORWARD 2>/dev/null || \
  iptables -I FORWARD -j VPN_FORWARD

NODE_JSON_FILE="/etc/vpn-agent/bootstrap-node.json"
[[ ! -f "$NODE_JSON_FILE" ]] && exit 0

INSTANCE_COUNT="$(jq '.instances | length' "$NODE_JSON_FILE")"

for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
  INST_EN="$(jq -r ".instances[$i].enabled // true" "$NODE_JSON_FILE")"
  if [[ "$INST_EN" == "false" ]]; then
    continue
  fi

  MODE="$(jq -r ".instances[$i].mode" "$NODE_JSON_FILE")"
  SUBNET="$(jq -r ".instances[$i].subnet" "$NODE_JSON_FILE")"
  EXIT_NODE="$(jq -r ".instances[$i].exit_node // \"\"" "$NODE_JSON_FILE")"
  [[ "$EXIT_NODE" == "null" ]] && EXIT_NODE=""

  iptables -A VPN_FORWARD -s "$SUBNET" -j ACCEPT
  iptables -A VPN_FORWARD -d "$SUBNET" -m state --state RELATED,ESTABLISHED -j ACCEPT

  case "$MODE" in
    local-only)
      if [[ -z "$EXIT_NODE" ]]; then
        iptables -t nat -A VPN_POSTROUTING -s "$SUBNET" -o "$DEFAULT_IF" -j SNAT --to-source "$LOCAL_IP"
      else
        iptables -t nat -A VPN_POSTROUTING -s "$SUBNET" -j MASQUERADE
      fi
      ;;
    *-smart-split)
      iptables -t nat -A VPN_POSTROUTING -s "$SUBNET" -m set --match-set china-ip dst -j SNAT --to-source "$LOCAL_IP"
      iptables -t nat -A VPN_POSTROUTING -s "$SUBNET" -j MASQUERADE
      ;;
    *-global)
      iptables -t nat -A VPN_POSTROUTING -s "$SUBNET" -j MASQUERADE
      ;;
  esac
done

TUNNEL_COUNT="$(jq '.tunnels | length' "$NODE_JSON_FILE")"
for t in $(seq 0 $((TUNNEL_COUNT - 1))); do
  PEER_ID="$(jq -r ".tunnels[$t].peer_node_id" "$NODE_JSON_FILE")"
  iptables -A VPN_FORWARD -i "wg-${PEER_ID}" -j ACCEPT
  iptables -A VPN_FORWARD -o "wg-${PEER_ID}" -j ACCEPT
done
NATRULES
chmod +x /etc/vpn-agent/nat-rules.sh
bash /etc/vpn-agent/nat-rules.sh || log "  WARNING: NAT rules apply failed"

log "  NAT rules configured"

# ── Step 8: Systemd service units ────────────────────────────────────────────

log "Step 8/${TOTAL_STEPS}: Creating systemd services ..."
cleanup_legacy_openvpn_units

FAILED_OPENVPN_MODES=()
SKIPPED_OPENVPN_MODES=()

for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
  MODE="$(echo "$NODE_JSON" | jq -r ".instances[$i].mode")"
  INST_EN="$(echo "$NODE_JSON" | jq -r ".instances[$i].enabled // true")"
  if [[ "$INST_EN" == "false" ]]; then
    systemctl disable --now "openvpn-${MODE}.service" 2>/dev/null || true
    log "  OpenVPN ${MODE} left stopped (instance disabled)"
    continue
  fi

  cat > "/etc/systemd/system/openvpn-${MODE}.service" <<UNIT
[Unit]
Description=OpenVPN instance - ${MODE}
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/sbin/openvpn --config /etc/openvpn/server/${MODE}/server.conf
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  if start_openvpn_mode_with_health_check "$MODE"; then
    log "  Service openvpn-${MODE} enabled"
  else
    rc="$?"
    if [[ "$rc" -eq 2 ]]; then
      systemctl disable --now "openvpn-${MODE}.service" 2>/dev/null || true
      SKIPPED_OPENVPN_MODES+=("$MODE")
      warn "  Service openvpn-${MODE} skipped by administrator decision"
    else
      FAILED_OPENVPN_MODES+=("$MODE")
    fi
  fi
done

if [[ "${#FAILED_OPENVPN_MODES[@]}" -gt 0 ]]; then
  fail "OpenVPN services failed for mode(s): ${FAILED_OPENVPN_MODES[*]}"
  echo "请先处理上方冲突/日志错误后重试 node-setup.sh --apply" >&2
  exit 1
fi

if [[ "${#SKIPPED_OPENVPN_MODES[@]}" -gt 0 ]]; then
  warn "以下实例已按管理员选择跳过，不会监听对应端口: ${SKIPPED_OPENVPN_MODES[*]}"
fi

cat > /etc/systemd/system/vpn-routing.service <<'UNIT'
[Unit]
Description=VPN NAT + Policy Routing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c '/etc/vpn-agent/policy-routing.sh && /etc/vpn-agent/nat-rules.sh'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable vpn-routing.service

# ── Step 9: Install vpn-agent ────────────────────────────────────────────────

log "Step 9/${TOTAL_STEPS}: Installing vpn-agent ..."

cat > /etc/vpn-agent/agent.json <<AGENTCFG
{
  "api_url": "${API_URL}",
  "node_token": "${NODE_TOKEN}",
  "node_id": "${NODE_ID}",
  "easyrsa_dir": "${EASYRSA_DIR}"
}
AGENTCFG

UNAME_M="$(uname -m)"
case "$UNAME_M" in
  x86_64)           AGENT_ARCH=amd64 ;;
  aarch64|arm64)    AGENT_ARCH=arm64 ;;
  *)                AGENT_ARCH=amd64; warn "unknown uname -m=$UNAME_M, trying amd64 agent" ;;
esac
AGENT_URL="${API_URL}/api/downloads/vpn-agent-linux-${AGENT_ARCH}"
AGENT_TMP="${TMPDIR:-/tmp}/vpn-agent.${AGENT_ARCH}.$$"
if curl -fSL "$AGENT_URL" -o "$AGENT_TMP"; then
  chmod +x "$AGENT_TMP"
  mv -f "$AGENT_TMP" /usr/local/bin/vpn-agent
  log "  vpn-agent refreshed from control plane ($AGENT_ARCH)"
else
  rm -f "$AGENT_TMP"
  log "  ERROR: could not download vpn-agent from $AGENT_URL"
  log "  Deployment requires the binary served at GET /api/downloads/vpn-agent-linux-${AGENT_ARCH} (next to vpn-api on the control plane)."
  log "  Or build and copy manually: GOOS=linux GOARCH=${AGENT_ARCH} go build -o /usr/local/bin/vpn-agent ./cmd/agent"
  exit 1
fi

cat > /etc/systemd/system/vpn-agent.service <<'UNIT'
[Unit]
Description=VPN Node Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/vpn-agent -config /etc/vpn-agent/agent.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable vpn-agent.service
systemctl restart vpn-agent.service || log "  WARNING: vpn-agent failed to start/restart"

if ! post_deploy_health_check "/etc/vpn-agent/bootstrap-node.json"; then
  exit 1
fi

# ── Done ─────────────────────────────────────────────────────────────────────

log "============================================"
log "Node setup completed!"
log "  Node ID:     $NODE_ID"
log "  Node Number: $NODE_NUMBER"
log "  Public IP:   $PUBLIC_IP"
log ""
log "OpenVPN instances:"
for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
  MODE="$(echo "$NODE_JSON" | jq -r ".instances[$i].mode")"
  INST_EN="$(echo "$NODE_JSON" | jq -r ".instances[$i].enabled // true")"
  PORT="$(echo "$NODE_JSON" | jq -r ".instances[$i].port")"
  P="$(echo "$NODE_JSON" | jq -r ".instances[$i].proto // \"udp\"" | tr '[:upper:]' '[:lower:]')"
  [[ "$P" != "tcp" ]] && P="udp"
  if [[ "$INST_EN" == "false" ]]; then
    log "  openvpn-${MODE} -> :${PORT}/${P} (disabled)"
  else
    log "  openvpn-${MODE} -> :${PORT}/${P}"
  fi
done
log ""
log "WireGuard tunnels:"
for i in $(seq 0 $((TUNNEL_COUNT - 1))); do
  PEER="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_node_id")"
  LIP="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].local_ip")"
  PIP="$(echo "$NODE_JSON" | jq -r ".tunnels[$i].peer_ip")"
  log "  wg-${PEER}: ${LIP} <-> ${PIP}"
done
log ""
log "Agent: WebSocket -> $API_URL"
print_external_firewall_reminder "$NODE_JSON"
log "============================================"
