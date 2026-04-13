# 节点：组网 IP 展示、可编辑与冲突校验

## 需求（相对既有「展示/删除」计划的补充）

1. **展示组网 IP 信息**  
   - 在节点详情（必要时列表摘要）中，明确展示与「组网」相关的地址信息，至少包括：  
     - **OpenVPN 侧**：各 `instance` 的 **`subnet`（如 `10.x.x.0/24`）**、端口、所属网段；当前 [`NodeDetail.vue`](openvpn-install-master/vpn-admin-web/src/views/NodeDetail.vue) 已有子网列，可再加强为「组网子网」文案或汇总卡片。  
     - **WireGuard 骨干**：[`Tunnel`](openvpn-install-master/vpn-api/internal/model/models.go) 的 **`subnet`（/30）**、`ip_a` / `ip_b`**；详情页「相关隧道」表目前仅 `subnet`，**建议增加本端/对端 WG IP 列**（按当前节点解析 `ipa/ipb`），便于运维对照。

2. **允许编辑 IP 相关信息**  
   - **现状**：[`PatchInstance`](openvpn-install-master/vpn-api/internal/api/handlers.go) 的 `patchInstanceReq` **仅含 `enabled`**，**不能**改 `subnet`/`port`。  
   - **目标**：支持对 **实例子网（及按需端口）** 的修改（高级运维场景：偏离自动规划时手调）。  
   - **WireGuard 隧道地址**：若需编辑 `/30` 与 `ip_a`/`ip_b`，需新增 **`PATCH /api/tunnels/:id`**（或节点作用域下的隧道更新接口），**工作量与风险高于仅改 instance**，建议在实现上分阶段：**先做实例子网编辑 + 冲突校验**；隧道编辑列为可选（P1）。

3. **编辑时核对与现网冲突**  
   - **实例 `subnet`（IPv4 CIDR）**：保存前在服务端校验  
     - 与**所有其他节点**的**所有实例**的 `subnet` **无 CIDR 重叠**（排除本条记录自身）；  
     - 可选：与**本网段规划**是否一致（例如仍落在 `10.{second_octet}.*`）——过严时可仅做「不重叠」+ 格式校验。  
   - **隧道 /30**：若开放编辑，需保证 **任意两条隧道的 `(ip_a, ip_b, subnet)` 不与其它隧道冲突**，且 `/30` 落在预留的 `172.16.0.0/16` 规划内（与 [`AllocateTunnelSubnet`](openvpn-install-master/vpn-api/internal/service/tunnel_service.go) 一致）。  
   - 冲突时 API 返回 **400**，`error` 信息指明与哪条资源冲突。

---

## 技术要点

| 项 | 说明 |
|----|------|
| CIDR 重叠判断 | 在 `vpn-api/internal/service` 增加工具函数：两 IPv4 CIDR 是否相交（可先规范化再比较网段范围）。 |
| PatchInstance 扩展 | `patchInstanceReq` 增加可选 `subnet`（及可选 `port`，若改端口需与多网段 UDP 规则一致）；非空则解析、校验、查库冲突后 `Save`。 |
| 审计 | 继续 `audit` patch_instance，detail 中带旧值/新值或 subnet 字符串。 |
| 前端 | 详情表「子网」列改为可编辑（行内 `el-input` + 保存，或弹窗）；保存前可做简单格式校验，**最终以服务端为准**。 |
| Agent | 配置下发依赖实例 `subnet`；修改后需触发 **配置更新**（若已有 `update_config` / 同步路径，计划中注明调用点）。 |

---

## 与「仅展示已启用接入」计划的关系

- **展示**：已启用过滤 **不冲突**；若某实例被禁用但仍需保留地址规划可见性，可在 UI 用「已禁用」折叠区展示（见 [节点管理-展示与删除鉴权.plan.md](./节点管理-展示与删除鉴权.plan.md)）。  
- **编辑子网**：通常针对**仍可能启用**的实例；禁用行若在折叠区，也应允许编辑（与开关并列）。

---

## 执行清单（实现阶段）

1. **service**：`CIDRsOverlap` / `ParseIPv4CIDR` + `InstanceSubnetConflictsWithOthers(db, excludeInstanceID, newCIDR) error`。  
2. **api**：扩展 `PatchInstance`；单元测试或手测重叠场景。  
3. **web**：`NodeDetail`（及必要时 `Nodes` 摘要）展示 WG IP；实例子网可编辑 UI。  
4. **（可选 P1）**：`PATCH` 隧道、`AllocateTunnelSubnet` 冲突复用或迁移逻辑。  
5. **文档**：[`vpn-api/README.md`](openvpn-install-master/vpn-api/README.md) 说明可 PATCH 字段与冲突规则。

---

## 风险说明

- 随意修改 `subnet` 可能导致与 **路由、NAT、AllowedIPs** 不一致；除冲突校验外，建议在 UI 标注「高级：错误配置可导致链路中断」。  
- 修改后应确保 **Agent 重载配置**（若当前未自动推送，需在计划中增加「保存后通知节点更新」的既有能力核对）。
