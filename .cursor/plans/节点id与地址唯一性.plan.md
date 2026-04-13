# 节点 ID 与地址/组网唯一性（计划补充）

## 目标

- 节点主键 `id` 系统生成、避免同名冲突（见原「节点 ID 系统生成」方案：`NodeIDFromNumber(num)`）。
- **部署后各层 IP 唯一**，与**其它节点组网**时路由/AllowedIPs 一致、不重叠。

---

## 当前实现中的唯一性依据

### 1. OpenVPN 侧 `10.x`（`instances.subnet`）

- **default 网段**（`SecondOctet == 0`）：`10.{node_number}.{mode_idx}.0/24`（[`BuildInstancesForMembership`](vpn-api/internal/service/node_service.go)）。
  - `node_number` 在 [`model.Node`](vpn-api/internal/model/models.go) 上 **`uniqueIndex`**，不同节点不会共用同一 `node_number`，故 **default 下各节点 VPN 子网互不重叠**。
- **非 default 网段**：`10.{second_octet}.{slot*4+mode_idx}.0/24`，`slot` 由 [`NextSegmentSlot`](vpn-api/internal/service/node_service.go) 在 **创建节点的事务内** 按 `segment_id` 取 `MAX(slot)+1`（[`CreateNode` 事务内调用 `NextSegmentSlot(tx, …)`](vpn-api/internal/api/handlers.go)）。
  - 同一网段内槽位递增，且 `slot ≤ 63`，使 `slot*4+3 ≤ 255`，避免第三段溢出。
- **同节点多网段**：[`ValidateSegmentsPortOverlap`](vpn-api/internal/service/node_service.go) 校验各网段 UDP 端口区间不重叠。

### 2. WireGuard 骨干 `172.16.0.0/16`（隧道 `/30`）

- [`AllocateTunnelSubnet`](vpn-api/internal/service/tunnel_service.go)：按当前 `tunnels` **行数** × 4 作为字节偏移，顺序划分 `/30`，为每条新隧道分配 **不同** `subnet` 与 `ip_a`/`ip_b`。
- [`CreateTunnelsForNewNode`](vpn-api/internal/service/tunnel_service.go) 在 **创建节点的事务内** 为新节点与每个已有节点各建一条隧道，循环内每次 `Create` 后 `Count` 增加，后续偏移递增。

### 3. 组网语义（节点如何互通）

- [`BuildTunnelConfigsForNode`](vpn-api/internal/service/tunnel_service.go)：`AllowedIPs` 包含对端 `peer_ip/32` 及对端 **全部 instance 的 `subnet`**，使 WG 能转发到对端各 OpenVPN 网段。

---

## 残余风险与可选加固（执行阶段可择一）

| 风险 | 说明 | 可选措施 |
|------|------|----------|
| `node_number` 预取在事务外 | [`NextNodeNumber`](vpn-api/internal/service/node_service.go) 在 `Transaction` **之前**调用；高并发下两请求可能读到相同 `MAX` 后同时插入 | 将 **取号** 移入事务，或依赖 DB 唯一约束失败重试；SQLite 写锁通常已弱化并发 |
| `tunnels.subnet` 无唯一索引 | 极端并发下理论可能重复插入相同 `/30`（PostgreSQL 多连接时） | 为 `subnet` 或 `(ip_a, ip_b)` 加 **UNIQUE**，冲突则重试/回滚 |
| 非 default 槽位 | 槽位在事务内分配，SQLite 单写者下一般安全 | Postgres 下可提高隔离级别或 `SELECT … FOR UPDATE` 锁网段行（若引入多写） |

---

## 执行清单（与「节点 ID」方案合并）

1. **实现 `NodeIDFromNumber(num)`**，删除基于名称的 `BuildNodeID`；`CreateNode` 使用新 ID。
2. **（可选）** 将 `NextNodeNumber` 移入 `CreateNode` 的同一事务，或在唯一约束失败时返回明确错误并重试。
3. **（可选）** 隧道表 `subnet` 唯一约束 + 文档说明。
4. **（可选）** 管理台「添加节点」弹窗增加一句说明：VPN 子网与 WG `/30` 由系统按规则自动分配，无需手填。

---

## 结论（对用户问题的直接回答）

在**当前设计**下，只要 **`node_number` 唯一**、**每网段槽位递增正确**、**隧道 `/30` 顺序分配未被破坏**，则：

- 各节点 **OpenVPN 地址池**在规划上**互斥**；
- **WG 隧道地址**按序分配，**不重复**；
- **与已有节点新增隧道**时，`CreateTunnelsForNewNode` 会为每个旧节点各建一条隧道并分配新 `/30`，**后续组网**由 Agent 按 API 下发的 `TunnelPeerConfig`（含 AllowedIPs）落地。

执行「节点 ID 系统生成」后，**避免因 `id` 与名称绑定导致的异常**，与上述地址规则一起，可满足「部署后 IP 规划唯一、多节点组网一致」的设计目标；若生产环境为 **PostgreSQL 高并发创建节点**，建议落实表内 **可选加固** 项。
