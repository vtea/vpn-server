# 安装部署指南

## 概述

本项目提供两个部署脚本，通过根目录的 `install.sh` 统一入口调用：

| 脚本 | 作用 | 安装内容 |
|------|------|----------|
| `install.sh` (默认) | 部署**控制面** | API 服务 + Web 静态构建 + 数据库 + CA + 备份（反向代理见 `docs/nginx-control-plane.example.conf`） |
| `install.sh --node` | 部署**VPN 节点** | OpenVPN 多实例 + WireGuard 隧道 + Agent + NAT 分流 |

一个完整的 VPN 网络至少需要：
- **1 台控制面服务器**（运行 API + Web 管理端）
- **N 台节点服务器**（运行 OpenVPN + WireGuard + Agent）
- 控制面和节点可以在同一台机器上

若需在本地**手动编译**控制面（`go build` + `npm run build`）与**双终端开发**，见 [**build-and-run.md**](build-and-run.md)。

### 组网网段（升级说明）

控制面会为每个**组网网段**维护地址第二段、OpenVPN **监听端口基址**（UDP 与 TCP 共用端口号）以及 **默认传输协议** `default_ovpn_proto`（`udp`/`tcp`）；**新建节点时必须至少选择一个网段**（可多选），在该网段下生成的四套接入实例默认使用该协议。内置 `default` 网段：`10.{节点号}.{模式序号}.0/24`，监听 **56710–56713**（默认 UDP，见 `docs/ports.md`）。在管理台「新建组网网段」时，**网段 ID 与起始端口由系统自动分配**（自 **56714** 起随机并避免与已有网段重叠）；地址第二段默认按库内空闲值预填，也可自定义并由服务端校验冲突。同一节点挂多个网段时，各网段端口区间仍须互不重叠；不同网段可选用不同默认协议以实现 UDP/TCP 并存。已有数据库在首次启动新版 API 时会自动补全 `default` 网段与节点绑定。

---

## 一、控制面安装

### 1.1 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Ubuntu 20.04/22.04/24.04, Debian 11/12, CentOS/Rocky/Alma 8/9, Fedora |
| 架构 | x86_64 (amd64) 或 aarch64 (arm64) |
| 内存 | >= 1GB |
| 磁盘 | >= 1GB 可用空间 |
| 网络 | 需要公网 IP；API 默认 **56700**；若用 Nginx/Caddy 对外，另需放行对应端口（如 80/443 或 **56701**） |
| 权限 | root |

### 1.2 安装命令

```bash
# 最简安装（交互式，会提示确认）
bash install.sh

# 绑定域名（设置 EXTERNAL_URL=https://域名；TLS 仍由你方反向代理/证书处理）
bash install.sh --domain vpn.company.com

# 跳过确认直接安装
bash install.sh --yes

# 只装 API 不构建前端（服务器没有 Node.js 或不需要 Web 端）
bash install.sh --skip-frontend

# 指定 JWT 密钥（不指定则自动生成）
bash install.sh --jwt-secret "your-secret-here"

# 组合使用
bash install.sh --domain vpn.company.com --yes
```

若节点机器**只能经内网**访问控制面，可在 API 运行环境中额外配置 `EXTERNAL_URL_LAN`（内网基址，与 `EXTERNAL_URL` 并列）。创建节点时接口与控制台会同时返回公网与内网两套部署命令。重复在已部署节点上执行安装脚本时，请使用 `node-setup.sh` 的交互菜单或 `--force-reinstall`（见 `vpn-api/scripts/node-setup.sh` 说明）。

### 1.3 安装过程详解

脚本执行分为 5 个阶段：

#### Phase 0: 环境预检

安装前会逐项检查环境，输出类似：

