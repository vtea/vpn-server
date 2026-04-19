# 多站点 OpenVPN + 智能分流 + Web 管理 — 详细实施方案

## 技术选型确认

- **Web 前端**：Vue 3 + Vite + Element Plus（组件库）+ Pinia（状态管理）
- **Web 后端**：Go 1.22+ + Gin + GORM
- **数据库**：SQLite（<50 人规模足够，单文件部署简单；后期可换 PostgreSQL）
- **Node Agent**：Go 单二进制（和 API 共用部分代码）
- **VPN 认证**：仅证书（无 RADIUS），easy-rsa 管理 PKI，由 API 封装调用
- **骨干隧道**：WireGuard
- **分流**：服务端 ipset + nftables/iptables
- **节点 OS**：混合支持（Ubuntu 22+、Debian 11+、CentOS/Rocky/Alma 9+、Fedora）
- **规模**：< 50 人同时在线

### 与仓库实现、管理台 UI 的交叉引用（G2）

| 主题 | 说明 |
|------|------|
| **节点 ID** | 控制面生成格式为 `node-{node_number}`（与节点号十进制对应）；列表/详情页展示即数据库主键。 |
| **OpenVPN 子网** | 按节点号与所选组网网段、槽位自动分配（见下文 1.1）；管理台「添加节点」弹窗有简要提示。 |
| **删除节点** | 需管理员密码：`POST /api/nodes/:id/delete`（实现见 `vpn-api` 路由与 `DeleteNodeWithPassword`）。 |
| **Bootstrap 令牌** | 仅首次 `POST /api/agent/register` 有效；重装需在控制台「重新生成部署令牌」或调用 `POST /api/nodes/:id/rotate-bootstrap-token`。 |
| **WireGuard 隧道 /30** | 骨干地址池见 1.2；高级编辑走 `PATCH /api/tunnels/:id`（须为 /30，且子网与端点 IP 全局不冲突）。 |
| **总清单** | 以仓库 Issue / 迭代记录与 `vpn-api`、`vpn-web` 源码为准（原 `.cursor/plans` 清单不随仓库分发）。 |

---

## 一、地址规划（P0）

### 1.1 OpenVPN 子网编码

```
总池：10.0.0.0/8 中取 10.{节点号}.{实例号}.0/24

节点号分配：
  10 = 上海      20 = 北京      30 = 广东
  40 = 香港      50 = 美国      60 = 新加坡
  70~250 = 预留给未来节点

实例号固定：
  0 = node-direct       (端口 56710)
  1 = cn-split          (端口 56711)
  2 = global            (端口 56712)
  4~9 = 预留给未来出境节点

示例 - 上海节点(10)：
  node-direct:     server 10.10.0.0 255.255.255.0  (port 56710)
  cn-split:        server 10.10.1.0 255.255.255.0  (port 56711)
  global:          server 10.10.2.0 255.255.255.0  (port 56712)

示例 - 香港节点(40)：
  node-direct:     server 10.40.0.0 255.255.255.0  (port 56710)
  （香港节点通常不需要 cn-split/global，因为本身就在香港）
  global:          server 10.40.2.0 255.255.255.0  (port 56712)
```

### 1.2 WireGuard 骨干隧道地址

```
骨干网段：172.16.0.0/24
每条隧道用 /30（2 个可用 IP）

编号规则：按节点对排序，每对占 4 个 IP
  上海↔北京:    172.16.0.0/30   (.1 ↔ .2)
  上海↔广东:    172.16.0.4/30   (.5 ↔ .6)
  上海↔香港:    172.16.0.8/30   (.9 ↔ .10)
  上海↔美国:    172.16.0.12/30  (.13 ↔ .14)
  上海↔新加坡:  172.16.0.16/30  (.17 ↔ .18)
  北京↔香港:    172.16.0.20/30  (.21 ↔ .22)
  广东↔香港:    172.16.0.24/30  (.25 ↔ .26)
  香港↔美国:    172.16.0.28/30  (.29 ↔ .30)
  香港↔新加坡:  172.16.0.32/30  (.33 ↔ .34)
  美国↔新加坡:  172.16.0.36/30  (.37 ↔ .38)

WireGuard 监听端口：56720（所有节点统一，见 docs/ports.md）
```

### 1.3 控制面地址

控制面（API + Web + SQLite）部署在任意一台服务器上（推荐云主机或某个节点上），监听端口（默认见 `docs/ports.md`）：
- Web 前端：**56701**（开发/Vite 或 Nginx 静态站），生产可经 **443**（Nginx 反代）
- API 与 Agent WebSocket：**56700/tcp**（同一进程；`/api/agent/ws` 与 REST 同源）

---

## 二、每个节点的完整配置细节（P2）

### 2.1 目录结构

