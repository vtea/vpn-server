


# 一键把所有 OpenVPN 实例 DNS 统一为【223.5.5.5 + 8.8.8.8】（替换 1.1.1.1）
sudo bash -c '
set -euo pipefail
for conf in /etc/openvpn/server/*/server.conf; do
  [ -f "$conf" ] || continue
  cp "$conf" "$conf.bak.$(date +%s)"
  sed -i "/^push \"dhcp-option DNS /d" "$conf"
  if grep -q "^push \"redirect-gateway " "$conf"; then
    sed -i "/^push \"redirect-gateway /i push \"dhcp-option DNS 223.5.5.5\"\npush \"dhcp-option DNS 8.8.8.8\"" "$conf"
  else
    printf "\npush \"dhcp-option DNS 223.5.5.5\"\npush \"dhcp-option DNS 8.8.8.8\"\n" >> "$conf"
  fi
done

systemctl restart openvpn-node-direct 2>/dev/null || true
systemctl restart openvpn-cn-split 2>/dev/null || true
systemctl restart openvpn-global 2>/dev/null || true

echo "===== DNS PUSH CHECK ====="
grep -R --line-number "^push \"dhcp-option DNS " /etc/openvpn/server/*/server.conf 2>/dev/null || true
'

# 一键把 node-setup.sh 模板也改成同样 DNS（防止新节点/重装回写 1.1.1.1）
sudo bash -c '
set -euo pipefail
f=/opt/vpn-api/scripts/node-setup.sh
[ -f "$f" ] || { echo "missing $f"; exit 1; }
cp "$f" "$f.bak.$(date +%s)"
sed -i "s/push \"dhcp-option DNS 1.1.1.1\"/push \"dhcp-option DNS 223.5.5.5\"/g" "$f"
grep -n "dhcp-option DNS" "$f" | sed -n "1,20p"
'

# 客户端重连后，确认下发已生效（看日志应为 223.5.5.5 + 8.8.8.8）
echo "客户端重连后检查 OpenVPN 日志 OPTIONS 中 DNS 项"