```
═══════════════════════════════════════════════════════════════
  VPN 控制面部署 — 环境预检
═══════════════════════════════════════════════════════════════

检查 root 权限 ...
  ✓ root 权限

检测操作系统 ...
  系统:     Ubuntu 22.04.3 LTS
  架构:     x86_64
  包管理器: apt
  ✓ Ubuntu 22.04 受支持

检查依赖项 ...

  [核心依赖]
  ✓ curl (installed)
  ✓ wget (installed)
  ✗ jq — 未安装，需要安装 jq
  ✓ sqlite3 (installed)

  [Go 编译环境]
  ✗ go — 未安装，需要安装 go

  [前端构建环境]
  ✗ node — 未安装 (可选: nodejs)
  ✗ npm — 未安装 (可选: npm)

  [VPN 组件]
  ✓ openvpn (2.5.5)
  ✗ wg — 未安装，需要安装 wireguard-tools
  ✓ ipset (installed)
  [可选组件]
  ✗ certbot — 未安装 (可选)
  ✗ easyrsa — 未安装 (可选)

检查端口占用 ...
  ✓ 端口 56700 (API (vpn-api)) 可用
  提示: 若使用 Nginx 反代静态站与 /api，请参考项目内 docs/nginx-control-plane.example.conf（本脚本不安装 Nginx）。

检查磁盘空间 ...
  ✓ /opt 可用空间 45321MB

检查源码 ...
  ✓ 源码: /opt/vpn-api/vpn-api/

═══════════════════════════════════════════════════════════════
  需要安装的软件包:
    • jq
    • Go 1.22.5 (从 go.dev 下载官方二进制)
    • Node.js 20.x LTS (从 nodesource 或官方二进制)
    • wireguard-tools

  错误: 0  |  警告: 0

  将安装 4 个软件包并开始部署，是否继续? [y/N]
```

**检查项说明：**

| 检查项 | 说明 | 失败处理 |
|--------|------|----------|
| root 权限 | 必须以 root 运行 | 阻塞，退出 |
| 操作系统 | 识别发行版和版本 | 不支持的版本给警告，继续 |
| 架构 | x86_64 或 aarch64 | 其他架构给警告 |
| 核心依赖 | curl, wget, git, jq, sqlite3 | 列入待安装列表 |
| Go | 需要 >= 1.21 | 自动安装 1.22.5 |
| Node.js | 需要 >= 16（前端构建用） | 三级 fallback 安装 |
| npm | Node.js 的包管理器 | 随 Node.js 安装 |
| VPN 组件 | openvpn, wireguard, ipset | 列入待安装列表 |
| 端口 | 56700（API） | 被占用给警告 |
| 磁盘 | >= 1GB | 不足给警告 |
| 源码 | vpn-api/go.mod 存在 | 不存在则阻塞退出 |

#### Phase 1: 安装依赖

根据预检结果自动安装缺失的软件包。

**Go 安装**：从 go.dev 下载官方二进制，安装到 `/usr/local/go/`。支持 x86_64 和 arm64。

**Node.js 安装**（三级 fallback）：

| 优先级 | 方式 | 说明 |
|--------|------|------|
| 1 | nodesource 官方源 | Ubuntu/Debian 用 deb 源，CentOS/RHEL 用 rpm 源 |
| 2 | 官方二进制包 | 从 nodejs.org 下载 tar.xz 解压到 /usr/local |
| 3 | 系统包管理器 | `apt install nodejs npm` 等（版本可能较旧） |

安装后自动确认 npm 可用。如果 npm 不存在，会单独安装。

#### Phase 2: 定位源码

自动在以下位置搜索项目源码：

1. `--source-dir` 指定的目录
2. `/opt/vpn-api/`
3. `/tmp/vpn-project/`
4. `/root/vpn-project/`
5. 脚本所在目录的上级

找到后复制到 `/opt/vpn-api/`。

#### Phase 3: 编译

```
编译 vpn-api   → /usr/local/bin/vpn-api    (API 服务二进制)
编译 vpn-agent → /usr/local/bin/vpn-agent  (节点 Agent 二进制)
构建前端       → /var/www/vpn-admin/       (Vue 静态文件)
```