```
/etc/openvpn/
├── server/
│   ├── shared/                          # 所有实例共享
│   │   ├── ca.crt                       # CA 证书（全网统一）
│   │   ├── dh.pem                       # DH 参数
│   │   ├── tc.key                       # tls-crypt 密钥
│   │   └── crl.pem                      # 证书吊销列表
│   ├── node-direct/
│   │   ├── server.conf
│   │   ├── server.crt
│   │   ├── server.key
│   │   └── ipp.txt
│   ├── cn-split/
│   │   ├── server.conf
│   │   ├── server.crt
│   │   ├── server.key
│   │   └── ipp.txt
│   ├── global/
│   │   └── ...
│   └── ...
├── client-configs/                      # 生成的 .ovpn 文件暂存
│   ├── zhangsan-node-direct.ovpn
│   ├── zhangsan-cn-split.ovpn
│   └── ...

/etc/wireguard/
├── wg-shanghai.conf                     # （非上海节点才有）
├── wg-hongkong.conf
├── wg-usa.conf
└── ...

/etc/vpn-agent/
├── agent.yaml                           # Agent 配置
├── cn-ip-list.txt                       # 国内 IP 库原始文件
└── cn-ip-list.ipset                     # ipset restore 格式

/etc/nftables.d/                         # 或 /etc/iptables.d/（按 OS）
├── 10-node-direct.rules
├── 20-cn-split.rules
└── 30-global.rules
```

### 2.2 各实例 server.conf 详细配置

**node-direct 实例**（最基础，等同原始脚本）：

```ini
# /etc/openvpn/server/node-direct/server.conf
local 0.0.0.0
port 56710
proto udp
dev tun-local
ca /etc/openvpn/server/shared/ca.crt
cert /etc/openvpn/server/node-direct/server.crt
key /etc/openvpn/server/node-direct/server.key
dh /etc/openvpn/server/shared/dh.pem
auth SHA512
tls-crypt /etc/openvpn/server/shared/tc.key
topology subnet
server 10.10.0.0 255.255.255.0
ifconfig-pool-persist /etc/openvpn/server/node-direct/ipp.txt
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 8.8.8.8"
push "dhcp-option DNS 8.8.4.4"
push "block-outside-dns"
keepalive 10 120
user nobody
group nogroup
persist-key
persist-tun
verb 3
crl-verify /etc/openvpn/server/shared/crl.pem
explicit-exit-notify
management 127.0.0.1 56730
```

NAT 规则（iptables，兼容所有 OS）：
```bash
iptables -t nat -A POSTROUTING -s 10.10.0.0/24 ! -d 10.10.0.0/24 -j SNAT --to $LOCAL_PUBLIC_IP
iptables -I FORWARD -s 10.10.0.0/24 -j ACCEPT
iptables -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
```

**global 实例**（所有流量走指定出口）：

```ini
# /etc/openvpn/server/global/server.conf
local 0.0.0.0
port 56712
proto udp
dev tun-hkglobal
ca /etc/openvpn/server/shared/ca.crt
cert /etc/openvpn/server/global/server.crt
key /etc/openvpn/server/global/server.key
dh /etc/openvpn/server/shared/dh.pem
auth SHA512
tls-crypt /etc/openvpn/server/shared/tc.key
topology subnet
server 10.10.2.0 255.255.255.0
ifconfig-pool-persist /etc/openvpn/server/global/ipp.txt
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 8.8.8.8"
push "dhcp-option DNS 8.8.4.4"
push "block-outside-dns"
keepalive 10 120
user nobody
group nogroup
persist-key
persist-tun
verb 3
crl-verify /etc/openvpn/server/shared/crl.pem
explicit-exit-notify
management 127.0.0.1 56732
```

NAT/路由规则：
```bash
ip route add default via 172.16.0.10 dev wg-hongkong table 102
ip rule add from 10.10.2.0/24 lookup 102 prio 100
iptables -I FORWARD -s 10.10.2.0/24 -o wg-hongkong -j ACCEPT
iptables -I FORWARD -i wg-hongkong -d 10.10.2.0/24 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

香港节点上对应的出境 NAT：
```bash
iptables -t nat -A POSTROUTING -s 10.10.2.0/24 -o eth0 -j MASQUERADE
iptables -I FORWARD -s 10.10.2.0/24 -j ACCEPT
iptables -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
```

**cn-split 实例**（核心：国内走本地，境外走出口）：

**选路与双库说明**：`cn-split` 在数据面上**仅依赖国内 IP 段列表 + 路由表 default 指向出口**即可实现分流；控制面仍维护国内、海外两套制品，但当前脚本未用海外库参与选路。详见 [operations.md](operations.md) 第 8.2 节「国内库与海外库在数据面上的作用」及其中 **cn-split 路由决策（仅国内库）** 小节。

```ini
# /etc/openvpn/server/cn-split/server.conf
local 0.0.0.0
port 56711
proto udp
dev tun-hksplit
ca /etc/openvpn/server/shared/ca.crt
cert /etc/openvpn/server/cn-split/server.crt
key /etc/openvpn/server/cn-split/server.key
dh /etc/openvpn/server/shared/dh.pem
auth SHA512
tls-crypt /etc/openvpn/server/shared/tc.key
topology subnet
server 10.10.1.0 255.255.255.0
ifconfig-pool-persist /etc/openvpn/server/cn-split/ipp.txt
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 119.29.29.29"
push "dhcp-option DNS 8.8.8.8"
push "block-outside-dns"
keepalive 10 120
user nobody
group nogroup
persist-key
persist-tun
verb 3
crl-verify /etc/openvpn/server/shared/crl.pem
explicit-exit-notify
management 127.0.0.1 56731
```

NAT/路由规则（关键）：
```bash
# 1. 创建 ipset 并加载国内 IP 库
ipset create cn_net hash:net maxelem 65536
ipset restore < /etc/vpn-agent/cn-ip-list.ipset

