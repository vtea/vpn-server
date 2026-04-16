# 节点服务器无法连接排障手册

本文用于处理“客户端连不上节点服务器”的常见故障，重点覆盖 OpenVPN 端口占用、防火墙未放行、服务未监听等问题。

## 一、典型现象

- 客户端日志卡在 `WAIT`，反复重连。
- 节点侧 `openvpn-*.service` 反复重启，状态为 `exit-code=1`。
- 节点 `node-direct.log` 出现 `Address already in use`、`Exiting due to fatal error`。

## 二、本次事故根因示例

本次故障中，根因是 `1194/udp` 被历史进程占用，导致 `openvpn-node-direct` 绑定失败：

```text
TCP/UDP: Socket bind failed on local address [AF_INET][undef]:1194: Address already in use (errno=98)
Exiting due to fatal error
```

处理方式：

1. 停掉历史 OpenVPN 单元与遗留进程；
2. 释放占用端口；
3. 重启 `openvpn-node-direct.service` 并确认监听恢复；
4. 验证本机与云侧防火墙规则。

## 三、标准排查流程（必须按顺序）

### 1) 核对控制面下发端口与协议

```bash
jq '.instances[] | {mode,port,proto,enabled}' /etc/vpn-agent/bootstrap-node.json
```

### 2) 检查服务状态与重启原因

```bash
systemctl status openvpn-node-direct.service --no-pager -l
journalctl -u openvpn-node-direct.service -n 120 --no-pager -o cat
```

### 3) 查看 OpenVPN 真实错误日志

```bash
tail -n 200 /var/log/openvpn/node-direct.log
grep -Ei "error|fatal|bind|Address already in use|TUN|tls|crl|failed|exiting" /var/log/openvpn/node-direct.log | tail -n 80
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
systemctl restart openvpn-node-direct.service
systemctl status openvpn-node-direct.service --no-pager -l
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

### 3) 入口经隧道走出口节点时「海外全挂」、两端各自直连却正常

**常见根因**：出口节点上 **未对「从 `wg-<对端ID>` 入、从公网口出」的转发流量做 MASQUERADE**，公网回程地址非法。

**在出口节点执行**：

```bash
iptables -t nat -S VPN_POSTROUTING | grep -- '-i wg-'
```

若仅有 `-s <OpenVPN 子网>` 而无 `-i wg-... -j MASQUERADE`，请 **重跑 `node-setup.sh`** 以重新生成 `/etc/vpn-agent/nat-rules.sh`，再 `systemctl restart vpn-routing.service`。详见 [operations.md](operations.md) 小节「3.2.1 出口节点：隧道转发与出网 NAT」。

## 五、云安全组最小放行建议

- OpenVPN：按实例实际端口放行 UDP（例如 `1194/udp` 或 `56710-56712/udp`）。
- WireGuard：按 `wg_port` 放行 UDP（例如 `56720/udp`）。
- 控制面 API：`56700/tcp`（或你实际反代入口端口）。

## 六、部署后验收清单

```bash
systemctl is-active openvpn-node-direct.service
ss -lunp | grep ':1194 '
journalctl -u openvpn-node-direct.service -n 30 --no-pager -o cat
```

若任一项失败，节点视为“不可访问”，禁止对外宣告上线成功。

## 七、隧道状态全红时优先检查

当管理台隧道显示 `中断/配置无效`，优先执行：

```bash
jq '.tunnels[] | {peer_node_id, peer_endpoint, peer_ip, wg_port, peer_pubkey}' /etc/vpn-agent/bootstrap-node.json
wg show
systemctl --no-pager -l status 'wg-quick@wg-*'
```

判读要点：

- `peer_pubkey` 为空：属于配置问题，控制面会标记 `invalid_config`；
- `wg-quick` 报 `PublicKey=` 解析错误：通常由空公钥下发引起；
- `transfer` 持续为 0 且无 `latest handshake`：多为端口/路由/对端不可达。

## 八、`openvpn-cn-split` 反复失败、`ipset` 刷屏与 `StartLimit` 警告

现象常为三条**独立**问题链叠加：控制面仍下发旧 `node-setup.sh`（`StartLimit*` 写在 `[Service]`）、`overseas` 制品仍为 IPv6 导致 `hash:net` 海量报错、以及 OpenVPN 自身 `exit 1` 需看日志定因。

### 1) 控制面与制品对齐（必须先做）

1. **部署并重启**运行中的 `vpn-api`，确保二进制包含：海外源迁移（将误配的 `china6.txt` 改为 IPv4 段列表）、`refreshIPListArtifact("overseas")` 仅保留 IPv4 CIDR、以及磁盘上的 [`vpn-api/scripts/node-setup.sh`](../vpn-api/scripts/node-setup.sh) 与当前仓库一致（`ServeNodeSetupScript` 从部署目录读取该脚本）。
2. 在 Web **「分流规则」**执行一次 **「全网立即更新」**，且列表中**包含 `overseas`**，以便重建仅 IPv4 的 overseas 制品；否则节点 `curl .../api/ip-lists/download/overseas` 仍可能拉到旧 IPv6 内容，Step 7 会继续刷屏。
3. **验收（在任意可访问控制面的机器上）**：

```bash
# node-setup：StartLimit* 必须落在 [Unit]…[Service] 之间（勿仅在 [Service] 段内）
curl -fsSL "http://<控制面>/api/node-setup.sh" | awk '/^\[Unit\]/{p=1} /^\[Service\]/{p=0} p && /StartLimit/{print NR ":" $0}'

