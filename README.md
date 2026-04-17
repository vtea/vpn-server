# 黑蜘蛛

多站点 VPN 解决方案，支持节点智能分流、海外节点全局代理、Web 集中管理。

## 快速开始

```bash
# 控制面（交互安装，推荐）
bash install.sh

# 控制面（非交互）
bash install.sh --yes

# 控制面（设置域名，EXTERNAL_URL=https://<domain>）
bash install.sh --domain vpn.company.com

# 节点（先 dry-run 预检）
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN>

# 节点（实际执行）
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN> --apply

# 查看帮助
bash install.sh --help
```

控制面访问口径：
- 开发场景常见为 `http://<控制面IP>:56701`（Vite dev）
- 生产场景通常为你配置的反向代理地址（如 `https://<domain>`）
- API 默认端口为 `56700`（详见 `docs/ports.md`）

## 架构概览

```text
┌─────────────┐   WebSocket   ┌──────────────┐   WireGuard   ┌──────────────┐
│  vpn-api    │◄─────────────►│  vpn-agent   │◄─────────────►│  vpn-agent   │
│  控制面 API  │               │  节点 A       │               │  节点 B       │
│  Go + Gin   │               │  OpenVPN实例   │               │  OpenVPN实例   │
│  SQLite/PG  │               │  策略路由/NAT  │               │  策略路由/NAT  │
└──────┬──────┘               └──────────────┘               └──────────────┘
       │ HTTP/HTTPS
┌──────┴──────┐
│ vpn-web      │  Vue3 + Element Plus
│ Web 管理端   │
└─────────────┘
```

当前能力要点：
- 控制面管理节点、用户、授权、隧道、分流规则与审计
- 节点通过 `vpn-agent` 与控制面保持连接并上报状态
- OpenVPN 接入实例支持按网段配置默认协议（UDP/TCP）
- 节点间通过 WireGuard 组成骨干互联，配合策略路由实现智能分流

## 部署脚本入口矩阵

### 统一入口（推荐）
- `install.sh`：根目录统一入口，自动转调控制面或节点部署脚本

### `vpn-api/scripts` 子脚本（高级场景）
- `vpn-api/scripts/deploy-control-plane.sh`：控制面部署脚本
- `vpn-api/scripts/node-setup.sh`：节点安装/注册脚本
- `vpn-api/scripts/install.sh`：`vpn-api` 子目录安装入口
- `vpn-api/scripts/package-linux.sh`：手工打包（Linux bundle）
- `vpn-api/scripts/backup.sh`：数据库备份
- `vpn-api/scripts/build-agents.ps1`：Windows 本机构建 Linux Agent 二进制

建议：
- 日常部署优先使用根 `install.sh`
- 运维自动化、CI 或二次封装时，再直接调用 `vpn-api/scripts/*`

## 节点服务器部署说明（详版）

### 1) 前提条件
- 控制面已安装完成并可访问（`/api/health` 正常）
- 已在管理端创建节点并获取一次性 `bootstrap token`
- 节点服务器具备 root 权限，可连通控制面 API

### 2) 安装命令（先 dry-run）

```bash
# 推荐：仅预检，不改系统
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN>

# 确认后执行实际安装
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN> --apply
```

也可直接调用子脚本：

```bash
bash vpn-api/scripts/node-setup.sh --api-url http://控制面IP:56700 --token <TOKEN>
bash vpn-api/scripts/node-setup.sh --api-url http://控制面IP:56700 --token <TOKEN> --apply
```

### 3) 网络与端口
- 节点必须可访问 `--api-url` 指向的控制面
- 需放行 OpenVPN/WireGuard 对应端口（按你的网段与实例配置）
- 具体端口清单以 `docs/ports.md` 为准

### 4) 部署后验证

```bash
systemctl status vpn-agent
systemctl status openvpn-local-only
systemctl status wg-quick@wg-hongkong
journalctl -u vpn-agent -f
```

说明：
- 实际 OpenVPN/WireGuard 服务名会随节点配置变化
- 建议同时在管理端确认节点在线状态与实例状态