# 2. 默认路由走出口隧道（路由表 101）
ip route add default via 172.16.0.10 dev wg-hongkong table 101
ip rule add from 10.10.1.0/24 lookup 101 prio 100

# 3. 国内 IP 走本地出口
#    由 Agent 从 cn-ip-list.txt 生成并注入 table 101

# 4. NAT 按出接口区分
iptables -t nat -A POSTROUTING -s 10.10.1.0/24 -o eth0 -j SNAT --to $LOCAL_PUBLIC_IP

# 5. FORWARD 放行
iptables -I FORWARD -s 10.10.1.0/24 -j ACCEPT
iptables -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
```

**智能分流路由表注入脚本**（Agent 执行）：
```bash
#!/bin/bash
# inject-cn-routes.sh
LOCAL_GW=$(ip route | grep default | awk '{print $3}')
LOCAL_DEV=$(ip route | grep default | awk '{print $5}')

ip route flush table 101 2>/dev/null
ip route add default via 172.16.0.10 dev wg-hongkong table 101

while IFS= read -r cidr; do
  ip route add "$cidr" via "$LOCAL_GW" dev "$LOCAL_DEV" table 101 2>/dev/null
done < /etc/vpn-agent/cn-ip-list.txt

echo "Injected $(wc -l < /etc/vpn-agent/cn-ip-list.txt) CN routes into table 101"
```

### 2.3 WireGuard 配置示例

上海节点 `/etc/wireguard/wg-hongkong.conf`：
```ini
[Interface]
PrivateKey = <上海节点私钥>
Address = 172.16.0.9/30
Table = off

[Peer]
PublicKey = <香港节点公钥>
Endpoint = <香港公网IP>:56720
AllowedIPs = 172.16.0.10/32, 10.40.0.0/16
PersistentKeepalive = 25
```

香港节点 `/etc/wireguard/wg-shanghai.conf`：
```ini
[Interface]
PrivateKey = <香港节点私钥>
Address = 172.16.0.10/30
Table = off

[Peer]
PublicKey = <上海节点公钥>
Endpoint = <上海公网IP>:56720
AllowedIPs = 172.16.0.9/32, 10.10.0.0/16
PersistentKeepalive = 25
```

### 2.4 systemd 服务文件

每个 OpenVPN 实例一个服务：
```ini
# /etc/systemd/system/openvpn-node-direct.service
[Unit]
Description=OpenVPN Local Only Instance
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/sbin/openvpn --config /etc/openvpn/server/node-direct/server.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

NAT 规则服务（每个实例一个）：
```ini
# /etc/systemd/system/vpn-nat-cn-split.service
[Unit]
Description=NAT rules for cn-split OpenVPN instance
After=network-online.target openvpn-cn-split.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/etc/nftables.d/20-cn-split.rules start
ExecStop=/etc/nftables.d/20-cn-split.rules stop

[Install]
WantedBy=multi-user.target
```

---

## 三、Node Agent 详细设计（P2）

### 3.1 Agent 配置文件

```yaml
# /etc/vpn-agent/agent.yaml
api_url: "https://vpn-api.company.com:56700"
node_token: "eyJhbGciOiJIUzI1NiIs..."
node_id: "shanghai"
node_number: 10

cn_ip_list:
  source: "https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt"
  update_cron: "0 3 * * *"
  max_change_pct: 5
  ipset_name: "cn_net"

log_file: "/var/log/vpn-agent/agent.log"
```

### 3.2 Agent 核心功能（Go 实现）

```
vpn-agent 二进制，约 5 个 goroutine：

1. WebSocket 长连接到 API
   - 接收：策略变更通知、IP 库更新指令、强制重连用户指令
   - 发送：心跳（每 30s）、状态上报（每 60s：在线用户数、隧道状态、IP 库版本）

2. 定时任务
   - 每天 3:00 拉取国内 IP 库，diff + ipset swap
   - 每 60s 从各 OpenVPN management interface 读取在线用户列表

3. 配置渲染与应用
   - 收到策略变更时：
     a. 从 API 拉取完整配置（JSON）
     b. 渲染 server.conf / iptables rules / WireGuard conf
     c. 原子应用（先写临时文件，校验，再 mv + reload）
     d. 上报结果

4. 健康检查
   - 每 30s ping 所有 WireGuard peer，记录延迟和丢包
   - 检查各 OpenVPN 实例进程是否存活

5. 证书操作代理
   - 收到 API 的「签发证书」指令时，调用本地 easy-rsa 生成客户端证书
   - 收到「吊销证书」指令时，调用 easy-rsa revoke + gen-crl
   - 将生成的 .ovpn 文件上传到 API 供管理员下载
```

