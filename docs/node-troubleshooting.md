# 节点服务器无法连接排障手册

本文用于处理“客户端连不上节点服务器”的常见故障，重点覆盖 OpenVPN 端口占用、防火墙未放行、服务未监听等问题。

## 一、典型现象

- 客户端日志卡在 `WAIT`，反复重连。
- 节点侧 `openvpn-*.service` 反复重启，状态为 `exit-code=1`。
- 节点 `local-only.log` 出现 `Address already in use`、`Exiting due to fatal error`。

## 二、本次事故根因示例

本次故障中，根因是 `1194/udp` 被历史进程占用，导致 `openvpn-local-only` 绑定失败：

```text
TCP/UDP: Socket bind failed on local address [AF_INET][undef]:1194: Address already in use (errno=98)
Exiting due to fatal error
```

处理方式：

1. 停掉历史 OpenVPN 单元与遗留进程；
2. 释放占用端口；
3. 重启 `openvpn-local-only.service` 并确认监听恢复；
4. 验证本机与云侧防火墙规则。

## 三、标准排查流程（必须按顺序）

### 1) 核对控制面下发端口与协议

```bash
jq '.instances[] | {mode,port,proto,enabled}' /etc/vpn-agent/bootstrap-node.json
```

### 2) 检查服务状态与重启原因

```bash
systemctl status openvpn-local-only.service --no-pager -l
journalctl -u openvpn-local-only.service -n 120 --no-pager -o cat
```

### 3) 查看 OpenVPN 真实错误日志

```bash
tail -n 200 /var/log/openvpn/local-only.log
grep -Ei "error|fatal|bind|Address already in use|TUN|tls|crl|failed|exiting" /var/log/openvpn/local-only.log | tail -n 80
```

### 4) 查端口占用与冲突进程

```bash
ss -lunp | grep ':1194 ' || true
lsof -nP -iUDP:1194 || true
fuser -v -n udp 1194 || true
```

### 5) 清理历史冲突（示例）

```bash
systemctl stop openvpn-server@server.service openvpn@server.service 2>/dev/null || true
systemctl disable openvpn-server@server.service openvpn@server.service 2>/dev/null || true
systemctl stop openvpn\*.service 2>/dev/null || true
```

如仍被占用，按 PID 结束：

```bash
kill <PID>
sleep 1
kill -9 <PID> 2>/dev/null || true
```

### 6) 重启目标实例并验证监听

```bash
systemctl restart openvpn-local-only.service
systemctl status openvpn-local-only.service --no-pager -l
ss -lunp | grep ':1194 '
```

## 四、防火墙与链路判责

### 1) 本机防火墙检查

```bash
ufw status verbose 2>/dev/null || true
firewall-cmd --state 2>/dev/null || true
iptables -S INPUT | grep -E '1194|56700|56710|56720' || true
```

### 2) 抓包判责（在节点服务器执行）

```bash
tcpdump -ni any udp port 1194
```

- 抓不到客户端包：云安全组/边界 ACL/上游网络未放行；
- 抓到入站但无握手：本机服务或本机防火墙问题；
- 有完整握手但业务仍异常：进一步检查策略路由/NAT。

## 五、云安全组最小放行建议

- OpenVPN：按实例实际端口放行 UDP（例如 `1194/udp` 或 `56710-56713/udp`）。
- WireGuard：按 `wg_port` 放行 UDP（例如 `56720/udp`）。
- 控制面 API：`56700/tcp`（或你实际反代入口端口）。

## 六、部署后验收清单

```bash
systemctl is-active openvpn-local-only.service
ss -lunp | grep ':1194 '
journalctl -u openvpn-local-only.service -n 30 --no-pager -o cat
```

若任一项失败，节点视为“不可访问”，禁止对外宣告上线成功。
