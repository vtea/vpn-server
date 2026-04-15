# vpn-api

多站点 OpenVPN 控制面后端 + 节点 Agent。

## 编译

```bash
go mod tidy
go build -o vpn-api ./cmd/api
go build -o vpn-agent ./cmd/agent

# 交叉编译 Agent (Linux)
GOOS=linux GOARCH=amd64 go build -o vpn-agent-linux ./cmd/agent

# 生产建议：注入自报版本（与升级任务、管理台「节点 agent 版本」一致）
REL="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
GOOS=linux GOARCH=amd64 go build -ldflags "-X main.buildVersion=${REL}" -o vpn-agent-linux-amd64 ./cmd/agent
```

### Agent 版本字符串（`agent_version`）

- 节点进程通过 WebSocket 上报的 `agent_version` 来自 `cmd/agent` 的 `buildVersion`（编译期 `-ldflags "-X main.buildVersion=..."`）；**未注入时**默认恒为 `0.2.1`，与代码新旧无关。
- **单一来源（推荐）**：可在 `vpn-api/` 目录放置单行 `VERSION` 文件（可选）→ 否则 `git describe --tags --always --dirty` → 否则兜底。解析逻辑集中在 [`scripts/agent-release-version.inc.sh`](scripts/agent-release-version.inc.sh)，由一键部署、根目录 [`install.sh`](../install.sh)、[`scripts/install.sh`](scripts/install.sh) 与打包脚本共用；安装入口会在执行部署前打印 **`AGENT_RELEASE_VERSION` 预览**，Phase 3 编译与 systemd **`AGENT_LATEST_VERSION`** 与其一致。
- **判断是否「拉到预期二进制」**：不要只看 UI 版本号；在控制面与节点分别计算 SHA256 对照，例如：
  - 控制面：`sha256sum /opt/vpn-api/bin/vpn-agent-linux-amd64`（或 `VPN_AGENT_BIN_DIR` 下实际文件）
  - 节点：`curl -fsSL "http://<控制面>:56700/api/downloads/vpn-agent-linux-amd64" | sha256sum`
- **可选后续**：让 `node-setup.sh` 改为注册响应里的带版本下载 URL，需控制面磁盘上存在对应版本 artifact；当前无版本端点仍为主路径，见 `handlers.go` 中 `serveVPNAgentDownload` / `ServeVPNAgentVersionedDownload`。

## 服务器可运行打包（三种方式）

### A. 一键部署（推荐）

```bash
cd vpn-api
sudo bash scripts/install.sh --yes
```

常用参数：

- `--domain vpn.example.com`：设置 `EXTERNAL_URL=https://vpn.example.com`
- `--skip-frontend`：仅部署 API
- `--http-proxy` / `--socks5`：受限网络下安装依赖与拉取模块

该入口脚本会自动识别主流 Linux 发行版并转调 `scripts/deploy-control-plane.sh`。

### B. 手工打包（二进制 + systemd）

1. 在构建机打包：

```bash
cd vpn-api
bash scripts/package-linux.sh
```

2. 上传 `dist/vpn-api-linux-bundle-<version>.tar.gz` 到服务器并部署（详见 `docs/deploy-manual.md`）。

### C. Docker / Compose

```bash
cd vpn-api
cp docker.env.example docker.env
# 修改 docker.env 中的 JWT_SECRET 与 EXTERNAL_URL
# 可选：注入与脚本一致的版本字符串（默认 compose 使用 0.2.1-docker）
#   AGENT_RELEASE_VERSION="$(git describe --tags --always --dirty)" docker compose up -d --build
docker compose up -d --build
```

持久化目录默认在 `vpn-api/docker-data/` 下。

## 运行

```bash
# 控制面
./vpn-api
# 或
go run ./cmd/api

# 环境变量
API_PORT=56700       # 监听端口（默认 56700，见 docs/ports.md）
DB_PATH=./vpn.db    # SQLite 路径（启动时会 SetMaxOpenConns(1)，避免 Windows 上并发锁表导致接口 500）
JWT_SECRET=xxx      # JWT 密钥（生产环境必须修改）
EXTERNAL_URL=...    # 控制面对外基址（公网 IP/域名）。未设置时默认为 `http://127.0.0.1:端口`。**若仍为回环**：创建节点/换发令牌时，会尽量用**当前 HTTP 请求的 Host / X-Forwarded-*** 自动推断部署命令里的地址（适用于你用公网 IP 或域名打开管理台、且反代正确传递转发头的情况）。无法可靠自动探测「公网 IP」（NAT/多网卡/离线环境）；推断失败时仍须手动设置本变量。
EXTERNAL_URL_LAN=... # 可选：仅内网可达时的第二套基址；与 EXTERNAL_URL 可同时配置（内网节点用 LAN 命令）
# AGENT_LATEST_VERSION=0.2.1   # 可选：与已部署 agent 的 buildVersion 一致时，升级默认值/推荐 URL 与节点自报一致；一键部署脚本会写入与编译相同的值
# 跨域：管理台与 API 不同源时设置（逗号分隔多个来源；仅开发可用 * 表示任意来源）
# CORS_ALLOWED_ORIGINS=https://vpn-admin.example.com,http://localhost:56701
```

### 前后端分离 / 跨域

1. **API**：设置 `CORS_ALLOWED_ORIGINS` 为管理台页面所在源（协议+主机+端口），例如 `https://vpn.example.com`。未设置时不启用 CORS 中间件（适合同域或由 Nginx 统一反代）。
2. **管理台**：构建前设置 `VITE_API_BASE_URL` 为 API 根地址（如 `https://api.example.com`），再执行 `npm run build`。开发时可在 `.env.local` 中配置并配合 `vite` 代理省略该变量。