### 3.3 国内 IP 库更新详细流程

```bash
# Agent 内部逻辑（Go 实现，此处用伪 bash 描述）

# 1. 下载新列表
curl -fsSL $SOURCE_URL -o /tmp/cn-ip-new.txt

# 2. 对比
OLD_COUNT=$(wc -l < /etc/vpn-agent/cn-ip-list.txt)
NEW_COUNT=$(wc -l < /tmp/cn-ip-new.txt)
DIFF_PCT=$(( (NEW_COUNT - OLD_COUNT) * 100 / OLD_COUNT ))

# 3. 校验（变化 >5% 则告警不自动更新）
if [ ${DIFF_PCT#-} -gt 5 ]; then
  report_to_api "ip_list_anomaly" "$DIFF_PCT%"
  exit 0
fi

# 4. 生成 ipset restore 格式
echo "create cn_net_new hash:net maxelem 65536" > /tmp/cn-ip-new.ipset
while read cidr; do
  echo "add cn_net_new $cidr" >> /tmp/cn-ip-new.ipset
done < /tmp/cn-ip-new.txt

# 5. 原子更新
ipset restore < /tmp/cn-ip-new.ipset
ipset swap cn_net cn_net_new
ipset destroy cn_net_new

# 6. 更新路由表（智能分流实例）
/etc/vpn-agent/inject-cn-routes.sh

# 7. 保存新列表
mv /tmp/cn-ip-new.txt /etc/vpn-agent/cn-ip-list.txt
mv /tmp/cn-ip-new.ipset /etc/vpn-agent/cn-ip-list.ipset

# 8. 上报
report_to_api "ip_list_updated" "version=$(date +%Y%m%d) count=$NEW_COUNT"
```

---

## 四、控制面 API 详细设计（P1/P3）

### 4.1 数据模型（SQLite）

```sql
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    node_number INTEGER UNIQUE NOT NULL,
    region      TEXT NOT NULL,
    public_ip   TEXT NOT NULL,
    wg_pubkey   TEXT,
    status      TEXT DEFAULT 'offline',
    agent_version TEXT,
    config_version INTEGER DEFAULT 0,
    ip_list_version TEXT,
    last_heartbeat DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE instances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     TEXT REFERENCES nodes(id),
    mode        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    subnet      TEXT NOT NULL,
    exit_node   TEXT,
    enabled     BOOLEAN DEFAULT TRUE,
    UNIQUE(node_id, mode)
);

CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    display_name TEXT,
    group_name  TEXT DEFAULT 'default',
    status      TEXT DEFAULT 'active',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_grants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    instance_id INTEGER REFERENCES instances(id),
    cert_cn     TEXT,
    cert_status TEXT DEFAULT 'active',
    ovpn_file   BLOB,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, instance_id)
);

CREATE TABLE tunnels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_a      TEXT REFERENCES nodes(id),
    node_b      TEXT REFERENCES nodes(id),
    subnet      TEXT NOT NULL,
    ip_a        TEXT NOT NULL,
    ip_b        TEXT NOT NULL,
    status      TEXT DEFAULT 'unknown',
    latency_ms  REAL,
    loss_pct    REAL,
    UNIQUE(node_a, node_b)
);

CREATE TABLE audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user  TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT,
    detail      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT DEFAULT 'admin',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 API 路由设计

```
认证：
  POST   /api/auth/login              管理员登录（返回 JWT）

节点管理：
  GET    /api/nodes                    列出所有节点
  POST   /api/nodes                    添加节点（自动分配节点号+IP段，返回部署命令）
  GET    /api/nodes/:id                节点详情（含实例列表、隧道状态）
  DELETE /api/nodes/:id                删除节点
  GET    /api/nodes/:id/status         实时状态（在线用户、隧道延迟）

实例管理：
  GET    /api/nodes/:id/instances      该节点的所有实例
  POST   /api/nodes/:id/instances      添加实例（如新增 sg-global）
  PATCH  /api/instances/:id            启用/禁用实例

用户管理：
  GET    /api/users                    用户列表（含在线状态、授权的实例）
  POST   /api/users                    创建用户
  GET    /api/users/:id                用户详情
  PATCH  /api/users/:id                修改用户（组、状态）
  DELETE /api/users/:id                删除用户（吊销所有证书）

授权管理（核心）：
  POST   /api/users/:id/grants         授权用户访问某实例（触发证书签发+生成.ovpn）
  DELETE /api/grants/:id               撤销授权（触发证书吊销）
  GET    /api/grants/:id/download      下载 .ovpn 文件

分流规则：
  GET    /api/ip-list/status           各节点 IP 库版本
  POST   /api/ip-list/update           触发全网更新
  GET    /api/ip-list/exceptions       手工例外规则列表
  POST   /api/ip-list/exceptions       添加例外
  DELETE /api/ip-list/exceptions/:id   删除例外

隧道：
  GET    /api/tunnels                  所有隧道状态
  GET    /api/tunnels/:id/metrics      隧道延迟/丢包历史

审计：
  GET    /api/audit-logs               审计日志（分页、筛选）

