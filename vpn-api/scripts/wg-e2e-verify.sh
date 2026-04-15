#!/usr/bin/env bash
set -euo pipefail

# 10 分钟验收：
# 1) 观测 wg latest handshake 是否刷新
# 2) 观测 rx/tx 是否增长
# 3) 检查 vpn-agent 日志是否出现循环重启告警
#
# 用法：
#   bash wg-e2e-verify.sh
#   bash wg-e2e-verify.sh --minutes 10 --peer node-20

MINUTES=10
PEER_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --minutes)
      MINUTES="${2:-10}"
      shift 2
      ;;
    --peer)
      PEER_FILTER="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$MINUTES" =~ ^[0-9]+$ ]] || [[ "$MINUTES" -le 0 ]]; then
  echo "[FAIL] invalid --minutes: ${MINUTES}" >&2
  exit 1
fi

SAMPLES=$((MINUTES * 2))
declare -A start_rx start_tx end_rx end_tx start_hs end_hs
declare -A seen_iface

collect_dump() {
  wg show all dump 2>/dev/null | awk -v filter="$PEER_FILTER" '
NR==1 { next }
{
  iface=$1
  if (filter != "" && iface != ("wg-" filter)) next
  hs=$10; rx=$11; tx=$12
  print iface, hs, rx, tx
}'
}

prime="$(collect_dump || true)"
if [[ -z "${prime// }" ]]; then
  echo "[FAIL] no wg peer rows found"
  exit 1
fi

while read -r iface hs rx tx; do
  [[ -z "$iface" ]] && continue
  seen_iface["$iface"]=1
  start_hs["$iface"]="$hs"
  start_rx["$iface"]="$rx"
  start_tx["$iface"]="$tx"
done <<< "$prime"

echo "[INFO] monitor ${#seen_iface[@]} iface(s) for ${MINUTES} min ..."
for _ in $(seq 1 "$SAMPLES"); do
  sleep 30
  rows="$(collect_dump || true)"
  while read -r iface hs rx tx; do
    [[ -z "$iface" ]] && continue
    seen_iface["$iface"]=1
    end_hs["$iface"]="$hs"
    end_rx["$iface"]="$rx"
    end_tx["$iface"]="$tx"
  done <<< "$rows"
done

echo "===== verify summary ====="
fail=0
for iface in "${!seen_iface[@]}"; do
  srx="${start_rx[$iface]:-0}"
  stx="${start_tx[$iface]:-0}"
  erx="${end_rx[$iface]:-$srx}"
  etx="${end_tx[$iface]:-$stx}"
  shs="${start_hs[$iface]:-0}"
  ehs="${end_hs[$iface]:-$shs}"

  rx_inc=$((erx - srx))
  tx_inc=$((etx - stx))
  hs_changed=0
  if [[ "$ehs" != "$shs" ]]; then
    hs_changed=1
  fi

  if [[ "$hs_changed" -eq 1 || "$rx_inc" -gt 0 || "$tx_inc" -gt 0 ]]; then
    echo "[PASS] ${iface} hs:${shs}->${ehs} rx:+${rx_inc} tx:+${tx_inc}"
  else
    echo "[FAIL] ${iface} no handshake/traffic progress hs:${shs}->${ehs} rx:+${rx_inc} tx:+${tx_inc}"
    fail=1
  fi
done

echo "===== failover log check (${MINUTES}m) ====="
if journalctl -u vpn-agent --since "${MINUTES} min ago" --no-pager -o cat | grep -Eq "still DOWN after restart|Address already in use|port_conflict|missing interface"; then
  echo "[FAIL] detected failover loop/conflict logs"
  journalctl -u vpn-agent --since "${MINUTES} min ago" --no-pager -o cat | grep -E "still DOWN after restart|Address already in use|port_conflict|missing interface" || true
  fail=1
else
  echo "[PASS] no failover loop/conflict logs"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "[PASS] wg e2e verify passed"

