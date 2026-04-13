#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# VPN 控制面一键部署脚本
# 用法：
#   bash deploy-control-plane.sh [--domain ...] [--source-dir ...] [--cwd-source] [--prefer-installed] [--skip-frontend] [--yes]
# ═══════════════════════════════════════════════════════════════════════════════

DOMAIN=""
SKIP_FRONTEND=0
AUTO_YES=0
# 1=优先使用 /opt/vpn-api 内已有源码（旧行为）；0=默认优先脚本所在检出目录
PREFER_INSTALLED=0
# 1=在通过校验时允许使用 $PWD 作为源码包根（须存在 $PWD/vpn-api/go.mod）
CWD_SOURCE=0
API_PORT="56700"
JWT_SECRET=""
FINAL_EXTERNAL_URL=""
# 管理台跨域来源（逗号分隔）；未传入时回退为 *，避免前后端分离场景预检 404
CORS_ALLOWED_ORIGINS="*"
INSTALL_DIR="/opt/vpn-api"
FRONTEND_DIR="/var/www/vpn-admin"
SOURCE_DIR=""
# 预检后由管理员决定：1=Phase 1 自动安装缺失依赖；0=已打印手动指引并 exit
AUTO_INSTALL_DEPS=1
# 预检汇总待装项（全局数组，供手动安装指引使用）
TO_INSTALL=()
# 命令行指定代理（Phase 1 开始时应用）；也可在失败提示里交互输入
CLI_HTTP_PROXY=""
CLI_SOCKS5=""
VPN_APT_PROXY_CONF="/etc/apt/apt.conf.d/98vpn-deploy-proxy.conf"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="${2:-}"; shift 2 ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --jwt-secret)    JWT_SECRET="${2:-}"; shift 2 ;;
    --cors-origins)  CORS_ALLOWED_ORIGINS="${2:-}"; shift 2 ;;
    --source-dir)    SOURCE_DIR="${2:-}"; shift 2 ;;
    --cwd-source)    CWD_SOURCE=1; shift ;;
    --prefer-installed) PREFER_INSTALLED=1; shift ;;
    --http-proxy)    CLI_HTTP_PROXY="${2:-}"; shift 2 ;;
    --socks5)        CLI_SOCKS5="${2:-}"; shift 2 ;;
    --yes|-y)        AUTO_YES=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: deploy-control-plane.sh [OPTIONS]

Options:
  --domain DOMAIN       可选：优先使用该域名作为 EXTERNAL_URL（https://DOMAIN）
  --skip-frontend       Skip Vue frontend build
  --jwt-secret SECRET   Set JWT secret (auto-generated if omitted)
  --cors-origins LIST   Set CORS_ALLOWED_ORIGINS (逗号分隔，默认 *)
  --source-dir DIR      指定源码包根目录（其下须有 vpn-api/go.mod，即含 vpn-api/、vpn-admin-web/ 的那一层）
  --cwd-source          仅当当前目录下存在 vpn-api/go.mod 时，将 PWD 作为候选源码根（cd 到 A 仓库却用他处脚本绝对路径时加此项）
  --prefer-installed    优先使用 /opt/vpn-api 内已有源码（旧行为）；升级覆盖时请勿加此项，或配合 --source-dir
  --http-proxy URL      安装依赖时使用 HTTP(S) 代理（apt/curl/wget；例 http://127.0.0.1:8080）
  --socks5 URL          SOCKS5 代理：推荐 socks5://用户:密码@主机:端口；无认证可 主机:端口（apt 对 SOCKS 支持有限）
  --yes, -y             Skip confirmation prompts（非交互保护会要求显式 --domain）
  -h, --help            Show this help

交互模式下若检测到缺失依赖，会先询问是否由脚本自动安装；选「否」将打印手动安装说明并退出。
网络失败时可交互设置代理并重试；非交互请使用 --http-proxy / --socks5（完整 URL）或事先 export 代理环境变量。
部署地址规则：--domain 优先为 https://DOMAIN。未指定时 Phase 4 会探测公网 IP（多服务回退）并显示来源；可纠正 IP；再询问域名（留空则使用 http://IP:API_PORT）。非交互且探测结果不可靠时请显式传 --domain。
USAGE
      exit 0 ;;
    *)               shift ;;
  esac
done

# 允许显式传空；最终统一回退到 *，避免 CORS 中间件未启用导致浏览器预检 404
[[ -z "${CORS_ALLOWED_ORIGINS}" ]] && CORS_ALLOWED_ORIGINS="*"

# ── 颜色和工具函数 ────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[1;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# 默认「同意」：空回车视为继续（与一键部署、confirm_auto_install_deps 的 [Y/n] 一致）
confirm() {
  if [[ "$AUTO_YES" -eq 1 ]]; then return 0; fi
  # 非交互 / 管道执行时 read 会得到空回答导致误判为「取消」，从而根本不会进入 Phase 1 安装依赖
  if [[ ! -t 0 ]]; then
    warn "检测到非交互 stdin（如 curl|bash、CI），自动继续部署。若需人工确认请在本机终端直接运行脚本，或加 --yes/-y。"
    return 0
  fi
  local msg="${1:-Continue?}"
  echo ""
  read -rp "$(echo -e "${YELLOW}${msg} [Y/n]${NC} ")" answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Nn] ]]; then
    return 1
  fi
  return 0
}

trim_space() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  echo "$s"
}

is_ipv4() {
  local ip="${1:-}"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS='.' read -r o1 o2 o3 o4 <<<"$ip"
  for o in "$o1" "$o2" "$o3" "$o4"; do
    [[ "$o" =~ ^[0-9]+$ ]] || return 1
    (( o >= 0 && o <= 255 )) || return 1
  done
  return 0
}

is_private_ipv4() {
  local ip="${1:-}"
  is_ipv4 "$ip" || return 1
  IFS='.' read -r o1 o2 _ _ <<<"$ip"
  if (( o1 == 10 || o1 == 127 )); then return 0; fi
  if (( o1 == 192 && o2 == 168 )); then return 0; fi
  if (( o1 == 172 && o2 >= 16 && o2 <= 31 )); then return 0; fi
  if (( o1 == 169 && o2 == 254 )); then return 0; fi
  return 1
}