Agent 接口（WebSocket + REST）：
  WS     /api/agent/ws                 Agent 长连接
  POST   /api/agent/register           Agent 首次注册
  POST   /api/agent/report             Agent 上报状态
```

### 4.3 核心业务流程：授权用户访问某实例

```
管理员在 Web 上操作：给张三授权「上海节点 - 国内分流」

1. Web 调 POST /api/users/zhangsan/grants
   body: { instance_id: 5 }

2. API 处理：
   a. 生成证书 CN: "zhangsan-sh-hksplit"
   b. 通过 WebSocket 发指令给上海节点 Agent：
      { action: "issue_cert", cn: "zhangsan-sh-hksplit" }
   c. Agent 在上海节点执行：
      cd /etc/openvpn/server/easy-rsa/
      ./easyrsa --batch --days=3650 build-client-full "zhangsan-sh-hksplit" nopass
   d. Agent 生成 .ovpn 文件（用 cn-split 实例的 client-common.txt 模板 + 证书内联）
   e. Agent 将 .ovpn 内容上传回 API
   f. API 存入 user_grants.ovpn_file

3. 管理员在 Web 上点「下载配置」，获得 zhangsan-sh-hksplit.ovpn
4. 管理员将文件发给张三
5. 张三导入 .ovpn → 连接上海节点 56711 端口 → 流量自动分流
```

---

## 五、Web 管理端 UI 设计（P3）

### 5.1 整体布局

```
┌──────────────────────────────────────────────────────────┐
│  LOGO  VPN管理中心          [管理员: admin]  [退出]       │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  侧边导航  │              主内容区                        │
│            │                                             │
│  ▸ 仪表盘  │                                             │
│  ▸ 节点管理 │                                             │
│  ▸ 用户管理 │                                             │
│  ▸ 策略中心 │                                             │
│  ▸ 分流规则 │                                             │
│  ▸ 隧道状态 │                                             │
│  ▸ 审计日志 │                                             │
│  ▸ 系统设置 │                                             │
│            │                                             │
└────────────┴─────────────────────────────────────────────┘
```

### 5.2 仪表盘

```
┌─────────────────────────────────────────────────────────┐
│  仪表盘                                                  │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ 在线用户  │ 节点总数  │ 健康隧道  │ IP库版本  │              │
│   12     │   6/6    │  10/10   │ 2026-04  │              │
│  ↑3      │  全部在线  │  全部正常  │ 3天前更新 │              │
├──────────┴──────────┴──────────┴──────────┴──────────────┤
│  节点状态概览                                              │
│  ┌──────┬────────┬────────┬──────┬────────┐              │
│  │ 节点  │ 状态   │ 在线用户│ 延迟  │ 实例数  │              │
│  ├──────┼────────┼────────┼──────┼────────┤              │
│  │ 上海  │ 在线   │   5    │  -   │  4/4   │              │
│  │ 北京  │ 在线   │   3    │ 28ms │  4/4   │              │
│  │ 广东  │ 在线   │   2    │ 15ms │  4/4   │              │
│  │ 香港  │ 在线   │   1    │ 35ms │  2/2   │              │
│  │ 美国  │ 在线   │   1    │180ms │  2/2   │              │
│  │ 新加坡│ 在线   │   0    │ 65ms │  2/2   │              │
│  └──────┴────────┴────────┴──────┴────────┘              │
│                                                          │
│  最近操作                                                 │
│  • admin 授权 李四 访问 上海-国内分流         2分钟前        │
│  • admin 吊销 王五 的 上海-全局 证书          1小时前        │
│  • 系统 更新国内IP库至 2026-04-12 版本       3小时前        │
└──────────────────────────────────────────────────────────┘
```

### 5.3 节点管理

**节点列表**：
```
┌─────────────────────────────────────────────────────────┐
│  节点管理                              [+ 添加节点]       │
├──────────────────────────────────────────────────────────┤
│  搜索: [__________]   地域: [全部 ▾]   状态: [全部 ▾]     │
├──────────────────────────────────────────────────────────┤
│  ┌─ 上海节点 ──────────────────────────────────────────┐ │
│  │ 节点号: 10  │  IP: 203.x.x.x  │  地域: 中国        │ │
│  │ 状态: 在线   │  Agent: v1.2.0  │  配置版本: v15     │ │
│  │                                                     │ │
│  │ 实例:                                               │ │
│  │  node-direct    :56710  10.10.0.0/24   3人在线       │ │
│  │  cn-split       :56711  10.10.1.0/24   2人在线       │ │
│  │  global         :56712  10.10.2.0/24   0人在线       │ │
│  │                                                     │ │
│  │ 隧道:                                               │ │
│  │  → 香港  35ms  0%丢包  │  → 美国  180ms  0.1%丢包  │ │
│  │  → 北京  28ms  0%丢包  │  → 广东  15ms   0%丢包    │ │
│  │                                    [管理] [详情]     │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**添加节点对话框**：
```
┌─────────────────────────────────────────┐
│  添加新节点                              │
├─────────────────────────────────────────┤
│  节点名称:  [________________]           │
│  地域:      [中国 ▾]                     │
│  公网 IP:   [________________]           │
│                                         │
│  需要的实例:                             │
│  [x] 节点直连 (node-direct)             │
│  [x] 国内分流 (cn-split)                │
│  [x] 全局 (global)                      │
│  [ ] 新加坡全局 (sg-global)              │
│                                         │
│  ─── 自动分配结果（预览）───              │
│  节点号: 70                              │
│  子网: 10.70.0.0/24 ~ 10.70.3.0/24     │
│  隧道: 6条 (到所有现有节点)              │
│                                         │
│          [取消]    [确认添加]             │
├─────────────────────────────────────────┤
│  节点已创建！在新服务器上执行：           │
│  ┌─────────────────────────────────┐    │
│  │ curl -fsSL https://vpn-api...  │    │
│  │   | bash -s -- --token eyJ...  │    │
│  └─────────────────────────────────┘    │
│  执行后节点将自动上线。                   │
└─────────────────────────────────────────┘
```