默认管理员：`admin` / `admin123`

### OpenVPN 传输协议

- **组网网段** `default_ovpn_proto`：新建节点在某网段下生成的四套接入实例默认使用该协议（`udp` 或 `tcp`）；不同网段可不同，从而在集群中并存 UDP 与 TCP。修改某网段的默认值**不会**自动改写已有实例，除非调用 `PATCH /api/network-segments/:id` 且 body 含 `apply_to_instances: true`，或在节点详情中逐实例保存。
- **接入实例** `instances.proto`：每个实例可为 **`udp`（默认）** 或 **`tcp`**。管理台节点详情页可改；`node-setup.sh` 按注册结果写服务端 `proto`（也可用 `--openvpn-proto` 覆盖本机生成）；签发用户证书时 Agent 与控制面占位 OVPN 会与之对齐。**改协议后**需在节点上同步 `server.conf`（重装/重跑节点脚本或手工修改）并放行防火墙 **TCP 或 UDP** 对应端口。

## API 接口

### 公开
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查；响应含 `grant_purge: true` 表示支持授权物理删除接口（管理台用于自检） |
| POST | /api/auth/login | 管理员登录 |

### Agent（需 X-Node-Token / WebSocket）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/agent/register | 节点首次注册（bootstrap 令牌一次性；重复注册返回 403，需换发令牌） |
| POST | /api/agent/report | 状态上报 |
| GET | /api/agent/ws?token= | WebSocket 长连接 |

### 管理（需 Bearer Token）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/network-segments/next-values | 新建网段推荐：空闲地址第二段 + 预览监听基端口（创建时端口会重新随机，≥56714；UDP/TCP 共用端口号） |
| GET/POST/PATCH/DELETE | /api/network-segments | 组网网段列表/创建/更新/删除；创建时 **ID 与端口基址由服务端生成**；可选 `default_ovpn_proto`（udp/tcp）。`PATCH` 可选 `apply_to_instances` 将当前网段默认协议批量写入该段下已有实例 |
| GET/POST | /api/nodes | 节点列表/创建（创建体需含 `segment_ids`，可省略则等同 `["default"]`） |
| GET | /api/nodes/:id | 节点详情（含 `mesh_summary`：OpenVPN 实例子网 + WG 隧道本端 IP 汇总，无单一「组网 IP」） |
| PATCH | /api/nodes/:id | 更新名称、地域、公网地址（`public_ip` 支持 IPv4/IPv6/域名；JSON 可选字段 `name`/`region`/`public_ip`） |
| POST | /api/nodes/:id/delete | 删除节点（JSON：`{"password":"当前管理员密码"}`） |
| POST | /api/nodes/:id/rotate-bootstrap-token | 换发该节点的 bootstrap 令牌（旧令牌作废；返回新部署命令） |
| GET | /api/nodes/:id/status | 节点实时状态 |
| GET/POST | /api/nodes/:id/instances | 实例列表/创建 |
| PATCH | /api/instances/:id | 启用/禁用；可选更新 `subnet`（CIDR，需全局不冲突）、`port`、`proto`（udp/tcp） |
| GET/POST | /api/users | 用户列表/创建 |
| GET/PATCH/DELETE | /api/users/:id | 用户详情/修改/删除 |
| GET/POST | /api/users/:id/grants | 授权列表/创建 |
| GET | /api/grants/:id/download | 下载 .ovpn |
| DELETE | /api/grants/:id | 吊销授权 |
| DELETE | /api/grants/:id/purge | 永久删除授权记录（证书仍为 active 时禁止；用于清理已吊销等历史行，释放 cert_cn 唯一约束） |
| GET | /api/tunnels | 隧道列表 |
| PATCH | /api/tunnels/:id | 高级：WireGuard `/30` 子网、`ip_a`/`ip_b`、`wg_port`（须满足全局不冲突） |
| GET | /api/tunnels/:id/metrics | 隧道指标历史 |
| GET | /api/ip-list/status | IP 库状态 |
| POST | /api/ip-list/update | 触发全网 IP 库更新 |
| GET/POST | /api/ip-list/exceptions | 例外规则列表/创建 |
| DELETE | /api/ip-list/exceptions/:id | 删除例外规则 |
| GET | /api/audit-logs | 审计日志 |