is_valid_external_url() {
  local u
  u="$(trim_space "${1:-}")"
  [[ "$u" =~ ^https?://[^/]+$ ]]
}

build_external_url_from_input() {
  local raw
  raw="$(trim_space "${1:-}")"
  if [[ -z "$raw" ]]; then
    return 1
  fi
  raw="${raw%/}"
  if [[ "$raw" =~ ^https?:// ]]; then
    is_valid_external_url "$raw" || return 1
    echo "$raw"
    return 0
  fi
  if [[ "$raw" == */* ]]; then
    return 1
  fi
  if is_ipv4 "$raw"; then
    echo "http://${raw}:${API_PORT}"
    return 0
  fi
  if [[ "$raw" =~ ^[a-zA-Z0-9.-]+:[0-9]+$ ]]; then
    echo "http://${raw}"
    return 0
  fi
  if [[ "$raw" =~ [a-zA-Z] ]]; then
    echo "https://${raw}"
    return 0
  fi
  return 1
}

detect_public_ip() {
  local ip=""
  ip="$(curl -fsS --connect-timeout 3 --max-time 6 https://ifconfig.me/ip 2>/dev/null | tr -d '\r\n ' || true)"
  if is_ipv4 "$ip"; then
    echo "$ip|ifconfig.me/ip"
    return 0
  fi
  ip="$(curl -fsS --connect-timeout 3 --max-time 6 https://icanhazip.com 2>/dev/null | tr -d '\r\n ' || true)"
  if is_ipv4 "$ip"; then
    echo "$ip|icanhazip.com"
    return 0
  fi
  ip="$(curl -fsS --connect-timeout 3 --max-time 6 https://ipinfo.io/ip 2>/dev/null | tr -d '\r\n ' || true)"
  if is_ipv4 "$ip"; then
    echo "$ip|ipinfo.io/ip"
    return 0
  fi
  ip="$(hostname -I 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/) {print $i; exit}}' || true)"
  if is_ipv4 "$ip"; then
    echo "$ip|hostname -I"
    return 0
  fi
  return 1
}

resolve_external_url_value() {
  local domain_input=""
  local can_confirm=0
  if [[ -t 0 && "$AUTO_YES" -ne 1 ]]; then
    can_confirm=1
  fi

  if [[ -n "$DOMAIN" ]]; then
    FINAL_EXTERNAL_URL="https://${DOMAIN}"
    ok "使用命令行域名: ${FINAL_EXTERNAL_URL}"
    return 0
  fi

  local probe ip src candidate source_reliable working_ip

  if (( can_confirm == 1 )); then
    probe="$(detect_public_ip || true)"
    if [[ -z "$probe" ]]; then
      warn "自动探测公网 IP 失败，请输入控制面访问地址。"
      while true; do
        local manual=""
        read -rp "请输入公网 IP / 域名 / 完整 URL（含 https://）: " manual
        if FINAL_EXTERNAL_URL="$(build_external_url_from_input "$manual")"; then
          ok "已设置 EXTERNAL_URL: ${FINAL_EXTERNAL_URL}"
          return 0
        fi
        warn "输入无效，请重试（示例：vpn.example.com / 120.26.214.181 / https://vpn.example.com）"
      done
    fi
    ip="${probe%%|*}"
    src="${probe##*|}"
    ok "探测到公网 IP 候选：${ip}（来源：${src}）"
    source_reliable=1
    if [[ "$src" == "hostname -I" ]] || is_private_ipv4 "$ip"; then
      source_reliable=0
      warn "该地址可能不是公网直连（NAT/内网）。"
    fi
    if (( source_reliable == 0 )); then
      if ! confirm "仍以上述 IP 为基准继续（下一步可改为正确公网 IP）？"; then
        while true; do
          local manual=""
          read -rp "请输入控制面公网 IP / 域名 / 完整 URL: " manual
          if FINAL_EXTERNAL_URL="$(build_external_url_from_input "$manual")"; then
            ok "已设置 EXTERNAL_URL: ${FINAL_EXTERNAL_URL}"
            return 0
          fi
          warn "输入无效，请重试（示例：vpn.example.com / 120.26.214.181 / https://vpn.example.com）"
        done
      fi
    fi
    working_ip="$ip"
    while true; do
      local ip_fix=""
      read -rp "若上述 IP 不正确请输入正确公网 IPv4（留空表示接受）: " ip_fix
      ip_fix="$(trim_space "$ip_fix")"
      if [[ -z "$ip_fix" ]]; then
        break
      fi
      if is_ipv4 "$ip_fix"; then
        working_ip="$ip_fix"
        break
      fi
      warn "不是有效的 IPv4，请重试或留空接受 ${working_ip}"
    done
    read -rp "控制面域名（留空则使用 http://${working_ip}:${API_PORT}）: " domain_input
    domain_input="$(trim_space "$domain_input")"
    if [[ -n "$domain_input" ]]; then
      if ! FINAL_EXTERNAL_URL="$(build_external_url_from_input "$domain_input")"; then
        err "域名或地址格式无效：${domain_input}"
        return 1
      fi
      ok "已设置 EXTERNAL_URL: ${FINAL_EXTERNAL_URL}"
      return 0
    fi
    FINAL_EXTERNAL_URL="http://${working_ip}:${API_PORT}"
    ok "已设置 EXTERNAL_URL: ${FINAL_EXTERNAL_URL}"
    return 0
  fi

  probe="$(detect_public_ip || true)"
  if [[ -n "$probe" ]]; then
    ip="${probe%%|*}"
    src="${probe##*|}"
    candidate="http://${ip}:${API_PORT}"
    source_reliable=1
    if [[ "$src" == "hostname -I" ]] || is_private_ipv4 "$ip"; then
      source_reliable=0
      warn "自动探测得到的地址可能不是公网可达：${ip}（来源：${src}）"
    fi
    if (( source_reliable == 0 )); then
      err "非交互模式下无法确认自动探测地址（${candidate}）。请显式传 --domain。"
      return 1
    fi
    FINAL_EXTERNAL_URL="$candidate"
    warn "非交互模式自动采用探测地址：${FINAL_EXTERNAL_URL}"
    return 0
  fi

  err "非交互模式且未提供 --domain，同时自动探测公网 IP 失败。请显式传 --domain。"
  return 1
}

# 供 Phase 1 使用：precheck 已设置 PKG/ARCH；若单独调用或变量丢失则重新检测
detect_pkg_manager() {
  if [[ -n "${PKG:-}" ]]; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG="yum"
  fi
  [[ -n "${PKG:-}" ]]
}

# ── Phase 1 网络代理（apt / curl / wget）──────────────────────────────────────

clear_deploy_proxy() {
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
  rm -f "$VPN_APT_PROXY_CONF" 2>/dev/null || true
}

apply_http_proxy() {
  local u="$1"
  if [[ -z "$u" ]]; then
    err "apply_http_proxy: 空 URL"
    return 1
  fi
  clear_deploy_proxy
  export http_proxy="$u" https_proxy="$u" HTTP_PROXY="$u" HTTPS_PROXY="$u"
  if [[ -d /etc/apt/apt.conf.d ]]; then
    printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$u" "$u" > "$VPN_APT_PROXY_CONF"
  fi
}

apply_socks5_proxy() {
  local raw="${1:-}"
  # 去首尾空白
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  local url=""
  if [[ -z "$raw" ]]; then
    err "apply_socks5_proxy: 空地址"
    return 1
  fi
  clear_deploy_proxy
  if [[ "$raw" == socks5h://* ]]; then
    url="$raw"
  elif [[ "$raw" == socks5://* ]]; then
    url="socks5h://${raw#socks5://}"
  else
    # user:pass@host:port 或 host:port — 统一加 socks5h://（DNS 在代理侧解析）
    url="socks5h://${raw}"
  fi
  export ALL_PROXY="$url" all_proxy="$url"
  export https_proxy="$url" http_proxy="$url"
}

apply_cli_proxy_if_set() {
  if [[ -n "${CLI_HTTP_PROXY:-}" && -n "${CLI_SOCKS5:-}" ]]; then
    warn "同时指定了 --http-proxy 与 --socks5，将使用 --http-proxy"
  fi
  if [[ -n "${CLI_HTTP_PROXY:-}" ]]; then
    log "应用命令行 HTTP 代理 ..."
    apply_http_proxy "$CLI_HTTP_PROXY"
  elif [[ -n "${CLI_SOCKS5:-}" ]]; then
    log "应用命令行 SOCKS5 代理 ..."
    apply_socks5_proxy "$CLI_SOCKS5"
  fi
}

# 网络步骤失败时：交互选择代理并重试。返回 0=已更新可重试，1=放弃。
# 非交互（无 TTY）时提示使用 CLI / 环境变量并返回 1。
prompt_network_proxy_retry() {
  local ctx="$1"
  err "操作失败（${ctx}），可能是网络受限或需代理访问外网。"
  if [[ ! -t 0 ]]; then
    echo "  非交互环境：请使用 --http-proxy URL / --socks5 'socks5://用户:密码@主机:端口'，或事先 export:"
    echo "    export http_proxy=https://... https_proxy=https://...   # HTTP 代理"
    echo "    export ALL_PROXY=socks5h://user:pass@127.0.0.1:1080     # SOCKS5（与 curl 一致）"
    return 1
  fi
  echo ""
  echo "  1) 设置 HTTP/HTTPS 代理（apt / curl / wget 通用，推荐）"
  echo "  2) 设置 SOCKS5 代理（curl 下载 Go/Node；apt 对 SOCKS 支持有限，失败请改 HTTP 或镜像）"
  echo "  3) 清除代理后重试"
  echo "  4) 放弃退出"
  local c=""
  read -rp "请选择 [1-4] (默认 4): " c
  c="${c:-4}"
  case "$c" in
    1)
      local u=""
      read -rp "HTTP 代理 URL（例 http://127.0.0.1:8080 或 http://user:pass@host:8080）: " u
      [[ -z "${u:-}" ]] && { err "未输入"; return 1; }
      apply_http_proxy "$u"
      ok "已设置 HTTP(S) 代理，重试中 ..."
      return 0
      ;;
    2)
      local s=""
      echo "  推荐格式: socks5://账号:密码@IP或域名:端口  （无密码可: socks5://127.0.0.1:1080 或 127.0.0.1:1080）"
      echo "  若密码含 @ : % 等特殊字符，请先做 URL 编码后再写入 URL。"
      read -rp "SOCKS5 代理 URL: " s
      [[ -z "${s:-}" ]] && { err "未输入"; return 1; }
      apply_socks5_proxy "$s"
      warn "SOCKS5 已设置；若 apt 仍失败，请选 1 使用 HTTP 代理或配置国内镜像源。"
      return 0
      ;;
    3)
      clear_deploy_proxy
      ok "已清除代理，重试中 ..."
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Phase 3：判断 go mod tidy / go build 日志是否像拉模块或 toolchain 的网络错误（非普通编译语法错）
is_go_module_fetch_error() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  grep -qiE 'i/o timeout|dial tcp|connection refused|connection reset|TLS handshake timeout|no such host|temporary failure|context deadline exceeded|proxy\.golang\.org|golang\.org/toolchain|unexpected EOF|read: connection|server misbehaving|timeout awaiting|lookup .* on .*: .*timeout' "$f"
}

# Phase 3：模块/toolchain 下载失败时交互（HTTP / SOCKS5 / 清代理 / GOPROXY），与 Phase 1 共用 apply_*。返回 0=可重试，1=放弃。
prompt_go_build_network_retry() {
  err "Go 拉取模块或自动 toolchain 失败（常见于无法访问 proxy.golang.org）。"
  if [[ ! -t 0 ]]; then
    echo "  非交互环境请先 export 后重跑，例如："
    echo "    export GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct"
    echo "    export https_proxy=http://127.0.0.1:8080"
    echo "    export ALL_PROXY=socks5h://user:pass@127.0.0.1:1080"
    echo "  SOCKS5 URL 格式见: socks5://账号:密码@主机:端口"
    return 1
  fi
  echo ""
  echo "  1) 设置 HTTP/HTTPS 代理（Go 下载读 http_proxy/https_proxy，推荐反复失败时优先试）"
  echo "  2) 设置 SOCKS5 代理（格式: socks5://账号:密码@主机:端口）"
  echo "  3) 清除 Shell 代理环境变量后重试"
  echo "  4) 使用国内 GOPROXY 镜像链（goproxy.cn，无 HTTP 代理时常有效）"
  echo "  5) 放弃退出"
  local c=""
  read -rp "请选择 [1-5] (默认 5): " c
  c="${c:-5}"
  case "$c" in
    1)
      local u=""
      read -rp "HTTP 代理 URL（例 http://127.0.0.1:8080）: " u
      [[ -z "${u:-}" ]] && { err "未输入"; return 1; }
      apply_http_proxy "$u"
      ok "已设置 HTTP(S) 代理，重试编译 ..."
      return 0
      ;;
    2)
      local s=""
      echo "  推荐: socks5://账号:密码@IP或域名:端口"
      read -rp "SOCKS5 代理 URL: " s
      [[ -z "${s:-}" ]] && { err "未输入"; return 1; }
      apply_socks5_proxy "$s"
      ok "已设置 SOCKS5，重试编译 ..."
      return 0
      ;;
    3)
      clear_deploy_proxy
      ok "已清除代理，重试编译 ..."
      return 0
      ;;
    4)
      export GOPROXY="https://goproxy.cn,https://proxy.golang.org,direct"
      ok "已设置 GOPROXY=$GOPROXY ，重试编译 ..."
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 管理员拒绝自动安装时输出的手动指引（依据全局 TO_INSTALL / PKG）
print_manual_install_hints() {
  echo ""
  log "手动安装依赖（示例，请按需调整）"
  echo ""
  case "${PKG:-}" in
    apt)
      echo "  Debian/Ubuntu 示例："
      echo "    sudo apt-get update"
      echo "    sudo apt-get install -y curl wget git jq sqlite3 build-essential openvpn easy-rsa"
      ;;
    dnf|yum)
      echo "  RHEL/CentOS/Rocky 示例："
      echo "    sudo $PKG install -y epel-release || true"
      echo "    sudo $PKG install -y curl wget git jq sqlite gcc openvpn easy-rsa certbot"
      ;;
    *)
      echo "  请根据发行版安装：curl wget git jq sqlite3(或 sqlite)、build-essential(或 gcc)、openvpn、easy-rsa"
      ;;
  esac
  echo ""
  local need_go=0 need_node=0
  local p
  for p in "${TO_INSTALL[@]}"; do
    case "$p" in
      go|go-upgrade) need_go=1 ;;
      nodejs|node-upgrade|npm) need_node=1 ;;
    esac
  done
  [[ "$need_go" -eq 1 ]] && echo "  Go（>=1.21）：https://go.dev/dl/  下载 linux-amd64/arm64 包解压到 /usr/local/go，并 export PATH=\"/usr/local/go/bin:\$PATH\""
  [[ "$need_node" -eq 1 ]] && echo "  Node.js（>=16）与 npm：https://nodejs.org/  或 https://github.com/nodesource/distributions"
  echo ""
  echo "  安装完成后请在项目根目录重新执行，例如："
  echo "    sudo bash ./install.sh"
  echo "  若外网受限可加代理，例如："
  echo "    sudo bash ./install.sh --http-proxy 'http://127.0.0.1:8080'"
  echo "    sudo bash ./install.sh --socks5 'socks5://账号:密码@192.168.0.1:8000'"
  echo "  Phase 3 编译若拉模块/toolchain 超时，可: export GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct"
  echo "  或直接调用本脚本时加上： --source-dir /path/to/项目根"
  echo ""
}

# 若预检存在待装项：询问是否由脚本自动安装；选否则 print_manual_install_hints 并 exit 0
confirm_auto_install_deps_or_exit() {
  AUTO_INSTALL_DEPS=1
  [[ ${#TO_INSTALL[@]} -eq 0 ]] && return 0
  if [[ "$AUTO_YES" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "非交互 stdin：将自动安装缺失依赖。若需自行安装请在终端交互运行（勿用管道），或先装好后再执行。"
    return 0
  fi
  echo ""
  local ans=""
  read -rp "$(echo -e "${YELLOW}是否由本脚本自动安装缺失的环境（apt/dnf、Go、Node 等）? [Y/n]${NC} ")" ans
  ans="${ans:-Y}"
  if [[ "$ans" =~ ^[Nn] ]]; then
    AUTO_INSTALL_DEPS=0
    print_manual_install_hints "$@"
    log "已跳过自动安装；请手动安装依赖后重新运行本脚本。"
    exit 0
  fi
  return 0
}

# ── 源码包根目录发现（预检 0.6 与 Phase 2 find_source 共用）──────────────────

# GNU coreutils：当前目录为 //home/foo 时 pwd 可能仍带双斜杠；统一成单斜杠便于日志与比较
normalize_abs_path_print() {
  local p="$1"
  case "$p" in
    //[!/]*) p="/${p#//}" ;;
    //) p="/" ;;
  esac
  echo "$p"
}

resolve_bundle_root_from_script() {
  local scripts_dir mod_root bundle
  scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 1
  mod_root="$(cd "$scripts_dir/.." && pwd)" || return 1
  [[ -f "$mod_root/go.mod" ]] || return 1
  bundle="$(cd "$mod_root/.." && pwd)" || return 1
  [[ -f "$bundle/vpn-api/go.mod" ]] || return 1
  normalize_abs_path_print "$bundle"
}

try_find_bundle_under() {
  local base="$1"
  local sub out
  [[ -z "$base" || ! -e "$base" ]] && return 1
  if [[ -f "$base/vpn-api/go.mod" ]]; then
    out="$(cd "$base" && pwd)" || return 1
    normalize_abs_path_print "$out"
    return 0
  fi
  shopt -s nullglob
  for sub in "$base"/*; do
    if [[ -f "$sub/vpn-api/go.mod" ]]; then
      out="$(cd "$sub" && pwd)" || return 1
      normalize_abs_path_print "$out"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

# 输出绝对路径的源码包根（其下须有 vpn-api/go.mod）；失败返回 1
discover_source_bundle_root() {
  local prefer_inst cwd_src candidates b i found
  prefer_inst="${PREFER_INSTALLED:-0}"
  cwd_src="${CWD_SOURCE:-0}"
  candidates=()

  if [[ -n "${SOURCE_DIR}" ]]; then
    candidates+=("$SOURCE_DIR")
  fi

  if [[ "$prefer_inst" -eq 1 ]]; then
    candidates+=("$INSTALL_DIR")
    b="$(resolve_bundle_root_from_script 2>/dev/null || true)"
    [[ -n "$b" ]] && candidates+=("$b")
    if [[ "$cwd_src" -eq 1 ]] && [[ -f "${PWD}/vpn-api/go.mod" ]]; then
      candidates+=("$(normalize_abs_path_print "$(cd "$PWD" && pwd)")")
    fi
  else
    b="$(resolve_bundle_root_from_script 2>/dev/null || true)"
    [[ -n "$b" ]] && candidates+=("$b")
    if [[ "$cwd_src" -eq 1 ]] && [[ -f "${PWD}/vpn-api/go.mod" ]]; then
      candidates+=("$(normalize_abs_path_print "$(cd "$PWD" && pwd)")")
    fi
    candidates+=("$INSTALL_DIR")
  fi

  candidates+=("/tmp/vpn-project" "/root/vpn-project")

  for i in "${candidates[@]}"; do
    found="$(try_find_bundle_under "$i" 2>/dev/null || true)"
    if [[ -n "$found" ]]; then
      echo "$found"
      return 0
    fi
  done
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 0: 环境预检
# ═══════════════════════════════════════════════════════════════════════════════

precheck() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  VPN 控制面部署 — 环境预检"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  local ERRORS=0
  local WARNINGS=0
  TO_INSTALL=()

  # ── 0.1 Root 权限 ──────────────────────────────────────────────────────────

  log "检查 root 权限 ..."
  if [[ "$(id -u)" -ne 0 ]]; then
    fail "需要 root 权限运行此脚本"
    err "请使用: sudo bash $0 $*"
    exit 1
  fi
  ok "root 权限"

  # ── 0.2 操作系统检测 ────────────────────────────────────────────────────────

  log "检测操作系统 ..."
  OS_ID="unknown"; OS_VERSION="0"; OS_NAME="unknown"; PKG=""; ARCH=""
  ARCH="$(uname -m)"

  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VERSION="${VERSION_ID:-0}"
    OS_NAME="${PRETTY_NAME:-$ID $VERSION_ID}"
  fi

  if command -v apt-get >/dev/null 2>&1; then
    PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG="yum"
  fi

  echo "  系统:     $OS_NAME"
  echo "  架构:     $ARCH"
  echo "  包管理器: ${PKG:-未检测到}"

  case "$OS_ID" in
    ubuntu)
      case "${OS_VERSION%%.*}" in
        20|22|24) ok "Ubuntu $OS_VERSION 受支持" ;;
        *) warn "Ubuntu $OS_VERSION 未经测试，推荐 22.04 LTS 或 24.04 LTS"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    debian)
      case "${OS_VERSION%%.*}" in
        11|12) ok "Debian $OS_VERSION 受支持" ;;
        *) warn "Debian $OS_VERSION 未经测试，推荐 11 或 12"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    centos|rocky|almalinux|rhel)
      case "${OS_VERSION%%.*}" in
        8|9) ok "$OS_ID $OS_VERSION 受支持" ;;
        *) warn "$OS_ID $OS_VERSION 未经测试，推荐 8 或 9"; WARNINGS=$((WARNINGS+1)) ;;
      esac ;;
    fedora)
      ok "Fedora $OS_VERSION" ;;
    *)
      warn "未识别的发行版: $OS_ID，可能遇到兼容性问题"
      WARNINGS=$((WARNINGS+1)) ;;
  esac

  if [[ -z "$PKG" ]]; then
    fail "未检测到包管理器 (apt/dnf/yum)"
    ERRORS=$((ERRORS+1))
  fi

  if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
    warn "架构 $ARCH 未经测试，Go 和 Node.js 二进制包可能不可用"
    WARNINGS=$((WARNINGS+1))
  fi

  # ── 0.3 逐项检查依赖 ───────────────────────────────────────────────────────

  log "检查依赖项 ..."

  check_cmd() {
    local cmd="$1" pkg="${2:-$1}" required="${3:-true}"
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver=""
      case "$cmd" in
        go)     ver="$(go version 2>/dev/null | awk '{print $3}')" ;;
        node)   ver="$(node --version 2>/dev/null)" ;;
        npm)    ver="v$(npm --version 2>/dev/null)" ;;
        openvpn) ver="$(openvpn --version 2>/dev/null | head -1 | awk '{print $2}')" ;;
        wg)     ver="$(wg --version 2>/dev/null | awk '{print $2}' || echo '?')" ;;
        *)      ver="installed" ;;
      esac
      ok "$cmd ($ver)"
      return 0
    else
      if [[ "$required" == "true" ]]; then
        fail "$cmd — 未安装，需要安装 $pkg"
        TO_INSTALL+=("$pkg")
      else
        warn "$cmd — 未安装 (可选: $pkg)"
      fi
      return 1
    fi
  }

  echo ""
  echo "  [核心依赖]"
  check_cmd curl curl
  check_cmd wget wget
  check_cmd git git
  check_cmd jq jq
  check_cmd sqlite3 sqlite3

  echo ""
  echo "  [Go 编译环境]"
  if command -v go >/dev/null 2>&1; then
    GO_VER="$(go version | grep -oP 'go\K[0-9]+\.[0-9]+' || echo '0.0')"
    GO_MAJOR="${GO_VER%%.*}"
    GO_MINOR="${GO_VER#*.}"
    ok "go ($(go version 2>/dev/null | awk '{print $3}'))"
    if [[ "$GO_MAJOR" -lt 1 ]] || [[ "$GO_MAJOR" -eq 1 && "$GO_MINOR" -lt 21 ]]; then
      warn "Go $GO_VER 版本过低，需要 >= 1.21，Phase 1 将自动安装新版本"
      TO_INSTALL+=("go-upgrade")
    fi
  else
    warn "go — 未检测到（Phase 1 将自动安装 Go 1.22.x 至 /usr/local/go）"
    TO_INSTALL+=("go")
  fi

  echo ""
  echo "  [前端构建环境]"
  if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
    if check_cmd node nodejs false; then
      NODE_VER="$(node --version | tr -d 'v' | cut -d. -f1)"
      if [[ "${NODE_VER:-0}" -lt 16 ]]; then
        warn "Node.js v${NODE_VER} 版本过低，需要 >= 16，将自动安装新版本"
        TO_INSTALL+=("node-upgrade")
      fi
    else
      TO_INSTALL+=("nodejs")
    fi
    check_cmd npm npm false || TO_INSTALL+=("npm")
  else
    echo "  (已跳过，使用 --skip-frontend)"
  fi

  echo ""
  echo "  [CA / 证书（控制面签发用户证书需要 easy-rsa；tls-crypt 初始化需 openvpn --genkey）]"
  echo "      说明: wireguard-tools / ipset 仅为 VPN 节点侧依赖，控制面 API 不需要，预检不再检查。"
  if command -v openvpn >/dev/null 2>&1; then
    ok "openvpn ($(openvpn --version 2>/dev/null | head -1 | awk '{print $2}'))"
  else
    warn "openvpn — 未安装，Phase 1 将通过 apt/dnf 安装（CA 初始化需要 openvpn --genkey）"
    TO_INSTALL+=("openvpn")
  fi
  if command -v easyrsa >/dev/null 2>&1 || [[ -x /usr/share/easy-rsa/easyrsa ]] || [[ -x /usr/share/easy-rsa/3/easyrsa ]]; then
    ok "easy-rsa (easyrsa 可用)"
  else
    warn "easy-rsa — 未检测到 easyrsa，Phase 1 将安装系统包 easy-rsa"
    TO_INSTALL+=("easy-rsa")
  fi

  echo ""
  echo "  [可选组件]"
  # certbot 为可选：check_cmd 在未安装时返回 1；独立语句在 set -e 下会导致脚本静默退出（看不到后续预检/部署）
  check_cmd certbot certbot false || true

  # ── 0.4 检查端口占用 ───────────────────────────────────────────────────────

  log "检查端口占用 ..."

  check_port() {
    local port="$1" name="$2"
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
      warn "端口 $port ($name) 已被占用"
      WARNINGS=$((WARNINGS+1))
    else
      ok "端口 $port ($name) 可用"
    fi
  }

  check_port "$API_PORT" "API (vpn-api)"
  log "提示: 若使用 Nginx 反代静态站与 /api，请参考项目内 docs/nginx-control-plane.example.conf（本脚本不安装 Nginx）。"

  # ── 0.5 检查磁盘空间 ───────────────────────────────────────────────────────

  log "检查磁盘空间 ..."
  AVAIL_MB="$(df -m /opt 2>/dev/null | tail -1 | awk '{print $4}')"
  if [[ "${AVAIL_MB:-0}" -lt 1024 ]]; then
    warn "/opt 可用空间 ${AVAIL_MB}MB，建议至少 1GB"
    WARNINGS=$((WARNINGS+1))
  else
    ok "/opt 可用空间 ${AVAIL_MB}MB"
  fi

  # ── 0.6 检查源码 ───────────────────────────────────────────────────────────

  log "检查源码 ..."
  local SRC_ROOT=""
  local SRC_FOUND=0
  if SRC_ROOT="$(discover_source_bundle_root 2>/dev/null)"; then
    ok "源码: $SRC_ROOT/vpn-api/"
    SRC_FOUND=1
  fi
  if [[ "${CWD_SOURCE:-0}" -eq 1 ]] && [[ ! -f "${PWD}/vpn-api/go.mod" ]]; then
    warn "已指定 --cwd-source，但当前目录下不存在 vpn-api/go.mod（PWD=$PWD），已按其它规则查找"
  fi
  if [[ "$SRC_FOUND" -eq 0 ]]; then
    fail "源码未找到，请先上传项目文件到 $INSTALL_DIR/ 或使用 --source-dir 指定源码包根目录"
    ERRORS=$((ERRORS+1))
  fi

  # ── 0.7 汇总报告 ───────────────────────────────────────────────────────────

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  预检结果"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  if [[ ${#TO_INSTALL[@]} -gt 0 ]]; then
    echo "  需要安装的软件包:"
    echo ""
    for pkg in "${TO_INSTALL[@]}"; do
      case "$pkg" in
        go|go-upgrade)
          echo "    • Go 1.22.5 (从 go.dev 下载官方二进制)" ;;
        nodejs|node-upgrade)
          echo "    • Node.js 20.x LTS (从 nodesource 或官方二进制)" ;;
        npm)
          echo "    • npm (随 Node.js 一起安装)" ;;
        *)
          echo "    • $pkg" ;;
      esac
    done
    echo ""
  fi

  if [[ "$ERRORS" -gt 0 ]]; then
    echo -e "  ${RED}错误: $ERRORS${NC}  |  ${YELLOW}警告: $WARNINGS${NC}"
    echo ""
    err "存在 $ERRORS 个错误，无法继续。请先解决上述问题。"
    exit 1
  fi

  if [[ "$WARNINGS" -gt 0 ]]; then
    echo -e "  ${GREEN}错误: 0${NC}  |  ${YELLOW}警告: $WARNINGS${NC}"
  else
    echo -e "  ${GREEN}全部通过！${NC}"
  fi

  echo ""
  echo "  部署计划:"
  echo "    安装目录:  $INSTALL_DIR"
  echo "    前端目录:  $FRONTEND_DIR"
  echo "    API 端口:  $API_PORT"
  echo "    数据库:    SQLite ($INSTALL_DIR/data/vpn.db)"
  [[ -n "$DOMAIN" ]] && echo "    域名:      $DOMAIN (EXTERNAL_URL=https://${DOMAIN})"
  echo ""

  confirm_auto_install_deps_or_exit "$@"

  if [[ ${#TO_INSTALL[@]} -gt 0 ]]; then
    if ! confirm "将安装 ${#TO_INSTALL[@]} 个软件包并开始部署，是否继续?"; then
      echo "已取消。"
      exit 0
    fi
  else
    if ! confirm "所有依赖已就绪，是否开始部署?"; then
      echo "已取消。"
      exit 0
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: 安装缺失依赖
# ═══════════════════════════════════════════════════════════════════════════════

install_deps() {
  log "Phase 1: 安装依赖 ..."

  if ! detect_pkg_manager; then
    err "未检测到 apt/dnf/yum，无法自动安装系统包"
    exit 1
  fi
  [[ -z "${ARCH:-}" ]] && ARCH="$(uname -m)"

  apply_cli_proxy_if_set

  case "$PKG" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      while true; do
        if apt-get update -qq && apt-get install -y -qq curl wget git jq sqlite3 build-essential openvpn easy-rsa; then
          apt-get install -y -qq certbot 2>/dev/null || warn "certbot 安装跳过（可选）"
          break
        fi
        if ! prompt_network_proxy_retry "apt-get update/install"; then
          err "apt-get 失败"
          exit 1
        fi
      done
      ;;
    dnf)
      while true; do
        dnf install -y epel-release 2>/dev/null || true
        if dnf install -y curl wget git jq sqlite gcc openvpn easy-rsa certbot; then
          break
        fi
        if ! prompt_network_proxy_retry "dnf install"; then
          err "dnf install 失败"
          exit 1
        fi
      done
      ;;
    yum)
      while true; do
        yum install -y epel-release 2>/dev/null || true
        if yum install -y curl wget git jq sqlite gcc openvpn easy-rsa certbot; then
          break
        fi
        if ! prompt_network_proxy_retry "yum install"; then
          err "yum install 失败"
          exit 1
        fi
      done
      ;;
    *)
      err "未知包管理器: $PKG"
      exit 1
      ;;
  esac

  install_go
  if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
    install_node
  fi
}

install_go() {
  if command -v go >/dev/null 2>&1; then
    local ver=""
    ver="$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/^go//')"
    [[ -z "$ver" ]] && ver="0.0"
    local major="${ver%%.*}"
    local minor="${ver#*.}"
    if [[ "$major" -ge 2 ]] || [[ "$major" -eq 1 && "${minor:-0}" -ge 21 ]]; then
      ok "Go $ver 已安装且版本足够"
      return
    fi
  fi

  log "  安装 Go 1.22.5 ..."

  local GO_PKG="go1.22.5.linux-amd64.tar.gz"
  [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && GO_PKG="go1.22.5.linux-arm64.tar.gz"

  while true; do
    if curl -fsSL --connect-timeout 60 -o /tmp/go.tar.gz "https://go.dev/dl/${GO_PKG}" && [[ -s /tmp/go.tar.gz ]]; then
      break
    fi
    rm -f /tmp/go.tar.gz
    if ! prompt_network_proxy_retry "curl 下载 Go (https://go.dev/dl/)"; then
      err "下载 Go 失败（请检查网络或代理）"
      exit 1
    fi
  done
  rm -rf /usr/local/go
  if ! tar -C /usr/local -xzf /tmp/go.tar.gz; then
    err "解压 Go 失败"
    rm -f /tmp/go.tar.gz
    exit 1
  fi
  rm -f /tmp/go.tar.gz

  export PATH="/usr/local/go/bin:$PATH"
  grep -q '/usr/local/go/bin' /etc/profile 2>/dev/null || \
    echo 'export PATH="/usr/local/go/bin:$PATH"' >> /etc/profile

  ok "Go $(go version | awk '{print $3}') 安装完成"
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local ver="$(node --version | tr -d 'v' | cut -d. -f1)"
    if [[ "${ver:-0}" -ge 16 ]]; then
      ok "Node.js $(node --version) 已安装且版本足够"
      ensure_npm
      return
    fi
    log "  Node.js 版本过低 (v${ver})，升级中 ..."
  fi

  log "  安装 Node.js 20.x LTS ..."
  local INSTALLED=0

  # 方式 1: nodesource
  case "$PKG" in
    apt)
      local ns_ok=0
      while true; do
        if curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/ns.sh 2>/dev/null && [[ -s /tmp/ns.sh ]]; then
          ns_ok=1
          break
        fi
        rm -f /tmp/ns.sh
        if ! prompt_network_proxy_retry "curl NodeSource 脚本 (deb.nodesource.com)"; then
          break
        fi
      done
      if [[ "$ns_ok" -eq 1 ]]; then
        bash /tmp/ns.sh 2>/dev/null && apt-get install -y -qq nodejs 2>/dev/null && INSTALLED=1
        rm -f /tmp/ns.sh
      fi
      ;;
    dnf|yum)
      local ns_ok=0
      while true; do
        if curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/ns.sh 2>/dev/null && [[ -s /tmp/ns.sh ]]; then
          ns_ok=1
          break
        fi
        rm -f /tmp/ns.sh
        if ! prompt_network_proxy_retry "curl NodeSource 脚本 (rpm.nodesource.com)"; then
          break
        fi
      done
      if [[ "$ns_ok" -eq 1 ]]; then
        bash /tmp/ns.sh 2>/dev/null && $PKG install -y nodejs 2>/dev/null && INSTALLED=1
        rm -f /tmp/ns.sh
      fi
      ;;
  esac

  # 方式 2: 官方二进制
  if [[ "$INSTALLED" -eq 0 ]]; then
    log "  nodesource 失败，下载官方二进制 ..."
    local NODE_ARCH="x64"
    [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && NODE_ARCH="arm64"
    local NODE_PKG="node-v20.18.0-linux-${NODE_ARCH}"
    while true; do
      if curl -fsSL --connect-timeout 60 -o /tmp/node.tar.xz "https://nodejs.org/dist/v20.18.0/${NODE_PKG}.tar.xz" && [[ -s /tmp/node.tar.xz ]]; then
        tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
        rm -f /tmp/node.tar.xz
        INSTALLED=1
        break
      fi
      rm -f /tmp/node.tar.xz
      if ! prompt_network_proxy_retry "curl Node.js 官方二进制 (nodejs.org)"; then
        break
      fi
    done
  fi

  # 方式 3: 系统包
  if [[ "$INSTALLED" -eq 0 ]]; then
    log "  尝试系统包管理器 ..."
    case "$PKG" in
      apt) apt-get install -y -qq nodejs npm 2>/dev/null && INSTALLED=1 ;;
      dnf) dnf install -y nodejs npm 2>/dev/null && INSTALLED=1 ;;
      yum) yum install -y nodejs npm 2>/dev/null && INSTALLED=1 ;;
    esac
  fi

  if command -v node >/dev/null 2>&1; then
    ok "Node.js $(node --version) 安装完成"
  else
    warn "Node.js 安装失败，前端构建将跳过"
  fi

  ensure_npm
}

ensure_npm() {
  if command -v npm >/dev/null 2>&1; then
    return
  fi
  log "  npm 未找到，安装中 ..."
  case "$PKG" in
    apt) apt-get install -y -qq npm 2>/dev/null ;;
    dnf) dnf install -y npm 2>/dev/null ;;
    yum) yum install -y npm 2>/dev/null ;;
  esac
  command -v corepack >/dev/null 2>&1 && corepack enable 2>/dev/null || true
  if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm --version) 就绪"
  else
    warn "npm 安装失败"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: 定位源码
# ═══════════════════════════════════════════════════════════════════════════════

find_source() {
  log "Phase 2: 定位源码 ..."

  if [[ "${CWD_SOURCE:-0}" -eq 1 ]] && [[ ! -f "${PWD}/vpn-api/go.mod" ]]; then
    warn "已指定 --cwd-source，但当前目录下不存在 vpn-api/go.mod（PWD=$PWD），已按其它规则查找"
  fi

  local FOUND=""
  if ! FOUND="$(discover_source_bundle_root)"; then
    err "源码未找到"; exit 1
  fi

  local install_abs="$INSTALL_DIR"
  if [[ -d "$INSTALL_DIR" ]]; then
    install_abs="$(normalize_abs_path_print "$(cd "$INSTALL_DIR" && pwd)")"
  fi
  log "选用源码目录: $FOUND"

  if [[ "$FOUND" == "$install_abs" ]]; then
    warn "未从外部目录同步；正在使用 $INSTALL_DIR 内已有源码。若在其它路径已更新代码，请使用 --source-dir，或去掉 --prefer-installed，或在检出目录执行本脚本。"
  else
    mkdir -p "$INSTALL_DIR"
    log "同步源码: $FOUND -> $INSTALL_DIR（顶层通配复制；目标侧已有且源码树中不存在的目录如 data/ 不会被删除）"
    cp -a "$FOUND"/* "$INSTALL_DIR/" 2>/dev/null || cp -a "$FOUND"/. "$INSTALL_DIR/"
  fi
  ok "源码就绪: $INSTALL_DIR/vpn-api/"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: 编译
# ═══════════════════════════════════════════════════════════════════════════════

build_backend() {
  log "Phase 3: 编译后端 ..."
  local golog net_round=0
  golog="$(mktemp)"
  # 未设置 GOPROXY 时默认国内镜像优先，再回退官方（可被用户 export 或菜单项 4 覆盖）
  export GOPROXY="${GOPROXY:-https://goproxy.cn,https://proxy.golang.org,direct}"

  while true; do
    : >"$golog"
    cd "$INSTALL_DIR/vpn-api" || { rm -f "$golog"; exit 1; }
    export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
    export GOPATH="${GOPATH:-$HOME/go}"

    set +e
    (
      go mod tidy && \
      CGO_ENABLED=1 go build -o /usr/local/bin/vpn-api ./cmd/api && \
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /usr/local/bin/vpn-agent-linux-amd64 ./cmd/agent && \
      CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /usr/local/bin/vpn-agent-linux-arm64 ./cmd/agent
    ) >>"$golog" 2>&1
    local rc=$?
    set -e

    if [[ "$rc" -eq 0 ]]; then
      rm -f "$golog"
      break
    fi

    cat "$golog" >&2
    if ! is_go_module_fetch_error "$golog"; then
      err "编译失败（见上方输出）。若为网络问题可手动 export GOPROXY / https_proxy 后重试。"
      rm -f "$golog"
      exit 1
    fi

    net_round=$((net_round + 1))
    [[ "$net_round" -ge 2 ]] && warn "已多次因网络失败：建议选 1 配置 HTTP 代理，或选 4 使用国内 GOPROXY。"

    if ! prompt_go_build_network_retry; then
      rm -f "$golog"
      exit 1
    fi
  done

  cd "$INSTALL_DIR/vpn-api"
  export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
  local host_arch
  host_arch="$(go env GOARCH)"
  ln -sf "vpn-agent-linux-${host_arch}" /usr/local/bin/vpn-agent
  chmod +x /usr/local/bin/vpn-api /usr/local/bin/vpn-agent-linux-amd64 /usr/local/bin/vpn-agent-linux-arm64
  mkdir -p "$INSTALL_DIR/bin"
  cp -a /usr/local/bin/vpn-agent-linux-amd64 /usr/local/bin/vpn-agent-linux-arm64 "$INSTALL_DIR/bin/"
  chmod +x "$INSTALL_DIR/bin/vpn-agent-linux-amd64" "$INSTALL_DIR/bin/vpn-agent-linux-arm64"

  ok "vpn-api  $(ls -lh /usr/local/bin/vpn-api | awk '{print $5}')"
  ok "vpn-agent-linux-amd64 $(ls -lh /usr/local/bin/vpn-agent-linux-amd64 | awk '{print $5}')"
  ok "vpn-agent-linux-arm64 $(ls -lh /usr/local/bin/vpn-agent-linux-arm64 | awk '{print $5}')"
}

build_frontend() {
  if [[ "$SKIP_FRONTEND" -eq 1 ]] || [[ ! -d "$INSTALL_DIR/vpn-admin-web/src" ]]; then
    log "Phase 3b: 跳过前端构建"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "Node.js 不可用，跳过前端"; return
  fi

  log "Phase 3b: 构建前端 ..."
  cd "$INSTALL_DIR/vpn-admin-web"

  local vite_entry="./node_modules/vite/bin/vite.js"
  if command -v npm >/dev/null 2>&1; then
    npm install
  elif command -v yarn >/dev/null 2>&1; then
    yarn install
  else
    warn "npm/yarn 均不可用，跳过前端"; return
  fi

  if [[ ! -f "$vite_entry" ]]; then
    err "未找到 Vite 入口: $vite_entry"
    warn "依赖可能未完整安装；请检查 npm/yarn 安装日志与镜像配置后重试。"
    return 1
  fi

  log "Phase 3b: 使用 node 直调构建: node $vite_entry build"
  if ! node "$vite_entry" build; then
    warn "node 直调 Vite 失败，尝试 npm exec 兜底构建 ..."
    if ! npm exec -- vite build; then
      warn "Vite 构建失败。若日志包含 'Permission denied'，常见原因是 node_modules 所在分区挂载了 noexec。"
      warn "建议排查: mount | grep -E 'noexec' ; ls -l ./node_modules/.bin/vite ; stat ./node_modules/.bin/vite"
      return 1
    fi
  fi

  mkdir -p "$FRONTEND_DIR"
  cp -a dist/* "$FRONTEND_DIR/"
  ok "前端部署到 $FRONTEND_DIR"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4: 配置服务
# ═══════════════════════════════════════════════════════════════════════════════

materialize_node_setup_script() {
  local target="$INSTALL_DIR/scripts/node-setup.sh"
  mkdir -p "$INSTALL_DIR/scripts"
  local candidates=(
    "$INSTALL_DIR/vpn-api/scripts/node-setup.sh"
    "$SOURCE_DIR/vpn-api/scripts/node-setup.sh"
    "$SOURCE_DIR/scripts/node-setup.sh"
  )
  local src=""
  for p in "${candidates[@]}"; do
    if [[ -n "$p" && -f "$p" ]]; then
      src="$p"
      break
    fi
  done
  if [[ -z "$src" ]]; then
    err "未找到 node-setup.sh 源文件（候选：${candidates[*]}）"
    return 1
  fi
  cp -f "$src" "$target"
  chmod +x "$target"
  ok "已固化 node-setup.sh: $target"
}

setup_api() {
  log "Phase 4: 配置 API 服务 ..."

  [[ -z "$JWT_SECRET" ]] && JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)"
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/ca" "$INSTALL_DIR/backups"
  materialize_node_setup_script

  resolve_external_url_value
  local EXTERNAL_URL_VALUE="${FINAL_EXTERNAL_URL}"

  cat > /etc/systemd/system/vpn-api.service <<UNIT
[Unit]
Description=VPN Control Plane API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/data
ExecStart=/usr/local/bin/vpn-api
Restart=always
RestartSec=5
Environment=API_PORT=${API_PORT}
Environment=EXTERNAL_URL=${EXTERNAL_URL_VALUE}
Environment=DB_PATH=${INSTALL_DIR}/data/vpn.db
Environment=JWT_SECRET=${JWT_SECRET}
Environment=CA_DIR=${INSTALL_DIR}/ca
Environment=DB_DRIVER=sqlite
Environment=CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}
Environment=VPN_AGENT_BIN_DIR=${INSTALL_DIR}/bin
Environment=NODE_SETUP_SCRIPT_PATH=${INSTALL_DIR}/scripts/node-setup.sh

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable vpn-api
  systemctl restart vpn-api

  local i=0
  while [[ $i -lt 15 ]]; do
    if curl -sf http://127.0.0.1:${API_PORT}/api/health >/dev/null 2>&1; then
      ok "API 运行中 :${API_PORT}"
      if curl -sfSL -o /tmp/.node-setup-probe "http://127.0.0.1:${API_PORT}/api/node-setup.sh" \
        && [[ -s /tmp/.node-setup-probe ]]; then
        rm -f /tmp/.node-setup-probe
        ok "node-setup.sh endpoint healthy"
      else
        rm -f /tmp/.node-setup-probe
        err "GET /api/node-setup.sh 不可用，部署终止"
        journalctl -u vpn-api --no-pager -n 50 || true
        exit 1
      fi
      local arch
      case "$(uname -m)" in
        x86_64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) arch=amd64; warn "unknown uname -m=$(uname -m), probing amd64 download" ;;
      esac
      if curl -sfSL -o /tmp/.vpn-agent-probe "http://127.0.0.1:${API_PORT}/api/downloads/vpn-agent-linux-${arch}" \
        && [[ -s /tmp/.vpn-agent-probe ]]; then
        rm -f /tmp/.vpn-agent-probe
        ok "节点可拉取 vpn-agent (vpn-agent-linux-${arch})"
      else
        rm -f /tmp/.vpn-agent-probe
        warn "GET /api/downloads/vpn-agent-linux-${arch} 不可用，请确认 /usr/local/bin/vpn-agent-linux-* 已部署"
      fi
      return
    fi
    i=$((i+1)); sleep 1
  done
  err "API 启动失败"; journalctl -u vpn-api --no-pager -n 20 || true
}

setup_backup() {
  log "Phase 4c: 配置备份 ..."
  if [[ -f "$INSTALL_DIR/vpn-api/scripts/backup.sh" ]]; then
    cp "$INSTALL_DIR/vpn-api/scripts/backup.sh" "$INSTALL_DIR/backup.sh"
    chmod +x "$INSTALL_DIR/backup.sh"
    (crontab -l 2>/dev/null | grep -v "vpn-api.*backup"; \
     echo "0 2 * * * DB_PATH=${INSTALL_DIR}/data/vpn.db BACKUP_DIR=${INSTALL_DIR}/backups ${INSTALL_DIR}/backup.sh >> /var/log/vpn-backup.log 2>&1") | crontab -
    ok "备份 cron: 每天 02:00"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5: 完成
# ═══════════════════════════════════════════════════════════════════════════════

print_summary() {
  local summary_url="${FINAL_EXTERNAL_URL}"
  if [[ -z "$summary_url" ]]; then
    summary_url="http://127.0.0.1:${API_PORT}"
  fi

  cat <<EOF

═══════════════════════════════════════════════════════════════
  ✓ VPN 控制面部署完成！
═══════════════════════════════════════════════════════════════

  API 直连:    ${summary_url}/api/health
  EXTERNAL_URL:${summary_url}
  前端静态:    ${FRONTEND_DIR}  （需自行用 Nginx/Caddy 等对外提供，参见 docs/nginx-control-plane.example.conf）
  默认账号:    admin / admin123 (请尽快修改密码)

  JWT Secret:  ${JWT_SECRET}
  数据库:      ${INSTALL_DIR}/data/vpn.db
  CA 目录:     ${INSTALL_DIR}/ca/

  服务管理:
    systemctl status vpn-api    # API 状态
    journalctl -u vpn-api -f    # API 日志
    systemctl cat vpn-api | grep CORS_ALLOWED_ORIGINS

  CORS:
    CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}
    预检验证:
      curl -i -X OPTIONS "${summary_url}/api/health" \\
        -H "Origin: http://你的管理台域名或IP:端口" \\
        -H "Access-Control-Request-Method: GET"

  下一步:
    1. 配置反向代理与 TLS（可选），将根路径指向前端目录、/api/ 反代到 127.0.0.1:${API_PORT}
    2. 浏览器打开你的管理端地址（或开发机 npm run dev 默认 http://0.0.0.0:56701 ）
    3. 用 admin / admin123 登录
    4. 节点管理 → 添加节点 → 复制部署命令
    5. 在节点服务器上执行部署命令

═══════════════════════════════════════════════════════════════
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════════════════════

main() {
  precheck "$@"
  if [[ "$AUTO_INSTALL_DEPS" -ne 1 ]]; then
    exit 0
  fi
  install_deps
  find_source
  build_backend
  build_frontend
  setup_api
  setup_backup
  print_summary
}

main "$@"