### 5.4 用户管理

**用户列表**：
```
┌─────────────────────────────────────────────────────────┐
│  用户管理                               [+ 添加用户]      │
├──────────────────────────────────────────────────────────┤
│  搜索: [__________]   组: [全部 ▾]   状态: [全部 ▾]       │
├──────┬──────┬──────┬──────────────────┬──────┬──────────┤
│ 用户名│ 姓名  │ 部门  │ 已授权实例        │ 在线  │ 操作     │
├──────┼──────┼──────┼──────────────────┼──────┼──────────┤
│zhangsan│张三 │研发部 │ 上海-本地         │ 在线  │[编辑][授权]│
│       │      │      │ 上海-港智能分流    │      │          │
├──────┼──────┼──────┼──────────────────┼──────┼──────────┤
│lisi   │李四  │财务部 │ 上海-本地         │ 离线  │[编辑][授权]│
├──────┼──────┼──────┼──────────────────┼──────┼──────────┤
│wangwu │王五  │海外部 │ 上海-本地         │ 在线  │[编辑][授权]│
│       │      │      │ 上海-港智能分流    │      │          │
│       │      │      │ 上海-美全局        │      │          │
└──────┴──────┴──────┴──────────────────┴──────┴──────────┘
```

**用户授权对话框**：
```
┌─────────────────────────────────────────────────────────┐
│  管理授权 - 张三 (zhangsan)                              │
├─────────────────────────────────────────────────────────┤
│  当前授权:                                               │
│  ┌────────────────────────────┬────────┬───────────────┐ │
│  │ 实例                       │ 状态   │ 操作          │ │
│  ├────────────────────────────┼────────┼───────────────┤ │
│  │ 上海 → 仅本地              │ 有效   │ [下载] [吊销] │ │
│  │ 上海 → 国内分流             │ 有效   │ [下载] [吊销] │ │
│  └────────────────────────────┴────────┴───────────────┘ │
│                                                          │
│  添加新授权:                                             │
│  接入节点: [上海 ▾]                                      │
│  流量模式: [全局代理 ▾]                                   │
│                                                          │
│  说明: 授权后将自动签发证书并生成 .ovpn 配置文件。         │
│  管理员下载后发给用户即可使用。                            │
│                              [取消]    [确认授权]         │
└─────────────────────────────────────────────────────────┘
```

### 5.5 分流规则

```
┌─────────────────────────────────────────────────────────┐
│  分流规则                                                │
├─────────────────────────────────────────────────────────┤
│  国内 IP 库状态                          [全网立即更新]    │
│  ┌──────┬────────────┬────────┬──────────────────┐      │
│  │ 节点  │ IP库版本    │ 条目数  │ 最后更新          │      │
│  ├──────┼────────────┼────────┼──────────────────┤      │
│  │ 上海  │ 2026-04-12 │ 8,234  │ 今天 03:00       │      │
│  │ 北京  │ 2026-04-12 │ 8,234  │ 今天 03:01       │      │
│  │ 广东  │ 2026-04-12 │ 8,234  │ 今天 03:00       │      │
│  │ 香港  │ 2026-04-12 │ 8,234  │ 今天 03:02       │      │
│  │ 美国  │ 2026-04-11 │ 8,230  │ 昨天 03:00 (!)   │      │
│  │ 新加坡│ 2026-04-12 │ 8,234  │ 今天 03:01       │      │
│  └──────┴────────────┴────────┴──────────────────┘      │
│                                                          │
│  手工例外规则                             [+ 添加规则]     │
│  ┌──────────────────┬──────┬──────┬──────────────┐      │
│  │ 规则              │ 类型  │ 方向  │ 操作         │      │
│  ├──────────────────┼──────┼──────┼──────────────┤      │
│  │ 104.16.0.0/12    │ IP段  │ 走境外│ [编辑] [删除]│      │
│  │ *.notion.so       │ 域名  │ 走境外│ [编辑] [删除]│      │
│  │ 203.119.0.0/16   │ IP段  │ 走国内│ [编辑] [删除]│      │
│  └──────────────────┴──────┴──────┴──────────────┘      │
│                                                          │
│  IP 库同步源配置                                          │
│  国内库: 来源 [远端 URL ▾] 主地址 / 镜像 …  [编辑]         │
│  海外库: 来源 [本地上传 ▾] 上次上传 …        [编辑]         │
│  （控制台聚合制品；节点从 GET …/api/ip-lists/download/* 拉取）│
└─────────────────────────────────────────────────────────┘
```

