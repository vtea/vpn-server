# 端口约定（56700 段）

为避免运营商对常见端口（如 1194、51820、9902 等）的干扰，本项目默认端口统一从 **56700** 起规划；部署时仍可通过环境变量或控制台覆盖。

## 控制面（TCP）

| 端口 | 用途 | 说明 |
|------|------|------|
| **56700** | vpn-api（REST、Agent WS、管理端 WS） | 环境变量 `API_PORT`，默认 `56700` |
| **56701** | 管理台前端（Vite 开发 / Nginx 静态站示例） | 与 API 分离，避免与 UDP 规划混淆 |
| **56702** | 备用开发端口 | `npm run dev:56702`，`/api` 仍代理到 `56700` |

若经 Nginx/Caddy 对外，通常监听 **443** 或 **80**，再反代到本机 `127.0.0.1:56700`。

## 节点 — OpenVPN（UDP）

内置 **`default`** 组网网段使用 **UDP 起始端口（port_base）56710**，四个模式实例依次为：

| 模式序号 | UDP 端口 |
|----------|----------|
| 0（local-only） | 56710 |
| 1（hk-smart-split） | 56711 |
| 2（hk-global） | 56712 |
| 3（us-global） | 56713 |

新建其他组网网段时，支持两种方式：
- 随机分配：系统在 **[56714, 65531]** 内随机选取连续 4 个 UDP 端口，并与已有网段不重叠。
- 手动指定：可输入 `1-65531` 的监听起始端口，系统仍按连续 4 个端口占用并校验不重叠（低位端口可能需要额外系统权限）。

## 节点 — OpenVPN management（本机 TCP）

供 vpn-agent 采集在线用户，仅监听 **127.0.0.1**，默认：

按 **mode 固定映射**：

- `local-only` → `56730`
- `hk-smart-split` → `56731`
- `hk-global` → `56732`
- `us-global` → `56733`

## 节点 — WireGuard（UDP）

隧道默认监听 **56720**（模型字段 `wg_port`，可按隧道调整）。

注意：当控制面下发某条隧道缺失 `peer_pubkey` 时，`node-setup.sh` 会跳过该 peer 的 WireGuard 配置，避免生成无效 `PublicKey=` 导致 `wg-quick` 启动失败。

## 防火墙备忘

- 控制面：向公网暴露 **56700/tcp**（或经反向代理时的 **443/tcp** 等）。
- 节点：放行对应 OpenVPN **UDP**（如 56710–56713）及 WireGuard **UDP 56720**（以实例与隧道实际配置为准）。

## 部署后验收清单

以下命令用于快速确认“端口已监听 + 规则已生效”：

```bash
jq '.instances[] | {mode,port,proto,enabled}' /etc/vpn-agent/bootstrap-node.json
ss -ulnp | grep -E ':(1194|1195|1196|1197|56710|56711|56712|56713|56720)\b' || true
systemctl status openvpn-local-only.service --no-pager -l
```

若客户端仍卡在 `WAIT`，请优先按抓包判责：

```bash
tcpdump -ni any udp port 1194
```

完整排障流程见：`docs/node-troubleshooting.md`。

## 隧道健康判定（控制面）

控制面隧道状态由节点 agent 的 `health.tunnels[]` 上报融合判定，优先使用 WireGuard 指标（handshake/interface），`ping` 仅作为辅助：

- `healthy`：最近握手新鲜；
- `degraded`：握手老化或仅 ping 可达；
- `down`：连续失败达到阈值；
- `invalid_config`：配置无效（如缺失 peer 公钥）；
- `unknown`：观测不足或数据过期。

## 升级说明

若已有数据库仍使用旧默认（如 API `9902`、OpenVPN `1194` 段），不会自动改写；需在本仓库新版本上**新装**或**手动**调整 `network_segments.port_base`、实例端口、防火墙与 `.ovpn` 后再迁移。
