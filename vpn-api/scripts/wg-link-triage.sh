#!/usr/bin/env bash
set -euo pipefail

# 定位 WG “只发不收”（tx增长/rx不增长）问题。
# 用法：
#   bash wg-link-triage.sh
#   bash wg-link-triage.sh --peer node-20

PEER_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
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

echo "===== 1) wg show ====="
wg show || true

echo "===== 2) interface states ====="
ip -br link show | grep "^wg-node-" || true

echo "===== 3) service states ====="
systemctl --no-pager -l --type=service | grep "wg-quick@wg-node-" || true

echo "===== 4) bootstrap tunnels ====="
if [[ -f /etc/vpn-agent/bootstrap-node.json ]]; then
  if [[ -n "$PEER_FILTER" ]]; then
    jq -r --arg p "$PEER_FILTER" '.tunnels[]? | select(.peer_node_id==$p) | {peer_node_id,peer_endpoint,peer_ip,wg_port,peer_pubkey,allowed_ips}' /etc/vpn-agent/bootstrap-node.json || true
  else
    jq -r '.tunnels[]? | {peer_node_id,peer_endpoint,peer_ip,wg_port,peer_pubkey,allowed_ips}' /etc/vpn-agent/bootstrap-node.json || true
  fi
else
  echo "[WARN] /etc/vpn-agent/bootstrap-node.json not found"
fi

echo "===== 5) detect sent>0 recv=0 peers ====="
wg show all dump 2>/dev/null | awk -v filter="$PEER_FILTER" '
BEGIN { OFS="\t" }
NR==1 { next }
{
  # dump format: iface priv pub port fwmark peer psk endpoint allowedips latest_handshake rx tx keepalive
  iface=$1; peer=$6; endpoint=$8; hs=$10; rx=$11; tx=$12;
  if (filter != "" && iface != ("wg-" filter)) next;
  if (tx+0 > 0 && rx+0 == 0) {
    print "[ALERT]", iface, "endpoint=" endpoint, "hs=" hs, "rx=" rx, "tx=" tx, "status=sent_only";
  } else {
    print "[OK]", iface, "endpoint=" endpoint, "hs=" hs, "rx=" rx, "tx=" tx;
  }
}'

echo "===== 6) firewall quick check ====="
ss -lunp | grep ":51820" || true
ufw status verbose 2>/dev/null || true
iptables -S INPUT 2>/dev/null | grep -E "51820|56720" || true

echo "===== 7) agent logs (last 10m) ====="
journalctl -u vpn-agent --since "10 min ago" --no-pager -o cat | grep -Ei "failover|wg-node-|still DOWN|Address already in use|endpoint_parse_error|port_conflict|missing interface" || true

cat <<EOF
===== 下一步建议 =====
1) 若出现 [ALERT] sent_only，请到对端节点执行同脚本确认是否对称问题。
2) 双向检查安全组/防火墙 UDP 51820 放行。
3) 核对 peer_endpoint / peer_pubkey / allowed_ips 一致性。
4) 确认对端存在并启动 wg-quick@wg-node-<本节点ID>。
EOF