### 5.6 隧道状态

```
┌─────────────────────────────────────────────────────────┐
│  隧道状态                                                │
├─────────────────────────────────────────────────────────┤
│  拓扑图                                                  │
│  ┌───────────────────────────────────────────────────┐   │
│  │     [上海]───28ms───[北京]                        │   │
│  │       │\                                          │   │
│  │     15ms  35ms                                    │   │
│  │       │      \                                    │   │
│  │     [广东]──22ms──[香港]──180ms──[美国]            │   │
│  │                     │                             │   │
│  │                   65ms                            │   │
│  │                     │                             │   │
│  │                  [新加坡]                          │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  隧道列表                                                │
│  ┌───────────────┬──────┬──────┬──────┬────────┐        │
│  │ 隧道           │ 延迟  │ 丢包  │ 状态  │ 操作   │        │
│  ├───────────────┼──────┼──────┼──────┼────────┤        │
│  │ 上海 ↔ 香港    │ 35ms │ 0.0% │ 正常  │ [详情] │        │
│  │ 上海 ↔ 美国    │180ms │ 0.1% │ 警告  │ [详情] │        │
│  │ 上海 ↔ 北京    │ 28ms │ 0.0% │ 正常  │ [详情] │        │
│  │ 香港 ↔ 美国    │160ms │ 0.0% │ 正常  │ [详情] │        │
│  └───────────────┴──────┴──────┴──────┴────────┘        │
└──────────────────────────────────────────────────────────┘
```

### 5.7 审计日志

```
┌─────────────────────────────────────────────────────────┐
│  审计日志                                    [导出CSV]    │
├─────────────────────────────────────────────────────────┤
│  时间范围: [最近7天 ▾]  操作类型: [全部 ▾]  操作人: [全部▾]│
├──────────────────┬──────┬──────────────────┬────────────┤
│ 时间              │ 操作人│ 操作              │ 详情       │
├──────────────────┼──────┼──────────────────┼────────────┤
│ 04-12 14:30:22   │admin │ 授权用户访问实例   │ 张三→上海  │
│                  │      │                  │ 港智能分流  │
├──────────────────┼──────┼──────────────────┼────────────┤
│ 04-12 13:15:08   │admin │ 吊销用户证书      │ 王五→上海  │
│                  │      │                  │ 美全局      │
├──────────────────┼──────┼──────────────────┼────────────┤
│ 04-12 03:00:15   │system│ 更新国内IP库      │ 6节点全部  │
│                  │      │                  │ 更新成功    │
├──────────────────┼──────┼──────────────────┼────────────┤
│ 04-11 16:42:33   │admin │ 添加节点          │ 新加坡     │
│                  │      │                  │ 节点号:60   │
└──────────────────┴──────┴──────────────────┴────────────┘
│                    [上一页]  1 2 3 ... 10  [下一页]       │
└──────────────────────────────────────────────────────────┘
```

---

## 六、node-setup.sh 一键部署脚本详细设计（P2）

### 6.1 脚本入口

```bash
#!/bin/bash
# node-setup.sh - 一键部署 VPN 节点
# 用法: curl -fsSL https://vpn-api.company.com/node-setup.sh | bash -s -- --api-url URL --token TOKEN

set -e

API_URL=""
TOKEN=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --api-url) API_URL="$2"; shift 2 ;;
    --token)   TOKEN="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$API_URL" || -z "$TOKEN" ]] && { echo "Usage: $0 --api-url URL --token TOKEN"; exit 1; }
```

### 6.2 主流程

```bash
# 1. OS 检测（复用 openvpn-install.sh 逻辑）
detect_os

# 2. 向 API 注册，获取配置
NODE_CONFIG=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "$API_URL/api/agent/register")
NODE_ID=$(echo "$NODE_CONFIG" | jq -r '.node_id')
NODE_NUM=$(echo "$NODE_CONFIG" | jq -r '.node_number')

# 3. 安装软件包
install_packages  # openvpn, wireguard-tools, ipset, iptables, jq, curl

# 4. 启用 IP 转发
enable_ip_forward

# 5. 部署共享 PKI
deploy_shared_pki

# 6. 为每个实例生成配置
for instance in $(echo "$NODE_CONFIG" | jq -c '.instances[]'); do
  deploy_instance "$instance"
done

# 7. 部署 WireGuard 隧道
for tunnel in $(echo "$NODE_CONFIG" | jq -c '.tunnels[]'); do
  deploy_tunnel "$tunnel"
done

# 8. 安装 Node Agent
install_agent

# 9. 下载国内 IP 库并初始化 ipset
init_cn_ip_list

# 10. 启动所有服务
start_all_services

# 11. 上报就绪
curl -fsSL -X POST -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/agent/report" \
  -d '{"status":"ready","agent_version":"1.0.0"}'

echo "Node $NODE_ID deployed successfully!"
```