## 节点部署

```bash
# Dry-run
bash scripts/node-setup.sh --api-url https://vpn-api.company.com --token <token>

# 实际执行
bash scripts/node-setup.sh --api-url https://vpn-api.company.com --token <token> --apply
```

### node-setup 下载端点（防 404 运维要点）

控制面节点部署命令依赖 `GET /api/node-setup.sh`。为避免不同 `WorkingDirectory` 造成 404，建议固定如下约定：

- systemd 环境变量：`NODE_SETUP_SCRIPT_PATH=/opt/vpn-api/scripts/node-setup.sh`
- 服务端脚本落盘：`/opt/vpn-api/scripts/node-setup.sh`
- 部署后验收：

```bash
curl -i http://127.0.0.1:56700/api/node-setup.sh
curl -i http://<公网IP>:56700/api/node-setup.sh
```

以上任一返回 `404 {"error":"node-setup.sh not found on server"}` 时，优先检查：

1. `NODE_SETUP_SCRIPT_PATH` 是否已写入 `vpn-api.service`
2. `/opt/vpn-api/scripts/node-setup.sh` 是否存在且可读
3. `systemctl restart vpn-api` 后日志是否仍提示 tried paths 不命中

当节点到外网链路不稳定时，可在执行前设置代理环境变量（`node-setup.sh` 会自动继承）：

```bash
# HTTP/HTTPS（无认证）
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890

# HTTP/HTTPS（用户名密码）
export https_proxy=http://user:password@127.0.0.1:7890
export http_proxy=http://user:password@127.0.0.1:7890

# SOCKS5（无认证）
export ALL_PROXY=socks5h://127.0.0.1:1080

# SOCKS5（用户名密码）
export ALL_PROXY=socks5h://user:password@127.0.0.1:1080
```

`node-setup.sh` 在 Step 7（NAT 规则）下载 `china_ip_list` 时，已内置“默认源（GitHub raw）失败自动回退中国镜像（jsDelivr）”。
若默认源与镜像都失败，日志会输出上述代理样式供管理员直接套用。

节点脚本会从控制面下载 **vpn-agent**（无需单独传文件）：

| 方法 | 说明 |
|------|------|
| `GET /api/downloads/vpn-agent-linux-amd64` | 查找顺序：显式环境变量 → `VPN_AGENT_BIN_DIR` → **SQLite：`DB_PATH` 为 `…/data/vpn.db` 时解析 `…/bin/`**（与进程工作目录无关）→ `{CA_DIR 上一级}/bin` → 当前目录下 `bin/` → `vpn-api` 同目录 → `/usr/local/bin` → 同架构 `vpn-agent` |
| `GET /api/downloads/vpn-agent-linux-arm64` | 同上（`VPN_AGENT_LINUX_ARM64`、文件名 `vpn-agent-linux-arm64`） |

混合架构集群：`deploy-control-plane.sh` 会交叉编译并安装到 `/usr/local/bin` 与 `/opt/vpn-api/bin/`，且 systemd 会设置 `VPN_AGENT_BIN_DIR=/opt/vpn-api/bin`。**Windows 本机调试**：在 `vpn-api` 目录执行 `.\scripts\build-agents.ps1`，将 `vpn-agent-linux-*` 生成到 `vpn-api/bin/`。

## 生产部署

1. **Nginx（自选）**：参考仓库内 [`docs/nginx-control-plane.example.conf`](../docs/nginx-control-plane.example.conf)，自行复制到 `/etc/nginx/` 并调整 `server_name`、证书路径、监听端口。
2. **HTTPS**：在反向代理或独立证书上配置（Let's Encrypt / 自签等），安装脚本不再自动申请证书。
3. 构建前端：`cd ../vpn-admin-web && npm run build && cp -r dist/* /var/www/vpn-admin/`
4. 配置备份：`crontab -e` 添加 `0 2 * * * DB_PATH=/opt/vpn-api/data/vpn.db BACKUP_DIR=/opt/vpn-api/backups /opt/vpn-api/scripts/backup.sh >> /var/log/vpn-backup.log 2>&1`

## 验收清单

```bash
# 1) API 健康
curl -sf http://127.0.0.1:56700/api/health

# 2) Agent 下载（amd64）
curl -fLo /tmp/vpn-agent-linux-amd64 http://127.0.0.1:56700/api/downloads/vpn-agent-linux-amd64

# 3) systemd 方式（如适用）
systemctl status vpn-api --no-pager

# 4) Docker 方式（如适用）
docker compose ps
```

生产环境至少确保：

- `JWT_SECRET` 已替换为强随机值
- `EXTERNAL_URL` 指向公网可达域名/IP（不能是 `127.0.0.1`）
