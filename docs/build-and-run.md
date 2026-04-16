# 本地编译与运行说明（API + Web）

适用于在开发机或服务器上**手动编译**控制面，不通过 `install.sh` 安装时使用。

**默认端口**见 **[ports.md](ports.md)**（控制面自 **56700** 段起，避免与常见被封端口冲突）。

## 环境要求

| 组件 | 要求 |
|------|------|
| **vpn-api** | Go **1.21+**（以 `vpn-api/go.mod` 为准） |
| **vpn-web** | **Node.js 18+**、**npm** 或 **pnpm** |

---

## 一、编译与运行：vpn-api（后端）

源码目录：`vpn-api/`（**没有** `package.json`，不要用 `npm` 编译）。

### 1.1 下载依赖并编译

在仓库根目录或 `vpn-api` 下执行：

```bash
cd vpn-api
go mod tidy
go build -o vpn-api.exe ./cmd/api
```

Linux / macOS 可将输出名改为 `vpn-api`（无 `.exe`）。

### 1.2 编译节点 Agent（可选）

```bash
cd vpn-api
go build -o vpn-agent.exe ./cmd/agent
# Linux 节点上常用：
# GOOS=linux GOARCH=amd64 go build -o vpn-agent-linux-amd64 ./cmd/agent
```

### 1.3 运行 API

```bash
cd vpn-api
# Windows PowerShell 示例
$env:API_PORT="56700"
$env:JWT_SECRET="请改为随机长字符串"
.\vpn-api.exe
```

或直接：

```bash
go run ./cmd/api
```

默认监听 **`:56700`**。数据库默认 **SQLite**：`./vpn.db`（可用环境变量 `DB_PATH` 指定路径）。

常用环境变量见 [`vpn-api/README.md`](../vpn-api/README.md)（`API_PORT`、`DB_PATH`、`JWT_SECRET`、`EXTERNAL_URL`、`EXTERNAL_URL_LAN`（可选，内网部署命令双地址）、`CORS_ALLOWED_ORIGINS` 等）。

### 1.4 验证

浏览器或命令行访问：

```text
GET http://127.0.0.1:56700/api/health
```

应返回 `{"status":"ok"}`。

---

## 二、编译与运行：vpn-web（管理台前端）

源码目录：`vpn-web/`。

### 2.1 安装依赖

```bash
cd vpn-web
npm install
```

### 2.2 生产构建（生成静态文件）

```bash
npm run build
```

产物在 **`vpn-web/dist/`**，由 Nginx/Caddy 或 `install.sh` 部署到站点根目录。

构建前若 API 与页面**不同源**，需设置 API 根地址（见下）。

```bash
# 示例：API 在 https://api.example.com
set VITE_API_BASE_URL=https://api.example.com
npm run build
```

### 2.3 开发模式（热更新）

```bash
npm run dev
```

若提示 **Port 56701 is already in use**：先结束占用端口的进程（多为之前未关的 `node`/`vite`），或改用 **`npm run dev:56702`**（页面在 `http://localhost:56702`，`/api` 仍代理到 56700）。

默认 **Vite 开发服务器**监听 **`:56701`**（`strictPort: true`，占用时不会自动改用 56700，以免与 **vpn-api** 默认端口冲突），并在 `vite.config.js` 里把 **`/api` 代理到 `http://127.0.0.1:56700`**。

因此本地开发时请：

1. **先启动** `vpn-api`（56700）  
2. **再启动** `npm run dev`（56701）  
3. 浏览器打开 **`http://localhost:56701`**

**不要**在「API 连接」里把 API 根地址填成 `http://localhost:56701`（那是页面地址，不是 API）。留空或填 `http://127.0.0.1:56700`；若已误填，在设置页清空或清除浏览器 `localStorage` 中 `vpn_admin_api_base_url`。

---

## 三、典型本地开发流程（双终端）

| 终端 | 目录 | 命令 |
|------|------|------|
| A | `vpn-api` | `go run ./cmd/api` |
| B | `vpn-web` | `npm run dev` |

登录默认账号（若未改种子数据）：**admin** / **admin123**。

---

## 四、与一键安装脚本的关系

生产环境推荐使用仓库根目录 **`install.sh`**：自动安装依赖、构建前端、配置 systemd、可选反向代理等，见 [**安装部署指南**](install-guide.md)。

本文仅覆盖**手动编译与本地调试**；节点侧安装仍以 `install.sh --node` 或 `vpn-api/scripts/node-setup.sh` 为准。

---

## 五、常见问题

| 现象 | 处理 |
|------|------|
| `npm run dev` 在 `vpn-api` 下报找不到 `package.json` | API 是 Go 项目，请进入 **`vpn-web`** 再执行 npm 命令。 |
| 前端请求 `/api/...` 返回 **404** | 开发时 API 应跑在 **56700**；确认 Vite 代理或 `VITE_API_BASE_URL` 指向 API，且未把 56701 填成 API 地址。 |
| 新接口（如 `POST /api/nodes/:id/rotate-bootstrap-token`）始终 **404**，但 `GET /api/health` 正常 | **56700 上的进程仍是旧二进制**：结束旧 `vpn-api`/`go run` 后重新编译并启动。自检：无 JWT 时 `POST` 该地址应返回 **401**（缺 Bearer），若仍为 **404** 则路由未加载，必为旧进程。 |
| 页面**一直转圈加载** | 多为 API 未启动或地址错误导致请求挂起。前端已对 Axios 设置约 **45s 超时**，超时后会提示并结束 loading；请仍确保 **vpn-api 在 56700 运行**。 |
| SQLite **database is locked** / 接口 **500** | 确保同一 `vpn.db` 仅由一个 `vpn-api` 进程使用；代码已对 SQLite 使用单连接，请用**最新代码**重新编译后重启。 |
| 端口被占用 | 修改 `API_PORT` 或调整 Vite `server.port`，并同步前端代理与 API 地址。 |