### 5) 常见问题
- `token` 已失效或已使用：在管理端换发后重试
- 节点无法连通控制面：检查 API 地址、防火墙、路由与 DNS
- 端口被占用：按 `docs/ports.md` 调整并重试
- NAT/IP 列表下载失败：按安装日志提示配置 HTTP/SOCKS5 代理

## 前后端分离部署

适用于 `vpn-api` 与 `vpn-web` 分别部署在不同域名/主机的场景。

### 1) API 侧配置（CORS）

在 `vpn-api` 运行环境中设置管理端来源，多个来源用逗号分隔：

```bash
# 仅示例，请按实际管理端域名填写
export CORS_ALLOWED_ORIGINS="https://vpn-admin.example.com,http://localhost:56701"
export EXTERNAL_URL="https://api.example.com"
```

说明：
- 未设置 `CORS_ALLOWED_ORIGINS` 时，API 默认不启用跨域放行
- 生产环境不要使用 `*`

### 2) 前端侧构建（指定 API 根地址）

在 `vpn-web` 构建前指定 API 地址：

```bash
cd vpn-web
export VITE_API_BASE_URL="https://api.example.com"
npm install
npm run build
```

构建产物在 `vpn-web/dist/`，可部署到 Nginx/Caddy/静态站点服务。

### 3) 反向代理建议

- 前端域名：`https://vpn-admin.example.com`（托管 `dist`）
- API 域名：`https://api.example.com`（反代到 `vpn-api`，默认后端监听 `56700`）
- 若你希望同域部署，也可由同一反代统一转发静态资源与 `/api`（例如 `location /api/ { proxy_pass http://127.0.0.1:56700; ... }`）

**前端路由**：管理台默认 **Hash 模式**（URL 含 `#/`，如 `/#/settings/api`），**刷新只请求 `/`**，宝塔/Nginx **不必**为前端路由配置伪静态。若部署在 **Vercel** 且希望地址栏无 `#`，根目录选 `vpn-web`，可使用 [`vpn-web/vercel.json`](vpn-web/vercel.json) 并改用 History 模式（需自行改 `router/index.js`）。

## 目录结构

```text
├── install.sh                      # 根部署入口（推荐）
├── vpn-api/                        # Go 后端 + Agent
│   ├── cmd/api/                    # 控制面 API
│   ├── cmd/agent/                  # 节点 Agent
│   ├── internal/                   # 业务逻辑
│   ├── scripts/                    # 控制面/节点/备份/打包脚本
│   └── docs/deploy-manual.md       # 手工打包部署
├── vpn-web/                        # Vue3 前端（src/、dist/）
├── docs/
│   ├── ports.md
│   ├── install-guide.md
│   ├── build-and-run.md
│   ├── operations.md
│   ├── user-guide.md
│   ├── architecture.md
│   ├── roadmap.md
│   └── progress.md
└── openvpn-install.sh              # 原始 OpenVPN 安装脚本（参考）
```

## 完整部署流程

```text
1. 控制面服务器    -> bash install.sh
2. 访问管理端      -> 开发常见 http://<IP>:56701；生产常见 https://<domain>
3. 添加节点        -> 管理端创建节点并获取 token
4. 节点服务器      -> 先 dry-run，再 --apply 执行安装
5. 授权用户        -> 管理端下载 .ovpn 发放
6. 用户连接        -> 客户端导入 .ovpn 连接
```

## 文档导航

- [默认端口说明](docs/ports.md) — 控制面与节点端口约定
- [安装部署指南](docs/install-guide.md) — 控制面/节点安装、参数与排障
- [本地编译与运行（API + Web）](docs/build-and-run.md) — 开发调试与双终端流程
- [运维手册](docs/operations.md) — 线上运维与故障处理
- [用户使用指南](docs/user-guide.md) — 管理端使用流程
- [详细技术架构](docs/architecture.md)
- [手工打包部署（vpn-api）](vpn-api/docs/deploy-manual.md)
- [实施路线图](docs/roadmap.md)
- [项目进度](docs/progress.md)
