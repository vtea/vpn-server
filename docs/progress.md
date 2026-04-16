# 项目进度跟踪

> 最后更新：2026-04-12（第七轮 — 安装部署指南文档）
> 对照文档：[architecture.md](./architecture.md) | [roadmap.md](./roadmap.md)

---

## 一、总体进度

| 阶段 | 状态 | 完成度 | 说明 |
|------|------|--------|------|
| P0 基础规划 | ✅ 完成 | 100% | 地址规划、技术选型、架构设计 |
| P1 控制面 + 骨干隧道 | ✅ 完成 | 100% | API、数据库、JWT、WireGuard 隧道模型 |
| P2 多实例 + 分流 + 部署 | ✅ 完成 | 100% | 多实例 server.conf、策略路由、Agent、node-setup.sh |
| P3 Web 管理端 + IP 库 | ✅ 完成 | 95% | 全功能 Web UI、IP 库自动更新、例外规则 |
| P4 全面上线 + 运维 | 🟡 就绪 | 70% | 文档已写，需实际部署验证 |

---

## 二、文件清单与功能映射

### 后端 (`vpn-api/`)

| 文件 | 功能 | 状态 |
|------|------|------|
| `cmd/api/main.go` | API 入口，路由注册，DB 初始化，种子数据 | ✅ |
| `cmd/agent/main.go` | 节点 Agent：WS 长连接、证书操作、健康上报、IP 库更新、在线用户采集 | ✅ |
| `internal/model/models.go` | 10 个数据模型：Admin, Node, Instance, User, UserGrant, NodeBootstrapToken, Tunnel, TunnelMetric, IPListException, AuditLog | ✅ |
| `internal/api/handlers.go` | 30+ 个 HTTP handler（完整 CRUD） | ✅ |
| `internal/api/ws_hub.go` | WebSocket Hub：Agent 连接管理、指令下发、健康/证书/IP库结果接收 | ✅ |
| `internal/service/node_service.go` | 节点号自动分配、默认实例生成 | ✅ |
| `internal/service/tunnel_service.go` | 隧道子网自动分配、peer 配置构建 | ✅ |
| `internal/service/easyrsa_service.go` | easy-rsa 封装：PKI 初始化、证书签发/吊销、.ovpn 生成 | ✅ |
| `internal/service/bootstrap_service.go` | Bootstrap token 生成、占位 .ovpn 构建 | ✅ |
| `internal/middleware/auth.go` | JWT 认证中间件 | ✅ |
| `internal/config/config.go` | 环境变量配置加载 | ✅ |

### 前端 (`vpn-web/`)

| 文件 | 功能 | 状态 |
|------|------|------|
| `src/views/Login.vue` | 管理员登录 | ✅ |
| `src/views/Dashboard.vue` | 仪表盘：4 统计卡片 + 节点状态表 + 最近操作时间线 | ✅ |
| `src/views/Nodes.vue` | 节点列表：搜索/筛选 + 添加对话框 + 部署命令 + 删除 | ✅ |
| `src/views/NodeDetail.vue` | 节点详情：基本信息 + 实例列表（启用/禁用开关）+ 相关隧道 | ✅ |
| `src/views/Users.vue` | 用户管理：搜索/筛选 + 添加/编辑/删除 + 授权对话框（授权/下载/吊销）| ✅ |
| `src/views/Rules.vue` | 分流规则：IP 库状态表 + 全网更新按钮 + 例外规则 CRUD | ✅ |
| `src/views/Tunnels.vue` | 隧道状态：SVG 拓扑图（节点圆环+连线+延迟标注）+ 隧道列表 | ✅ |
| `src/views/Audit.vue` | 审计日志：搜索/筛选 + 分页 + 导出 CSV | ✅ |
| `src/api/http.js` | Axios 封装：自动附加 JWT、401 自动跳转登录 | ✅ |
| `src/router/index.js` | 路由配置 + 认证守卫 | ✅ |
| `src/App.vue` | 整体布局：侧边栏 + 顶栏 + 主内容区 | ✅ |

### 脚本与配置

| 文件 | 功能 | 状态 |
|------|------|------|
| `scripts/node-setup.sh` | 一键部署脚本（9 步：注册→安装→PKI→OpenVPN→WireGuard→策略路由→NAT→systemd→Agent）| ✅ |
| `docs/nginx-control-plane.example.conf` | Nginx 反代示例（HTTPS + WebSocket + 前端静态文件，运维自备）| ✅ |
| `scripts/backup.sh` | SQLite 定时备份脚本（.backup + gzip + 自动清理）| ✅ |

