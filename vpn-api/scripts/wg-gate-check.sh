#!/usr/bin/env bash
set -euo pipefail

# WG gate checks:
# 1) Trigger WG-only refresh on target node
# 2) Verify OpenVPN main PIDs do not change
# 3) Verify invalid_config is isolated to expected peer (optional)
#
# Usage:
#   bash wg-gate-check.sh \
#     --api-url http://127.0.0.1:56700 \
#     --jwt <admin-jwt> \
#     --node-id node-50 \
#     [--expect-invalid-peer node-10] \
#     [--wait-sec 8]

API_URL=""
JWT=""
NODE_ID=""
EXPECT_INVALID_PEER=""
WAIT_SEC=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="${2:-}"
      shift 2
      ;;
    --jwt)
      JWT="${2:-}"
      shift 2
      ;;
    --node-id)
      NODE_ID="${2:-}"
      shift 2
      ;;
    --expect-invalid-peer)
      EXPECT_INVALID_PEER="${2:-}"
      shift 2
      ;;
    --wait-sec)
      WAIT_SEC="${2:-8}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$API_URL" || -z "$JWT" || -z "$NODE_ID" ]]; then
  echo "usage: bash wg-gate-check.sh --api-url URL --jwt TOKEN --node-id NODE [--expect-invalid-peer PEER] [--wait-sec 8]" >&2
  exit 2
fi

for bin in curl jq systemctl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[FAIL] missing dependency: $bin" >&2
    exit 1
  fi
done

SERVICES=(
  "openvpn-local-only"
  "openvpn-hk-smart-split"
  "openvpn-hk-global"
  "openvpn-us-global"
)

snapshot_pids() {
  local out=""
  for s in "${SERVICES[@]}"; do
    local pid
    pid="$(systemctl show -p MainPID --value "$s" 2>/dev/null || true)"
    if [[ -z "$pid" ]]; then
      pid="0"
    fi
    out+="${s}:${pid}"$'\n'
  done
  echo "$out"
}

echo "[INFO] snapshot openvpn pids (before)"
BEFORE="$(snapshot_pids)"
echo "$BEFORE" | sed 's/^/[PID-BEFORE] /'

echo "[INFO] trigger wg-refresh for node=$NODE_ID"
REFRESH_RESP="$(curl -fsS -X POST "$API_URL/api/nodes/$NODE_ID/wg-refresh" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json")"
echo "$REFRESH_RESP" | jq .

echo "[INFO] wait ${WAIT_SEC}s for wg_refresh_result"
sleep "$WAIT_SEC"

echo "[INFO] query node status"
STATUS_JSON="$(curl -fsS "$API_URL/api/nodes/$NODE_ID/status" \
  -H "Authorization: Bearer $JWT")"

echo "[INFO] snapshot openvpn pids (after)"
AFTER="$(snapshot_pids)"
echo "$AFTER" | sed 's/^/[PID-AFTER]  /'

pid_changed=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  svc="${line%%:*}"
  bpid="${line##*:}"
  apid="$(echo "$AFTER" | awk -F: -v s="$svc" '$1==s{print $2}')"
  [[ -z "$apid" ]] && apid="0"
  if [[ "$bpid" != "$apid" ]]; then
    # tolerate disabled/not-running service where both 0 is stable
    if [[ "$bpid" != "0" || "$apid" != "0" ]]; then
      echo "[FAIL] openvpn pid changed: $svc before=$bpid after=$apid"
      pid_changed=1
    fi
  fi
done <<< "$BEFORE"

if [[ "$pid_changed" -eq 0 ]]; then
  echo "[OK] openvpn main pid unchanged"
fi

if [[ -n "$EXPECT_INVALID_PEER" ]]; then
  invalid_count="$(echo "$STATUS_JSON" | jq --arg p "$EXPECT_INVALID_PEER" '[.tunnels[] | select(.status=="invalid_config" and (.node_a==$p or .node_b==$p))] | length')"
  other_invalid_count="$(echo "$STATUS_JSON" | jq --arg p "$EXPECT_INVALID_PEER" '[.tunnels[] | select(.status=="invalid_config" and (.node_a!=$p and .node_b!=$p))] | length')"
  echo "[INFO] invalid_config expected-peer=$invalid_count other-peers=$other_invalid_count"
  if [[ "$invalid_count" -ge 1 && "$other_invalid_count" -eq 0 ]]; then
    echo "[OK] invalid_config isolation passed"
  else
    echo "[FAIL] invalid_config isolation failed"
    exit 1
  fi
fi

if [[ "$pid_changed" -ne 0 ]]; then
  exit 1
fi

echo "[OK] wg gate checks passed"
