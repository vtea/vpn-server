#!/usr/bin/env bash
set -euo pipefail

# health-check.sh
# Run control-plane and node service checks for VPN deployment.
#
# Usage:
#   bash health-check.sh --role control-plane [--api-url http://127.0.0.1:56700]
#   bash health-check.sh --role node [--api-url http://127.0.0.1:56700]

ROLE=""
API_URL="http://127.0.0.1:56700"
SKIP_DOWNLOAD_CHECK=0
API_JWT=""
EXPECT_CONSISTENT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    --api-url)
      API_URL="${2:-}"
      shift 2
      ;;
    --skip-download-check)
      SKIP_DOWNLOAD_CHECK=1
      shift
      ;;
    --jwt)
      API_JWT="${2:-}"
      shift 2
      ;;
    --expect-consistent)
      EXPECT_CONSISTENT=1
      shift
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$ROLE" != "control-plane" && "$ROLE" != "node" ]]; then
  echo "usage: bash health-check.sh --role control-plane|node [--api-url URL] [--skip-download-check] [--jwt TOKEN] [--expect-consistent]" >&2
  exit 2
fi

PASS=0
WARN=0
FAIL=0

ok() { echo "[OK]   $*"; PASS=$((PASS+1)); }
warn() { echo "[WARN] $*"; WARN=$((WARN+1)); }
err() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }

check_cmd() {
  local title="$1"
  local cmd="$2"
  if bash -lc "$cmd" >/tmp/.hc.out 2>/tmp/.hc.err; then
    ok "$title"
  else
    err "$title"
    sed -n '1,10p' /tmp/.hc.err | sed 's/^/       /'
  fi
}

check_service() {
  local svc="$1"
  if systemctl is-active --quiet "$svc"; then
    ok "service active: $svc"
  else
    warn "service not active: $svc"
    systemctl status "$svc" --no-pager -l 2>/dev/null | sed -n '1,12p' | sed 's/^/       /' || true
  fi
}

echo "==========================================="
echo "Health Check Role: $ROLE"
echo "API URL: $API_URL"
echo "==========================================="

if [[ "$ROLE" == "control-plane" ]]; then
  check_service "vpn-api"
  check_cmd "api health endpoint" "curl -sf --max-time 6 \"$API_URL/api/health\" >/dev/null"

  if [[ "$SKIP_DOWNLOAD_CHECK" -eq 0 ]]; then
    check_cmd "agent amd64 download endpoint" \
      "curl -sfSL --max-time 15 -o /tmp/.vpn-agent.probe \"$API_URL/api/downloads/vpn-agent-linux-amd64\" && [[ -s /tmp/.vpn-agent.probe ]]"
  fi

  if [[ -n "$API_JWT" ]]; then
    if curl -sf --max-time 8 -H "Authorization: Bearer $API_JWT" "$API_URL/api/nodes/state-consistency" -o /tmp/.state-consistency.json; then
      ok "state consistency endpoint"
      if command -v jq >/dev/null 2>&1; then
        mismatch="$(jq -r '.mismatch // 0' /tmp/.state-consistency.json 2>/dev/null || echo 0)"
        if [[ "$mismatch" =~ ^[0-9]+$ ]]; then
          if [[ "$mismatch" -eq 0 ]]; then
            ok "state consistency mismatch=0"
          elif [[ "$EXPECT_CONSISTENT" -eq 1 ]]; then
            err "state consistency mismatch=$mismatch"
          else
            warn "state consistency mismatch=$mismatch"
          fi
        else
          warn "state consistency parse failed (jq output: $mismatch)"
        fi
      else
        warn "jq not installed; cannot parse mismatch from state-consistency payload"
      fi
    else
      err "state consistency endpoint"
    fi
  else
    warn "state consistency endpoint requires JWT: GET $API_URL/api/nodes/state-consistency"
  fi
fi

if [[ "$ROLE" == "node" ]]; then
  check_cmd "node reaches api health" "curl -sf --max-time 6 \"$API_URL/api/health\" >/dev/null"

  check_service "vpn-agent"
  check_service "vpn-routing.service"
  check_service "dnsmasq"

  for svc in openvpn-node-direct openvpn-cn-split openvpn-global; do
    check_service "$svc"
  done

  if compgen -G "/etc/wireguard/wg-*.conf" >/dev/null; then
    while IFS= read -r f; do
      bn="$(basename "$f" .conf)"
      check_service "wg-quick@${bn}"
    done < <(ls /etc/wireguard/wg-*.conf 2>/dev/null || true)
  else
    warn "no /etc/wireguard/wg-*.conf found"
  fi

  if [[ -f /etc/vpn-agent/bootstrap-node.json ]]; then
    if command -v jq >/dev/null 2>&1; then
      missing_peers="$(jq -r '.tunnels[]? | select((.peer_pubkey // "") == "") | .peer_node_id' /etc/vpn-agent/bootstrap-node.json 2>/dev/null || true)"
      if [[ -n "${missing_peers// }" ]]; then
        warn "bootstrap has invalid WG peers (missing peer_pubkey): $(echo "$missing_peers" | tr '\n' ',' | sed 's/,$//')"
      else
        ok "bootstrap WG peers have peer_pubkey"
      fi
    else
      warn "jq not installed; cannot validate bootstrap peer_pubkey"
    fi
  else
    warn "bootstrap missing: /etc/vpn-agent/bootstrap-node.json"
  fi

  if [[ -f /etc/vpn-agent/cn-ip-list.txt ]]; then
    if [[ -s /etc/vpn-agent/cn-ip-list.txt ]]; then
      ok "cn-ip-list exists and non-empty"
    else
      warn "cn-ip-list exists but empty"
    fi
  else
    warn "cn-ip-list missing: /etc/vpn-agent/cn-ip-list.txt"
  fi

  if command -v ipset >/dev/null 2>&1; then
    if ipset list china-ip >/dev/null 2>&1; then
      ok "ipset china-ip exists"
    else
      warn "ipset china-ip not found"
    fi
  else
    warn "ipset command not installed"
  fi
fi

echo "-------------------------------------------"
echo "PASS=$PASS WARN=$WARN FAIL=$FAIL"
echo "-------------------------------------------"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