### 文档

| 文件 | 内容 | 状态 |
|------|------|------|
| `docs/architecture.md` | 详细技术架构（地址规划、配置模板、数据模型、API 设计、UI 线框图）| ✅ |
| `docs/roadmap.md` | 分阶段实施路线图（P0-P4，10 周计划）| ✅ |
| `docs/operations.md` | 运维手册（10 个常见场景）| ✅ |
| `docs/user-guide.md` | 用户使用指南（安装客户端、导入配置、模式说明、FAQ）| ✅ |
| `docs/progress.md` | 本文件 — 项目进度跟踪 | ✅ |

---

## 三、API 接口完成度

### 已实现（30 个）

```
公开接口：
  GET  /api/health
  POST /api/auth/login

Agent 接口：
  POST /api/agent/register
  POST /api/agent/report
  GET  /api/agent/ws              (WebSocket)

管理接口（需 Bearer Token）：
  GET/POST       /api/nodes
  GET/DELETE      /api/nodes/:id
  GET             /api/nodes/:id/status
  GET/POST        /api/nodes/:id/instances
  PATCH           /api/instances/:id
  GET/POST        /api/users
  GET/PATCH/DELETE /api/users/:id
  GET/POST        /api/users/:id/grants
  GET             /api/grants/:id/download
  DELETE          /api/grants/:id
  GET             /api/tunnels
  GET             /api/tunnels/:id/metrics
  GET             /api/ip-list/status
  POST            /api/ip-list/update
  GET/POST        /api/ip-list/exceptions
  DELETE          /api/ip-list/exceptions/:id
  GET             /api/audit-logs
```

### architecture.md 中设计但未实现的接口

| 接口 | 优先级 | 说明 |
|------|--------|------|
| `GET /api/nodes/:id/instances` 独立接口 | 低 | 已通过 GetNode 返回 instances，也有独立的 ListNodeInstances |
| 审计日志分页参数（`?page=&limit=`） | 中 | 当前后端固定返回最新 100 条，前端做了客户端分页 |

---

## 四、Agent 功能完成度

| 功能 | 状态 | 说明 |
|------|------|------|
| WebSocket 长连接 + 自动重连 | ✅ | 10 秒重连间隔 |
| 心跳上报（30s） | ✅ | |
| 启动时上报 Agent 版本 + WG 公钥 | ✅ | |
| 接收 `issue_cert` → easy-rsa 签发 → 回传 .ovpn | ✅ | |
| 接收 `revoke_cert` → easy-rsa 吊销 + gen-crl | ✅ | |
| 接收 `update_config` → 保存到本地 | ✅ | |
| 接收 `update_iplist` → 下载+ipset swap+回传版本 | ✅ | |
| 定时 IP 库更新（每天 03:00） | ✅ | |
| IP 库异常检测（变化 >5% 中止） | ✅ | |
| 健康上报（60s）：WG ping 延迟/丢包 | ✅ | 通过 WS `health` 消息上报 |
| 在线用户采集：OpenVPN management interface | ✅ | 通过 TCP 连接 management port 读取 CLIENT_LIST |

---

## 五、node-setup.sh 部署流程（9 步）

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1 | 向控制面注册，获取节点配置（实例+隧道） | ✅ |
| 2 | 安装 openvpn, wireguard-tools, ipset, easy-rsa, jq | ✅ |
| 3 | 初始化 easy-rsa PKI，签发服务端证书，生成 DH | ✅ |
| 4 | 渲染每个实例的 server.conf | ✅ |
| 5 | 部署 WireGuard 隧道（生成密钥、创建 conf、启动） | ✅ |
| 6 | 配置策略路由（ip rule + 路由表 101/102/103） | ✅ |
| 7 | 配置 NAT 规则（ipset china-ip + iptables SNAT/MASQUERADE） | ✅ |
| 8 | 创建 systemd 服务并启动 | ✅ |
| 9 | 安装 vpn-agent 并连接控制面 | ✅ |

---

## 六、已知限制与后续优化方向

### 当前限制

| 项目 | 说明 | 影响 | 优化建议 |
|------|------|------|----------|
| **dnsmasq 需预装** | 域名例外规则依赖节点上安装 dnsmasq | 未安装 dnsmasq 的节点域名例外不生效 | node-setup.sh 可自动安装 dnsmasq |
| **负载均衡为策略级** | 通过管理员按用户分配不同出口实例实现，非自动流量均衡 | 需要管理员手动调整 | 后续可做基于延迟的自动选路 |
| **自助门户依赖管理员 token** | 当前员工自助门户复用管理员 JWT 查询 | 安全性不够独立 | 后续可添加独立的用户认证（如 LDAP/SSO） |

