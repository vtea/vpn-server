#!/usr/bin/env bash
# 在入口节点上检查 cn-split 手工例外（vpn-ex-*）与策略路由 / NAT / mangle 是否一致。
# 用法：以 root 执行；可选先 `systemctl restart vpn-routing.service`。

set -euo pipefail

echo "=== ip rule (fwmark 与 cn-split 相关) ==="
ip -4 rule list | grep -E 'fwmark|vpn_hk_split|lookup 10[1-5] ' || true

echo ""
echo "=== ip route table 104 (vpn_ex_domestic) ==="
ip -4 route show table 104 2>/dev/null || echo "(无表或为空)"

echo ""
echo "=== ip route table 105 (vpn_ex_foreign) ==="
ip -4 route show table 105 2>/dev/null || echo "(无表或为空)"

echo ""
echo "=== ipset vpn-ex-domestic / vpn-ex-foreign（前几行）==="
if command -v ipset >/dev/null 2>&1; then
  ipset list vpn-ex-domestic 2>/dev/null | head -20 || echo "(不存在或为空)"
  echo "---"
  ipset list vpn-ex-foreign 2>/dev/null | head -20 || echo "(不存在或为空)"
else
  echo "ipset 未安装"
fi

echo ""
echo "=== mangle VPN_SPLIT_MARK ==="
iptables -t mangle -S VPN_SPLIT_MARK 2>/dev/null || echo "(链不存在)"

echo ""
echo "=== nat VPN_POSTROUTING（与分流相关片段）==="
iptables -t nat -S VPN_POSTROUTING 2>/dev/null | grep -E 'vpn-ex|china-ip|MASQUERADE|SNAT' || iptables -t nat -S VPN_POSTROUTING 2>/dev/null | head -30

echo ""
echo "=== 可选：本机解析测试域名（若配置了域名例外且 dnsmasq 含 ipset=）==="
echo "示例: getent ahosts example.com  # 需客户端或本机走 127.0.0.1:53 的 dnsmasq 才会填充 ipset"