### 6.3 关键函数

```bash
deploy_instance() {
  local inst="$1"
  local mode=$(echo "$inst" | jq -r '.mode')
  local port=$(echo "$inst" | jq -r '.port')
  local subnet=$(echo "$inst" | jq -r '.subnet')
  local exit_node=$(echo "$inst" | jq -r '.exit_node')

  local inst_dir="/etc/openvpn/server/$mode"
  mkdir -p "$inst_dir"

  cd /etc/openvpn/server/easy-rsa/
  ./easyrsa --batch --days=3650 build-server-full "server-$mode" nopass
  cp "pki/issued/server-$mode.crt" "$inst_dir/server.crt"
  cp "pki/private/server-$mode.key" "$inst_dir/server.key"

  generate_server_conf "$mode" "$port" "$subnet" "$inst_dir"
  generate_client_common "$mode" "$port" "$inst_dir"
  generate_nat_rules "$mode" "$subnet" "$exit_node"
  generate_systemd_service "$mode"
}

deploy_tunnel() {
  local tun="$1"
  local peer_id=$(echo "$tun" | jq -r '.peer_id')
  local local_ip=$(echo "$tun" | jq -r '.local_ip')
  local peer_endpoint=$(echo "$tun" | jq -r '.peer_endpoint')
  local peer_pubkey=$(echo "$tun" | jq -r '.peer_pubkey')
  local allowed_ips=$(echo "$tun" | jq -r '.allowed_ips')

  if [[ ! -f /etc/wireguard/privatekey ]]; then
    wg genkey > /etc/wireguard/privatekey
    wg pubkey < /etc/wireguard/privatekey > /etc/wireguard/publickey
    curl -fsSL -X POST -H "Authorization: Bearer $TOKEN" \
      "$API_URL/api/agent/report" \
      -d "{\"wg_pubkey\":\"$(cat /etc/wireguard/publickey)\"}"
  fi

  cat > "/etc/wireguard/wg-$peer_id.conf" << EOF
[Interface]
PrivateKey = $(cat /etc/wireguard/privatekey)
Address = $local_ip/30
Table = off

[Peer]
PublicKey = $peer_pubkey
Endpoint = $peer_endpoint:56720
AllowedIPs = $allowed_ips
PersistentKeepalive = 25
EOF

  systemctl enable --now "wg-quick@wg-$peer_id"
}
```

---

## 七、Vue 3 前端项目结构（P3）

```
vpn-web/
├── src/
│   ├── api/
│   │   ├── auth.ts
│   │   ├── nodes.ts
│   │   ├── users.ts
│   │   ├── grants.ts
│   │   ├── iplist.ts
│   │   ├── tunnels.ts
│   │   └── audit.ts
│   ├── views/
│   │   ├── Dashboard.vue
│   │   ├── NodeList.vue
│   │   ├── NodeDetail.vue
│   │   ├── NodeAdd.vue
│   │   ├── UserList.vue
│   │   ├── UserGrants.vue
│   │   ├── IPListStatus.vue
│   │   ├── TunnelMap.vue
│   │   ├── AuditLog.vue
│   │   └── Login.vue
│   ├── components/
│   │   ├── StatusBadge.vue
│   │   ├── NodeCard.vue
│   │   └── ConfirmDialog.vue
│   ├── stores/
│   │   ├── auth.ts
│   │   └── websocket.ts
│   ├── router/
│   │   └── index.ts
│   ├── App.vue
│   └── main.ts
├── package.json
└── vite.config.ts
```

---

## 八、Go 后端项目结构（P1/P3）

```
vpn-api/
├── cmd/
│   ├── api/main.go
│   └── agent/main.go
├── internal/
│   ├── api/
│   │   ├── auth.go
│   │   ├── nodes.go
│   │   ├── users.go
│   │   ├── grants.go
│   │   ├── iplist.go
│   │   ├── tunnels.go
│   │   ├── audit.go
│   │   └── agent_ws.go
│   ├── model/
│   │   ├── node.go
│   │   ├── instance.go
│   │   ├── user.go
│   │   ├── grant.go
│   │   ├── tunnel.go
│   │   └── audit.go
│   ├── service/
│   │   ├── node_service.go
│   │   ├── cert_service.go
│   │   ├── grant_service.go
│   │   ├── iplist_service.go
│   │   └── deploy_service.go
│   ├── agent/
│   │   ├── connector.go
│   │   ├── executor.go
│   │   ├── health.go
│   │   ├── iplist_updater.go
│   │   └── ovpn_manager.go
│   ├── config/
│   │   └── config.go
│   └── middleware/
│       ├── auth.go
│       └── audit.go
├── templates/
│   ├── server.conf.tmpl
│   ├── client-common.txt.tmpl
│   ├── wg-peer.conf.tmpl
│   ├── nat-node-direct.sh.tmpl
│   ├── nat-global.sh.tmpl
│   ├── nat-cn-split.sh.tmpl
│   └── systemd-openvpn.service.tmpl
├── scripts/
│   └── node-setup.sh
├── go.mod
└── go.sum
```