#### Phase 4: 配置服务

| 服务 | 说明 |
|------|------|
| vpn-api.service | Go API 服务，默认监听 **56700** |
| （自选）Nginx/Caddy | 对外提供静态站与 `/api/` 反代，示例见 `docs/nginx-control-plane.example.conf` |
| cron | 每天 02:00 自动备份 SQLite 数据库 |

### 1.4 安装后的目录结构

```
/opt/vpn-api/
├── vpn-api/              # Go 源码（编译用）
├── vpn-admin-web/        # Vue 源码（构建用）
├── data/
│   └── vpn.db            # SQLite 数据库
├── ca/
│   └── pki/              # 统一 CA（证书签发用）
├── backups/              # 自动备份目录
└── backup.sh             # 备份脚本

/usr/local/bin/
├── vpn-api               # API 服务二进制
└── vpn-agent             # Agent 二进制

/var/www/vpn-admin/       # 前端静态文件（需自行配置 Web 服务器或反代）

/etc/systemd/system/
└── vpn-api.service       # API systemd 服务
```

### 1.5 安装完成后

```
═══════════════════════════════════════════════════════════════
  ✓ VPN 控制面部署完成！
═══════════════════════════════════════════════════════════════

  API 直连:    http://101.200.143.82:56700/api/health
  前端静态:    /var/www/vpn-admin （需自行 Nginx/Caddy 等对外提供，参见 docs/nginx-control-plane.example.conf）
  默认账号:    admin / admin123 (请尽快修改密码)
═══════════════════════════════════════════════════════════════
```

**下一步：**
1. 浏览器打开 Web 管理端
2. 用 `admin / admin123` 登录
3. 进入「节点管理」→「添加节点」
4. 复制生成的部署命令

---

## 二、VPN 节点安装

### 2.1 前提条件

- 控制面已安装并运行
- 已在 Web 管理端添加了节点，获得了 bootstrap token

### 2.2 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | 同控制面 |
| 内存 | >= 512MB |
| 网络 | 公网 IP，UDP 端口 56710–56713 和 **56720**（WireGuard）可用 |
| 权限 | root |

### 2.3 安装命令

```bash
# 先 dry-run 查看计划（不会实际执行任何操作）
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN>

# 确认无误后实际执行
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN> --apply
```

如节点网络对 GitHub 访问不稳定，可在执行节点安装前先设置代理环境变量（脚本会继承）：

```bash
# HTTP/HTTPS 代理（无认证）
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890

# HTTP/HTTPS 代理（用户名密码）
export https_proxy=http://user:password@127.0.0.1:7890
export http_proxy=http://user:password@127.0.0.1:7890

# SOCKS5 代理（无认证）
export ALL_PROXY=socks5h://127.0.0.1:1080

# SOCKS5 代理（用户名密码）
export ALL_PROXY=socks5h://user:password@127.0.0.1:1080
```

### 2.4 安装过程详解

#### 环境预检

```
═══════════════════════════════════════════════════════════════
  VPN 节点部署 — 环境预检
═══════════════════════════════════════════════════════════════

  ✓ root 权限
  系统: Ubuntu 22.04.3 LTS  包管理器: apt
  ✓ Ubuntu 22.04 受支持

检查依赖项 ...
  ✓ curl
  ✓ jq
  ✗ openvpn 未安装，将自动安装
  ✗ wg 未安装，将自动安装 wireguard-tools
  ✓ ipset
  ✓ iptables
  ⚠ easy-rsa 未安装，将自动安装或下载
  ⚠ dnsmasq 未安装 (域名分流需要)，将自动安装

检查网络 ...
  ✓ 控制面可达: http://101.200.143.82:56700

检查端口 ...
  ✓ UDP :56710 可用
  ✓ UDP :56711 可用
  ✓ UDP :56712 可用
  ✓ UDP :56713 可用
  ✓ UDP :56720 可用

═══════════════════════════════════════════════════════════════
  需要安装: openvpn wireguard-tools easy-rsa dnsmasq
  错误: 0  警告: 2
═══════════════════════════════════════════════════════════════
```

