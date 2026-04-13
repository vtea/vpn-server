# 多站点 OpenVPN + 智能分流 + Web 管理

辣鸡 多站点 VPN 解决方案，支持节点智能分流、海外节点全局代理、Web 集中管理。

## 一键安装

```bash
# 控制面（API + Web 管理端）
bash install.sh

# 带域名和 HTTPS
bash install.sh --domain vpn.company.com

# VPN 节点
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN> --apply

# 查看帮助
bash install.sh --help
```

## 架构

```
┌─────────────┐   WebSocket   ┌──────────────┐   WireGuard   ┌──────────────┐
│  vpn-api    │◄─────────────►│  vpn-agent   │◄─────────────►│  vpn-agent   │
│  (控制面)    │               │  (上海节点)   │               │  (香港节点)   │
│  Go/Gin     │               │  OpenVPN x4  │               │  OpenVPN x2  │
│  SQLite/PG  │               │  easy-rsa    │               │  easy-rsa    │
└──────┬──────┘               │  ipset/NAT   │               │  MASQUERADE  │
       │ HTTPS                └──────────────┘               └──────────────┘
┌──────┴──────┐
│  vpn-admin  │  Vue3 + Element Plus
│  (Web 管理)  │
└─────────────┘
```

## 核心功能

- **多站点互联**：WireGuard 骨干隧道自动建立，全 mesh 拓扑
- **智能分流**：ipset + 策略路由，中国 IP 走本地，海外走隧道
- **多模式接入**：local-only / smart-split / hk-global / us-global
- **证书管理**：统一 CA + easy-rsa 自动签发/吊销/轮换
- **Web 管理**：节点/用户/授权/隧道/分流规则/审计日志全功能
- **一键部署**：环境预检 → 确认 → 自动安装，支持 Ubuntu/Debian/CentOS/Rocky
- **实时监控**：WebSocket 推送 + Prometheus 指标 + 隧道拓扑图
- **自助门户**：员工自行查看/下载 VPN 配置

## 目录结构

```
├── install.sh             # ← 一键安装入口
├── vpn-api/               # Go 后端 + Agent
│   ├── cmd/api/           # 控制面 API
│   ├── cmd/agent/         # 节点 Agent
│   ├── internal/          # 业务逻辑
│   └── scripts/           # 部署脚本、Nginx、备份
├── vpn-admin-web/         # Vue3 前端
├── docs/
│   ├── ports.md           # 默认端口约定（56700 段）
│   ├── architecture.md    # 详细技术架构
│   ├── roadmap.md         # 实施路线图
│   ├── progress.md        # 项目进度跟踪
│   ├── operations.md      # 运维手册
│   └── user-guide.md      # 用户使用指南
└── openvpn-install.sh     # 原始 OpenVPN 安装脚本（参考）
```

## 完整部署流程

```
1. 控制面服务器    →  bash install.sh
2. 浏览器登录      →  http://服务器IP (admin / admin123)
3. 添加节点        →  Web 端操作，获取 token
4. 节点服务器      →  bash install.sh --node --api-url <URL> --token <TOKEN> --apply
5. 授权用户        →  Web 端操作，下载 .ovpn 发给用户
6. 用户连接        →  导入 .ovpn，一键连接
```

## 文档

- [**默认端口说明**](docs/ports.md) — 控制面与节点 UDP/TCP 端口（自 **56700** 起）
- [**本地编译与运行（API + Web）**](docs/build-and-run.md) — `go build` / `npm run build`、开发双终端、端口与代理说明
- [**安装部署指南**](docs/install-guide.md) — 完整安装说明、参数详解、故障排查
- [详细技术架构](docs/architecture.md)
- [实施路线图](docs/roadmap.md)
- [项目进度](docs/progress.md)
- [运维手册](docs/operations.md)
- [用户使用指南](docs/user-guide.md)