# overseas 制品不应再是大段 2001:/2400: 等 IPv6（hash:net 仅支持 IPv4）
curl -fsSL "http://<控制面>/api/ip-lists/download/overseas" | head -n 20
```

若上一行 `awk` **无输出**，说明拉到的脚本里 `StartLimit*` 仍不在 `[Unit]` 段（或脚本过旧），说明控制面进程或部署目录脚本**未升级**，节点 `curl` 重跑也不会自愈。

### 2) 故障节点重跑部署脚本

与现有一致，在节点执行（参数按实际替换）：

```bash
curl -fsSL "http://<控制面>/api/node-setup.sh" | bash -s -- --api-url "http://<控制面>" --token "<节点令牌>" --apply
systemctl daemon-reload
```

**核对 systemd 单元**（仓库模板已将 `StartLimitIntervalSec` / `StartLimitBurst` 放在 `[Unit]`）：

```bash
grep -n StartLimit /etc/systemd/system/openvpn-cn-split.service
systemctl cat openvpn-cn-split.service | sed -n '1,25p'
```

期望：`StartLimit*` 出现在 **`[Unit]`** 段内；`journalctl` 中不应再出现 `Unknown key 'StartLimitIntervalSec' in section 'Service'`。

### 3) OpenVPN 仍为 `exit 1` 时（脚本对齐后必做）

按顺序只读诊断：

```bash
journalctl -u openvpn-cn-split.service -n 80 --no-pager -o cat
tail -n 120 /var/log/openvpn/cn-split.log
sudo /usr/sbin/openvpn --suppress-timestamps --config /etc/openvpn/server/cn-split/server.conf
```

（最后一行前台运行，看到 `FATAL`/`Error` 后 `Ctrl+C` 退出。）

**常见关键字对照**：

| 日志线索 | 可能原因 |
|----------|----------|
| `Address already in use` / `management` / `bind` | management 端口（如脚本中的高位端口）被占用 |
| `Cannot load DH` / `dh.pem` | DH 文件缺失或权限 |
| `CRL` / `crl.pem` | CRL 过期或未下发 |
| `TLS Error` / `cannot read` / `tls-crypt` | 密钥路径或权限 |
| `TUN` / `Device or resource busy` | `tun-cn-split` 残留或内核 tun 泄漏 |
| `sd_notify` / 长期无 ready 且 `Type=notify` | 与发行版 OpenVPN 的 systemd notify 能力不匹配；当前 `node-setup.sh` 生成的 unit 已默认 **`Type=simple`**，若你手工改回 `notify` 仍失败可对照此条 |

将含 `FATAL` / `Error` / `cannot` 的几行作为下一步修改依据（模板在 `node-setup.sh` 生成的 `server.conf` 或控制面 PKI 流程）。

### 4) 整体验收

- `systemctl cat openvpn-cn-split.service`：`StartLimitIntervalSec` 在 **`[Unit]`**，且无 Unknown key 警告。
- 部署 Step 7：**无**大规模 `ipset ... IPv6` / prefix 超范围报错；`overseas-ip` 正常加载或为空并有清晰 WARNING。
- `systemctl is-active openvpn-cn-split.service` 为 **active**；`/var/log/openvpn/cn-split.log` 无持续 Fatal。

### 5) WireGuard `AllowedIPs` 与 `exit_node`（数据面深入）

Linux 上 WireGuard 把 **`AllowedIPs` 同时当作「发往该 peer 的明文目的地址」路由表**：策略路由把客户端流量送到 `wg-<对端ID>` 后，若目的公网 IP **不在**该 peer 的 `AllowedIPs` 内，内核往往**选不中 peer**，表现为经隧道出网全断或随机不通。

控制面在生成隧道配置时：若本节点某**已启用**实例的 **`exit_node` 等于该对端节点 ID**，且模式为 **`cn-split` / `global` / `node-direct`（且带出口）**，则为该 peer **追加 `0.0.0.0/0`**（见 `vpn-api/internal/service/tunnel_service.go` 中 `BuildTunnelConfigsForNode`）。

**运维要点**：

- 入口做 cn-split/global 且走指定出口时，务必在实例上填写 **`exit_node` = 出口节点 UUID**（勿留空依赖 legacy 隧道名），否则不会注入 `0.0.0.0/0`，与 `policy-routing.sh` 里「默认走隧道」可能不一致。
- 修改实例或隧道后，应触发 **WG 配置刷新**（或待 Agent 同步），再 `wg show` / 抓包验证。
