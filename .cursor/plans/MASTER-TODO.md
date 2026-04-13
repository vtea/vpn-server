# 控制面相关改动 — 总 TODO 清单

> 汇总各计划与讨论中的**待修改项**；已合并到主干的「体验类」改动请自行勾选。  
> 子文档：[讨论整理](./讨论整理-待完善项.md) · [节点 ID](./节点id与地址唯一性.plan.md) · [节点管理 UI](./节点管理-展示与删除鉴权.plan.md) · [组网 IP](./节点-组网IP展示与编辑校验.plan.md) · [部署脚本](./节点部署-双地址与重复部署.plan.md)

---

## A. 稳定性与开发体验（部分可能已完成，需仓库核对）

- [x] **A1** 确认已合并：`vpn-admin-web/src/utils/jwt.js` + `App.vue` / `Admins.vue` JWT base64url 解析  
- [x] **A2** 确认已合并：`vite.config.js` `strictPort` + `package.json` `dev:56702` + `docs/build-and-run.md`  
- [x] **A3** 确认已合并：`http.js` 500 错误展示、`ListExceptions` 错误处理、SQLite `busy_timeout`、`Rules.vue` / `Users.vue` / `NetworkSegments.vue` 的 `mounted` catch  
- [x] **A4**（可选）Gin 侧统一记录 500 原因；个案 500 仍靠响应体 `error` + 终端日志  

---

## B. 节点 ID（P0 后端）

- [x] **B1** `vpn-api/internal/service/node_service.go`：实现 `NodeIDFromNumber(num)`（或等价），**删除** `BuildNodeID(name)`  
- [x] **B2** `vpn-api/internal/api/handlers.go`：`CreateNode` 使用 `NodeIDFromNumber(num)`  
- [x] **B3** `go build` / 冒烟：新建节点 ID 格式正确、与旧数据共存策略已知晓（旧 slug 不迁移）  

---

## C. 地址分配加固（可选，高并发 / PostgreSQL）

- [x] **C1** `NextNodeNumber` 移入 `CreateNode` 同一事务，或失败重试策略  
- [x] **C2** `tunnels` 表对 `subnet` 或 `(ip_a, ip_b)` 加 **UNIQUE**（按库迁移策略）  

---

## D. 节点管理 UI

- [x] **D1** `Nodes.vue`：「接入/网段」列仅展示 `enabled === true` 的实例  
- [x] **D2** `Nodes.vue`：操作列增加「编辑」（跳转 `/nodes/:id`）+「删除」改为**密码确认**流程  
- [x] **D3** `NodeDetail.vue`：主表仅展示已启用实例；**折叠区「已禁用的接入」**保留开关以便重新启用  
- [x] **D4** **vpn-api**：带管理员密码校验的删除节点接口（如 `POST /api/nodes/:id/delete`，body `{password}`）；前端对接  
- [x] **D5**（可选）`PATCH /api/nodes/:id` 支持改名称/地域/公网 IP（若产品需要表单单页编辑）  

---

## E. 组网 IP 展示与编辑

- [x] **E1** `NodeDetail.vue`（及必要时 `Nodes`）：隧道表增加 **WG 本端/对端 IP** 列；文案上突出「组网」信息  
- [x] **E2** `vpn-api/internal/service`：CIDR 解析与重叠检测工具；与其它实例冲突查询  
- [x] **E3** `PatchInstance`：扩展可选 `subnet`（及按需 `port`）；冲突时 400 + 明确 `error`  
- [x] **E4** `NodeDetail.vue`：实例子网可编辑 UI，保存走 `PATCH /api/instances/:id`  
- [x] **E5**（可选 P1）`PATCH` 隧道地址 + `/30` 冲突校验；与 Agent 配置推送联动核对  
- [x] **E6** 文档：`vpn-api/README.md` 说明可 PATCH 字段与冲突规则；高级操作风险提示  

---

## F. 部署命令双地址 + `node-setup.sh` 交互

- [x] **F1** `vpn-api/internal/config`：`EXTERNAL_URL_LAN`（或约定变量名）可选加载  
- [x] **F2** `handlers`：`CreateNode`（及返回部署命令处）输出 `deploy_command_lan`、`script_url_lan`（当 LAN URL 已配置）  
- [x] **F3** `vpn-admin-web`：节点创建成功/详情处 **两条可复制** 部署命令（LAN / 公网）  
- [x] **F4** `vpn-api/scripts/node-setup.sh`：  
  - [x] **安装 / 卸载** 交互菜单（TTY）  
  - [x] 安装路径：**已部署** → 是否清空重装；**否** → 打印 `agent.json` 的 `api_url` 等当前信息并退出  
  - [x] 抽取 **`do_uninstall` / `do_purge`** 供卸载与重装前清空  
  - [x] **非交互**模式（`--non-interactive` / `--yes` 等）与 `usage` 说明  
- [x] **F5** `docs/build-and-run.md`、`install-guide.md`、`vpn-api/README.md`：双地址与重复执行说明  
- [x] **F6**（可选）`AgentRegister` 与 bootstrap token **一次性**策略对齐（与 repair/重装流程一致）  

---

## G. 体验与文案（可选）

- [x] **G1**「添加节点」弹窗：一句说明「VPN 子网由系统按节点号与网段自动分配」  
- [x] **G2** `docs/architecture.md` 或 `install-guide`：节点 ID / 地址规划与 UI 行为交叉引用（按需）  

---

## 建议实施顺序（参考）

1. **B** → **D**（核心功能与用户安全）  
2. **F**（运维脚本与部署体验）  
3. **E**（高级 IP 编辑，依赖服务层 CIDR 工具）  
4. **C / G / A4** 按环境与时间排期  

---

*最后更新：与 `.cursor/plans` 下各子计划同步维护。*
