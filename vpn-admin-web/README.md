# vpn-admin-web (MVP)

Vue 3 管理端骨架，已接入以下页面：

- 登录页（默认账号：admin / admin123）
- 仪表盘
- 节点管理
- 用户管理
- 分流规则（占位）
- 隧道状态（占位）
- 审计日志

## 运行

```bash
npm install
npm run dev
```

默认端口 `56701`，并已在 `vite.config.js` 配置了 API 代理：

- `/api/*` -> `http://127.0.0.1:56700`

请先在本机启动控制面 API（在 `vpn-api` 目录执行 `go run ./cmd/api` 或 `API_PORT=56700 ./vpn-api`），否则浏览器里登录会出现连接失败或代理返回 5xx。

**运行时配置 API 地址**：登录页可展开「API 地址」，或登录后左侧菜单 **「API 连接」**，填写控制面根 URL（如 `https://api.example.com`），保存后写入浏览器本地存储，无需重新构建。未填写时使用构建时 `VITE_API_BASE_URL` 或同域 `/api/…`。

**域名 / 穿透访问 dev 或 `vite preview`**：Vite 会校验 HTTP `Host`。默认未设置 `DEV_ALLOWED_HOSTS` 时，`vite.config.js` 已对 dev/preview 使用 `allowedHosts: true`，一般不再出现 “This host is not allowed”。若你改为显式白名单，可在启动前设置环境变量（逗号分隔多个域名），例如 `DEV_ALLOWED_HOSTS=nawan.cn2.ltd,other.example.com`，**修改后需重启** `npm run dev` 或 `npm run preview` 进程。线上若用 `npm run build` 的静态文件由 Nginx 等托管，则不经过 Vite 服务器，与此项无关。

## 构建

```bash
npm run build
```