#### 9 步部署流程

| 步骤 | 内容 | 说明 |
|------|------|------|
| 1 | 向控制面注册 | 用 bootstrap token 调用 API，获取节点配置（实例列表、隧道列表、CA 证书） |
| 2 | 安装软件包 | openvpn, wireguard-tools, ipset, iptables, jq, curl, dnsmasq, easy-rsa |
| 3 | 初始化 PKI | 初始化 easy-rsa，签发服务端证书，生成 DH 参数和 TLS 密钥 |
| 4 | 渲染 OpenVPN 配置 | 为每个实例生成 server.conf（含 management port 用于在线用户采集） |
| 5 | 部署 WireGuard 隧道 | 生成密钥对，为每个 peer 创建 wg conf 并启动 |
| 6 | 配置策略路由 | 创建路由表，smart-split 模式注入中国 IP 路由 |
| 7 | 配置 NAT 规则 | 下载 china-ip-list，配置 ipset + iptables SNAT/MASQUERADE |
| 8 | 创建 systemd 服务 | 每个 OpenVPN 实例一个服务 + NAT 规则服务 |
| 9 | 安装 Agent | 写入配置，创建 systemd 服务，连接控制面 WebSocket |

> Step 7（NAT 规则）会下载 `china_ip_list`。当前脚本策略为：优先默认地址（GitHub raw），失败后自动回退中国镜像（jsDelivr）。  
> 若两者都不可达，会在日志中打印代理配置示例（支持 HTTP/HTTPS 与 SOCKS5，均支持用户名密码）。

### 2.5 安装后的目录结构

```
/etc/openvpn/server/
├── easy-rsa/              # PKI（证书签发）
│   └── pki/
├── local-only/
│   └── server.conf        # 仅本地模式
├── hk-smart-split/
│   └── server.conf        # 香港智能分流
├── hk-global/
│   └── server.conf        # 香港全局代理
└── us-global/
    └── server.conf        # 美国全局代理

/etc/wireguard/
├── privatekey
├── publickey
├── wg-hongkong.conf       # 到香港的隧道
└── wg-usa.conf            # 到美国的隧道

/etc/vpn-agent/
├── agent.json             # Agent 配置
├── bootstrap-node.json    # 注册时获取的完整配置
├── cn-ip-list.txt         # 中国 IP 列表
├── policy-routing.sh      # 策略路由脚本
├── nat-rules.sh           # NAT 规则脚本
└── exceptions.json        # 例外规则

/etc/dnsmasq.d/
└── vpn-exceptions.conf    # 域名分流配置（自动生成）

/var/log/openvpn/
├── local-only.log
├── hk-smart-split.log
└── ...
```

### 2.6 Dry-run 模式

不加 `--apply` 时脚本以 dry-run 模式运行，**只做预检不执行任何操作**（不注册、不安装、不修改系统）：

```bash
bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN>
```

输出预检结果后退出，不会调用 API 注册（避免消耗一次性 token）。

---

## 三、同一台机器同时作为控制面和节点

```bash
# 1. 先安装控制面
bash install.sh

# 2. 登录 Web 端，添加本机为节点，获取 token

# 3. 安装节点（使用 127.0.0.1 连接本地 API）
bash install.sh --node --api-url http://127.0.0.1:56700 --token <TOKEN> --apply
```

---

## 四、参数速查表

### install.sh