### 已修复/已实现（2026-04-12 第二轮）

| 项目 | 修复内容 |
|------|----------|
| ~~management port 未配置~~ | node-setup.sh Step 4 已添加 `management 127.0.0.1 750x` |
| ~~例外规则未下发~~ | 新增 `update_exceptions` WS 消息，增删时自动广播，Agent 注入 ipset |
| ~~审计日志无服务端分页~~ | 后端支持 `?page=&limit=` 参数 |

### 已实现的增强功能（2026-04-12 第三轮）

| # | 功能 | 实现内容 |
|---|------|----------|
| 1 | **统一 CA** | `service/ca_service.go` 控制面维护全网 CA，Agent 注册时下发 ca_bundle（ca.crt + tls-crypt key + CRL） |
| 2 | **前端 WebSocket 实时推送** | `admin_ws.go` AdminWSHub，节点上下线/健康数据变化实时广播到管理端 WS |
| 3 | **SQLite/PostgreSQL 切换** | `config.go` 新增 `DB_DRIVER` 环境变量，`main.go` 支持 sqlite/postgres 双驱动 |
| 4 | **隧道拓扑图升级** | Tunnels.vue 支持节点拖拽、丢包标注、在线人数显示、状态发光效果 |
| 5 | **域名例外规则** | Agent `generateDnsmasqConfig()` 生成 `/etc/dnsmasq.d/vpn-exceptions.conf`，域名解析结果注入 ipset |
| 6 | **隧道自动故障切换** | Agent `monitorTunnelFailover()` 每 30s 检测隧道，断开时自动 restart wg-quick |
| 7 | **出境节点负载均衡** | 通过多实例（global/sg-global）+ 管理员按用户分配实现策略级均衡 |
| 8 | **员工自助门户** | `SelfService.vue` 用户输入用户名查看/下载自己的 .ovpn，无需管理员介入 |
| 9 | **短期证书自动轮换** | Agent `cronCertRenewal()` 每天检查证书到期时间，≤30 天自动续签 |
| 10 | **Prometheus 指标** | `GET /api/metrics` 暴露 nodes/users/tunnels/grants/online_users 指标 |
| 11 | **多管理员 + RBAC** | `GET/POST/DELETE /api/admins`，admin 角色可管理其他管理员，viewer 角色只读 |
| 12 | **配置版本回滚** | `ConfigVersion` 模型 + `GET /api/config/versions` + `POST /api/config/rollback/:version` |

### 可选功能完成度

| 功能 | 状态 | 说明 |
|------|------|------|
| 隧道自动故障切换 | ✅ 已实现 | Agent `monitorTunnelFailover()` 每 30s 检测，断开自动 restart |
| 出境节点负载均衡 | ✅ 策略级 | 通过多实例 + 管理员按用户分配实现 |
| 员工自助门户 | ✅ 已实现 | `SelfService.vue` 用户自行查看/下载 .ovpn |
| 短期证书自动轮换 | ✅ 已实现 | Agent `cronCertRenewal()` 每天检查，≤30 天自动续签 |
| Prometheus/Grafana | ✅ 已实现 | `GET /api/metrics` 暴露 Prometheus 格式指标 |
| 多管理员 + RBAC | ✅ 已实现 | `GET/POST/DELETE /api/admins`，admin/viewer 角色 |
| 配置版本回滚 | ✅ 已实现 | `ConfigVersion` 模型 + 版本列表 + 一键回滚 |

---

## 七、编译与部署验证记录

| 检查项 | 结果 | 日期 |
|--------|------|------|
| `go vet ./...` | ✅ 零警告 | 2026-04-12 |
| `go build ./cmd/api` | ✅ 成功 | 2026-04-12 |
| `go build ./cmd/agent` | ✅ 成功 | 2026-04-12 |
| `npx vite build` (前端) | ✅ 成功 (1662 modules, 3.49s) | 2026-04-12 |
| BOM 编码问题 | ✅ 已修复 | go.mod / package.json 使用 UTF-8 无 BOM |
| Bug 修复后重新验证 | ✅ 全部通过 (mgmt port + 例外下发 + 分页) | 2026-04-12 |
| 第三轮全量验证 (12 项增强) | ✅ go vet + build api/agent + vite build 全部通过 | 2026-04-12 |
| 第四轮脚本审查修复 (10 个问题) | ✅ deploy + node-setup 脚本全面修复 | 2026-04-12 |

