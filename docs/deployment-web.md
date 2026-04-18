# 静态管理台（vpn-web）部署要点

面向「纯静态文件 + 独立 API」场景：构建产物在 `vpn-web/dist/`，可挂任意对象存储或 Nginx。

## 构建变量

| 变量 | 说明 |
|------|------|
| `VITE_API_BASE_URL` | 控制面 API 根地址（如 `https://vpn-api.example.com` 或同域 `https://vpn.example.com`）。勿把页面端口与 API 端口混用。 |
| `BASE_URL` / `VITE_BASE` | 应用挂载路径。部署在子路径（如 `https://example.com/vpn-admin/`）时须设置 **`VITE_BASE=/vpn-admin/`**（末尾斜杠与 Nginx `location` 一致），使脚本与静态资源前缀正确。根路径部署可用默认 `/`。 |

构建：

```bash
cd vpn-web
npm ci
VITE_API_BASE_URL=https://api.example.com VITE_BASE=/admin/ npm run build
```

## Nginx 反代示例

同一主机上：页面在 `/`，API 在 `/api`，WebSocket 与 HTTP 共用路径前缀时，需显式 Upgrade 头。

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:56700;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-ID $request_id;
    proxy_read_timeout 3600s;
}

location /api/agent/ws {
    proxy_pass http://127.0.0.1:56700;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}

location /api/admin/ws {
    proxy_pass http://127.0.0.1:56700;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

`X-Request-ID` 可与后端 `middleware.RequestID` 对齐：若 Nginx 已生成 `$request_id`，会透传给 API，便于日志关联。

## 常见问题

- **刷新深链 404**：预渲染仅覆盖无动态参数的路由；`/nodes/:id` 等需配置 `try_files` 回退到 `index.html`（SPA fallback），或始终从站内进入。
- **接口 404 / CORS**：检查 `VITE_API_BASE_URL`、Nginx `location` 是否包含 `/api` 前缀；跨域时在 API 侧配置 `CORS_ALLOWED_ORIGINS`。
- **SQLite locked**：控制面单机 SQLite 高并发时可能出现；见 `vpn-api/README.md` 并发说明，响应头中的 `X-Request-ID` 便于对照日志。