| 参数 | 说明 | 默认值 |
|------|------|--------|
| (无参数) | 安装控制面 | — |
| `--node` | 安装 VPN 节点 | — |
| `--domain DOMAIN` | 设置 `EXTERNAL_URL=https://DOMAIN` | 无 |
| `--skip-frontend` | 跳过前端构建 | 构建 |
| `--jwt-secret SECRET` | 指定 JWT 密钥 | 自动生成 |
| `--source-dir DIR` | 指定源码目录 | 自动搜索 |
| `--yes`, `-y` | 跳过所有确认 | 交互确认 |
| `--help`, `-h` | 显示帮助 | — |

### install.sh --node

| 参数 | 说明 | 必填 |
|------|------|------|
| `--api-url URL` | 控制面 API 地址 | 是 |
| `--token TOKEN` | 节点 bootstrap token | 是 |
| `--apply` | 实际执行（否则 dry-run） | 否 |

---

## 五、安装后管理

### 服务管理

```bash
# 控制面
systemctl status vpn-api          # API 状态
systemctl restart vpn-api         # 重启 API
journalctl -u vpn-api -f          # 实时日志
# 若已自行安装 Nginx：systemctl status nginx

# 节点
systemctl status openvpn-local-only       # OpenVPN 实例
systemctl status openvpn-hk-smart-split
systemctl status vpn-agent                # Agent
systemctl status wg-quick@wg-hongkong     # WireGuard 隧道
journalctl -u vpn-agent -f               # Agent 日志
```

### 常用运维

```bash
# 手动备份数据库
bash /opt/vpn-api/backup.sh

# 查看 WireGuard 隧道状态
wg show

# 查看 ipset 规则
ipset list china-ip | head -20

# 查看策略路由
ip rule show
ip route show table 101

# 查看在线 VPN 用户
echo "status" | nc 127.0.0.1 56730
```

### 卸载

```bash
# 控制面
systemctl stop vpn-api
systemctl disable vpn-api
rm -f /etc/systemd/system/vpn-api.service
# 若曾配置 Nginx：rm -f /etc/nginx/sites-enabled/vpn /etc/nginx/conf.d/vpn.conf
rm -rf /opt/vpn-api /var/www/vpn-admin
rm -f /usr/local/bin/vpn-api /usr/local/bin/vpn-agent

# 节点
systemctl stop vpn-agent openvpn-* wg-quick@*
systemctl disable vpn-agent openvpn-* wg-quick@*
rm -f /etc/systemd/system/openvpn-*.service /etc/systemd/system/vpn-agent.service /etc/systemd/system/vpn-routing.service
rm -rf /etc/openvpn/server /etc/wireguard /etc/vpn-agent
rm -f /usr/local/bin/vpn-agent
systemctl daemon-reload
```

---

## 六、故障排查

| 问题 | 排查 |
|------|------|
| 预检报错"源码未找到" | 确认在项目根目录运行 `bash install.sh`，或用 `--source-dir` 指定 |
| Go 编译失败 | 检查 `go version`，需要 >= 1.21。删除 `/usr/local/go` 重新运行 |
| 前端构建失败 | 检查 `node --version` 和 `npm --version`。可用 `--skip-frontend` 跳过 |
| API 启动失败 | `journalctl -u vpn-api -n 50` 查看日志 |
| Nginx 配置错误 | `nginx -t` 检查语法 |
| 节点注册失败 | 确认 token 正确且未使用过，确认控制面可达 |
| WireGuard 隧道不通 | `wg show` 查看状态，确认对端公钥正确，防火墙放行 UDP 56720 |
| 智能分流不生效 | `ip rule show` 和 `ipset list china-ip | wc -l` 检查规则 |
| 卡在 Step 7（Configuring NAT rules） | 多数是 `china_ip_list` 下载受阻。脚本会自动“默认源→中国镜像”回退；若仍失败，请配置代理后重试（支持 `http_proxy/https_proxy`、`ALL_PROXY=socks5h://`，可带 `user:password@`） |

更多故障排查见 [运维手册](operations.md)。
