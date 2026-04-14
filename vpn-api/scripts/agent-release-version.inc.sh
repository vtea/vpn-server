# shellcheck shell=bash
# Bash include only: 解析 Agent 构建/上报版本字符串（与 deploy、打包、安装入口一致）。
# 用法: source 本文件后调用 resolve_agent_release_version [vpn_api_dir]
#
# 参数 vpn_api_dir: 含 go.mod 的 vpn-api 目录；省略时依次使用 $VPN_API_ROOT、${INSTALL_DIR}/vpn-api。
# 环境变量:
#   AGENT_RELEASE_FALLBACK  无 VERSION 且无 git 时的兜底（package-linux 设为 tarball 的 VERSION）
#   VPN_API_ROOT              安装入口预览时显式指定 vpn-api 根目录

_resolve_agent_release_trim() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  echo "$s"
}

resolve_agent_release_version() {
  local repo="${1:-}"
  if [[ -z "$repo" ]]; then
    repo="${VPN_API_ROOT:-}"
  fi
  if [[ -z "$repo" ]]; then
    local id="${INSTALL_DIR:-/opt/vpn-api}"
    repo="${id}/vpn-api"
  fi
  local v=""
  if [[ -f "$repo/VERSION" ]]; then
    v="$(head -n 1 "$repo/VERSION" | tr -d '\r')"
    v="$(_resolve_agent_release_trim "$v")"
  fi
  if [[ -z "$v" ]] && command -v git >/dev/null 2>&1; then
    local base=""
    for base in "$repo" "$(cd "$repo/.." && pwd)"; do
      [[ -d "$base" ]] || continue
      if git -C "$base" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        v="$(git -C "$base" describe --tags --always --dirty 2>/dev/null || true)"
        v="$(_resolve_agent_release_trim "$v")"
        [[ -n "$v" ]] && break
      fi
    done
  fi
  if [[ -z "$v" ]]; then
    v="${AGENT_RELEASE_FALLBACK:-0.2.1-unknown}"
  fi
  v="${v// /_}"
  v="${v//\"/}"
  echo "$v"
}