### 第四轮脚本审查修复清单

| # | 问题 | 修复 |
|---|------|------|
| 1 | deploy 源码路径假设错误 | 改为自动探测多个候选目录 |
| 2 | Nginx sites-available 在 CentOS 不存在 | 自动检测 sites-available vs conf.d |
| 3 | Node.js 安装在非 Debian 系统失败 | 按 PKG 类型分别用 deb/rpm nodesource |
| 4 | certbot 包名不同 | 改为 2>/dev/null 容错安装 |
| 5 | vpn-api --help 会报错 | 改为 ls -lh 显示文件大小 |
| 6 | dry-run 也调用 API 注册 | 移到 dry-run 判断之后 |
| 7 | easy-rsa 复制路径不可靠 | 遍历多个候选路径 + fallback 下载 |
| 8 | WG 多隧道共用 ListenPort | 仅第一个隧道绑定端口，其余自动分配 |
| 9 | declare -A 需要 bash 4+ | 改用临时文件目录替代关联数组 |
| 10 | tls-crypt genkey 兼容性 | 先尝试 secret，再尝试 tls-crypt-v2，最后 fallback |
| 11 | Node.js/npm 安装不健壮 | 三级 fallback：nodesource → 官方二进制 → 系统包；确保 npm 可用 |
| 12 | 前端构建不支持 yarn | 自动检测 npm/yarn，都没有时尝试安装 npm |
| 13 | node-setup 未安装 dnsmasq | 包列表添加 dnsmasq，启用 systemd 服务 |

### 第五轮：环境预检机制（2026-04-12）

两个脚本均新增完整的 Phase 0 环境预检：

**deploy-control-plane.sh 预检项：**
- root 权限检查
- OS 识别 + 版本兼容性判断（Ubuntu 20/22/24, Debian 11/12, CentOS/Rocky 8/9, Fedora）
- 架构检测（x86_64/aarch64）
- 依赖逐一检查（curl/wget/git/jq/sqlite3/go/node/npm/openvpn/wg/ipset；certbot/easyrsa 可选）
- Go/Node.js 版本检查（Go >= 1.21, Node >= 16）
- 端口占用检查（默认 API 56700）
- 磁盘空间检查（>= 1GB）
- 源码存在性检查
- 汇总报告 + 用户确认后才开始安装

**node-setup.sh 预检项：**
- root 权限检查
- OS 识别 + 版本兼容性判断
- 8 项依赖逐一检查（curl/jq/openvpn/wg/ipset/iptables/easyrsa/dnsmasq）
- 控制面网络连通性测试
- 5 个 UDP 端口占用检查（56710–56713, 56720）
- IP 转发状态检查
- 汇总报告

**Node.js 安装三级 fallback：**
1. nodesource 官方源（apt/rpm）
2. Node.js 官方二进制包下载
3. 系统包管理器默认版本
+ npm 可用性保障 + yarn fallback

---

## 八、快速恢复开发指南

如果后续需要继续开发，按以下步骤恢复环境：

```bash
# 1. 后端
cd vpn-api
go mod tidy
go run ./cmd/api          # 启动 API（默认 :56700）

# 2. 前端
cd vpn-web
npm install
npm run dev               # 启动开发服务器（默认 :56701，代理 /api 到 :56700）

# 3. 编译 Agent（Linux 目标）
cd vpn-api
GOOS=linux GOARCH=amd64 go build -o vpn-agent ./cmd/agent

# 4. 部署新节点
# 在 Web 端添加节点 → 复制部署命令 → SSH 到服务器执行
```

### 关键文件修改指引

| 要改什么 | 改哪里 |
|----------|--------|
| 添加新 API 接口 | `internal/api/handlers.go` + `cmd/api/main.go`（注册路由） |
| 修改数据模型 | `internal/model/models.go` + `cmd/api/main.go`（AutoMigrate） |
| 修改 Agent 行为 | `cmd/agent/main.go` |
| 修改 WebSocket 消息处理 | `internal/api/ws_hub.go` |
| 添加新前端页面 | `src/views/Xxx.vue` + `src/router/index.js` |
| 修改节点部署流程 | `scripts/node-setup.sh` |
| 修改分流/NAT 规则 | `scripts/node-setup.sh` 中的 `policy-routing.sh` 和 `nat-rules.sh` |
