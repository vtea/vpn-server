# 运维手册

## 1. 节点无法上线

**现象**：Web 端节点状态一直显示 offline。

**排查步骤**：
1. 确认 vpn-agent 服务运行：`systemctl status vpn-agent`
2. 查看 agent 日志：`journalctl -u vpn-agent -f`
3. 确认节点能访问控制面：`curl -v https://vpn-api.company.com/api/health`
4. 确认 bootstrap token 正确：检查 `/etc/vpn-agent/agent.json`
5. 确认防火墙放行控制面 **56700/tcp**（或经 Nginx 的 443/tcp）和 **56720/udp**（WireGuard）

## 2. 换发节点 token / 重装节点后：授权删不掉或接口 404

**现象**：换发 bootstrap token 并在节点上重装后，用户授权列表里旧记录删不掉，或提示「接口不存在 (404）」、证书 CN 冲突。

**原因简述**：

- 控制面数据在 **`vpn.db`**（SQLite）中；**换发 token、重装节点脚本不会删除**库里的 **用户授权**（`user_grants`）。`cert_cn` 有唯一约束，旧行不清理会挡新授权。
- **404** 多为两类：①「API 连接」填错（页面端口、或根地址带 `/api` 导致请求变成 `/api/api/...`）；② **`vpn-api` 进程仍是旧二进制**，没有 `DELETE /api/grants/:id/purge` 路由。

**建议步骤**：

1. **管理台「API 连接」**：根地址为 **`http://<控制面>:56700`**（无路径、**不要**带 `/api`）。保存后点 **「测试连接」**：应提示支持 **grant_purge**；若提示需升级后端，请重新编译并**只启动一个** `vpn-api` 进程。
2. **删历史授权**：用户管理 → 授权 → 对非「有效」证书点 **删除**（物理删行）。若仍为 **active**，先 **吊销** 再删。
3. **或删节点**：节点管理删除该节点（会删除该节点实例下的授权行），再重新添加节点。
4. 浏览器 **开发者工具 → Network**：删除授权时请求 URL 应为 **`.../api/grants/<id>/purge`**，且路径中 **只出现一次** `/api`。

---

## 3. 用户连接失败

**排查步骤**：
1. 确认 OpenVPN 实例运行：`systemctl status openvpn-<mode>`
2. 查看 OpenVPN 日志：`tail -f /var/log/openvpn/<mode>.log`
3. 确认证书未被吊销：Web 端查看用户授权状态
4. 确认客户端使用正确的 .ovpn 文件
5. 确认防火墙放行对应 OpenVPN 端口：**UDP 与 TCP 以该实例 `instances.proto` 为准**（默认网段常见 **56710–56713**，以节点详情为准）。

### 3.1 Web 显示 TCP 与用户 .ovpn 仍是 UDP；或 remote 端口与 proto 不一致

**行为说明（当前版本）**：

- **在线签发**时，`.ovpn` 中的 **`remote` 端口与 `proto` 均以控制面数据库为准**（与 `GET /api/nodes/<id>` 返回的 **`instances[].port` / `instances[].proto`** 一致），避免曾出现的「库已是 TCP 端口但首部仍是 `proto udp`」组合。
- **新建**或 **保存** **组网接入**（CreateInstance / PATCH 实例）或网段 **「将默认协议同步到已有实例」** 后，若该节点 **Agent 在线**，控制面会通过 WebSocket 下发 **`update_config`**：节点写入 **`/etc/vpn-agent/last-config.json`**，并按实例列表更新各 **`/etc/openvpn/server/<mode>/server.conf`** 的 `port` / `proto`，再执行 **`systemctl try-restart openvpn-<mode>`**。
- **`bootstrap-node.json`** 仍由节点安装脚本生成；**`last-config.json` 优先**用于 Agent 在「未带 proto 的签发请求」等场景下的本机回退，以及 **在线用户数** 统计时的实例列表（有 `last-config` 时优先于 bootstrap）。

**建议核对**：

1. 使用管理 Token 调用 **`GET /api/nodes/<节点ID>`**，确认对应 **`mode`** 的 **`proto`**、**`port`** 与预期一致。
2. 调用 **`GET /api/users/<用户ID>/grants`**（或管理台授权列表），确认 **`instance_id`** 指向该实例。
3. 若库内 **`proto` 已是 `tcp`**，但下载的 `.ovpn` 仍旧：在授权上 **重试签发**（`ovpn_content` 存的是上次签发结果）。
4. 若用户仍连不上：在节点上核对 **`/etc/openvpn/server/<mode>/server.conf`** 中 **`proto` / `port`** 是否与库一致；查 **`journalctl -u vpn-agent`** 是否出现 **`received config update`**、**`openvpn apply`**、**`try-restart openvpn-`** 等关键字；确认 **`vpn-agent` 与 `vpn-api` 均为新版本** 且节点 **在线**（离线时不会收到 `update_config`，需上线后再次保存实例或等待后续同步手段）。
5. 若 **`bootstrap-node.json` 与库长期不一致**且从未成功落盘 `last-config`：可编辑并保存一次该节点实例（触发推送），或在节点上按安装文档重新执行会重写 bootstrap 的步骤，使本机与库对齐后再 **重试签发**。

### 3.1.1 控制面与节点 JSON 不同步时如何排障

**常见现象**：Web 上已改为 TCP，但本机 `bootstrap-node.json` 里仍是 UDP；或 `server.conf` 未监听新端口。

**日志关键字（vpn-agent）**：`received config update`、`config saved to /etc/vpn-agent/last-config.json`、`openvpn apply`、`try-restart openvpn-`。

**日志关键字（vpn-api）**：`push instances config`（推送失败时会打错误）。

**重试签发前建议满足**：`GET /api/nodes/<id>` 中 **`instances`** 与节点上 **`server.conf` 的 port/proto** 一致；在线节点应已写入 **`last-config.json`**（可与 API 返回的实例列表对照）。若仅改库、节点离线且从未收到推送，签发头虽与库一致，服务端仍可能监听旧配置，客户端仍会失败。

### 3.2 出口节点（`instances.exit_node`）

**`local-only`**：默认**留空**表示客户端全局流量经**本入口节点**公网出口（NAT 到本机 WAN）；脚本会推送 **`redirect-gateway`**。若填写 **对端节点 ID**（须与本节点「相关隧道」一致），则该实例流量经 **WireGuard 到对端**再出网；**无** `hongkong`/`usa` 等内置名回退。

**`hk-smart-split` / `hk-global` / `us-global`**：可在 **`instances.exit_node`** 中填写对端节点 ID。节点上 **`policy-routing.sh`**（由 `node-setup.sh` 生成）用该 ID 在 **`bootstrap-node.json` 的 `tunnels`** 里解析对端 WG 内网 IP；**留空**时仍尝试旧版内置名（HK：`hongkong`/`hong-kong`；US：`usa`/`us`）。

**配置步骤**：

1. 在 **节点详情 → 相关隧道** 中确认本节点与目标出口之间已有一条隧道（状态为已连接），并记下对端列展示的 **节点 ID**。
2. 在 **组网接入** 对应模式的 **出口节点** 下拉中选择该 ID（或清空），保存。API 会校验非空 `exit_node` 须为本节点某隧道的对端。
3. 在**入口节点**上 **重新执行** 安装脚本（或至少重新生成并执行 `policy-routing.sh` / `nat-rules.sh`），使与库内配置一致（参见上文第 4 节）。**注意**：仅依赖 Agent 的 `update_config` **不会**在 `server.conf` 中补写 `redirect-gateway`；从旧语义升级须在节点上重跑含 OpenVPN 配置生成的安装步骤。

### 3.3 新建节点默认启用与存量升级

**新建节点（当前版本）**：控制面仍为每个节点创建四套实例，但 **`enabled` 仅 `local-only` 为 true**；`hk-smart-split` / `hk-global` / `us-global` 默认关闭。管理员在 Web **组网接入** 中勾选启用其它模式并保存后，须在节点上 **重新执行 `node-setup.sh`（或等价部署流程）**，以便生成对应 **`server.conf`**、systemd 单元及路由/NAT；仅在线 Agent 同步 **不会**为仍禁用的模式创建监听。

**存量节点升级**：若节点上的 `local-only` **`server.conf` 仍为旧版（无 `push redirect-gateway`）**，用户即使连上也可能与预期不符。升级 `node-setup.sh` 后请在节点上 **重跑安装脚本** 中生成 OpenVPN 与路由的步骤。行为变化：**新语义下 `local-only` 会拉全局流量进隧道**；若业务仍需要「仅 VPN 子网、公网走用户本机」，应使用其它产品设计（例如不授权 `local-only` 或单独文档约定），而非依赖旧脚本行为。

### 3.4 local-only 已连接但客户端「上不了网」；节点「在线用户」长期为 0

**上不了网**：在**新语义**下，`local-only` 应已推送默认路由；若仍异常，查 **`server.conf` 是否含 `redirect-gateway`**、节点 **NAT/转发**、以及客户端 **Kill Switch**（部分客户端在 DNS 或分路上仍会拦截）。若 `local-only` 配置了 **`exit_node`**，确认策略路由与隧道正常（`ip rule` / `ip route show table`）。

**在线用户为 0**：Web 上人数由 **vpn-agent** 通过本机 OpenVPN **management**（`127.0.0.1:56730`–`56733`，按 **mode** 固定：`local-only`→56730，`hk-smart-split`→56731，`hk-global`→56732，`us-global`→56733）查询后上报。若长期为 0：检查 **`systemctl status openvpn-<mode>`**（仅 **已启用** 的实例应有服务）、Agent 日志、以及 **`server.conf`** 中 `management` 端口是否与上表一致。

建议按以下顺序快速确认：

1. `echo -e "status 3\n" | nc -w 2 127.0.0.1 56730`：确认输出存在 `CLIENT_LIST`。
2. 管理台或 `GET /api/nodes/<id>/status`：确认 `agent_version` 已升级到新版本（`0.2.1+` 或你的构建版本号）。
3. `journalctl -u vpn-agent -f`：观察是否出现 `health: management ... returned zero CLIENT_LIST rows`、`health: no instances found`、`unknown instance mode` 等诊断日志。
4. 若 `status 3` 有 `CLIENT_LIST` 但 API 仍为 0，优先怀疑节点还在跑旧版二进制（未替换或未重启）。

## 4. 智能分流不生效

**现象**：所有流量都走本地或都走海外。

**排查步骤**：
1. 确认 ipset 已加载：`ipset list china-ip | head`
2. 确认策略路由存在：`ip rule show`
3. 确认路由表有内容：`ip route show table 101`
4. 手动测试分流：`ip route get 114.114.114.114`（应走本地）、`ip route get 8.8.8.8`（应走隧道）
5. 重新应用规则：`bash /etc/vpn-agent/policy-routing.sh && bash /etc/vpn-agent/nat-rules.sh`

## 5. WireGuard 隧道断开

**排查步骤**：
1. 查看隧道状态：`wg show`
2. 确认对端可达：`ping <peer_public_ip>`
3. 确认对端 WireGuard 运行：SSH 到对端执行 `wg show`
4. 确认公钥匹配：对比两端的 publickey
5. 重启隧道：`systemctl restart wg-quick@wg-<peer>`

## 6. 证书签发失败

**排查步骤**：
1. 查看 agent 日志中的 `issue_cert` 错误
2. 确认 easy-rsa 目录存在：`ls /etc/openvpn/server/easy-rsa/pki/`
3. 手动测试签发：
   ```bash
   cd /etc/openvpn/server/easy-rsa
   EASYRSA_BATCH=1 ./easyrsa build-client-full test-cert nopass
   ```
4. 如果 PKI 损坏，需要重新初始化（会导致所有已签发证书失效）

## 7. 吊销证书

**Web 端操作**：用户管理 → 选择用户 → 授权管理 → 点击"吊销"

**手动吊销**：
```bash
cd /etc/openvpn/server/easy-rsa
EASYRSA_BATCH=1 ./easyrsa revoke <cert_cn>
EASYRSA_BATCH=1 ./easyrsa gen-crl
```

## 8. IP 库更新异常

**现象**：Agent 日志显示 "ip list anomaly detected"。

**原因**：新下载的 IP 库条目数与旧版本差异超过 5%。

**处理**：
1. 手动检查新列表：`curl -fsSL https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt | wc -l`
2. 如果确认正常，手动强制更新：删除旧列表后重新执行
   ```bash
   rm /etc/vpn-agent/cn-ip-list.txt
   # 通过 Web 端触发全网更新
   ```

## 9. 数据库备份与恢复

**备份**：
```bash
bash /opt/vpn-api/scripts/backup.sh
```

**恢复**：
```bash
systemctl stop vpn-api
gunzip /opt/vpn-api/backups/vpn_YYYYMMDD_HHMMSS.db.gz
cp /opt/vpn-api/backups/vpn_YYYYMMDD_HHMMSS.db /opt/vpn-api/vpn.db
systemctl start vpn-api
```

## 10. 添加新节点

1. Web 端：节点管理 → 添加节点 → 填写名称/地域/公网IP
2. 复制生成的部署命令
3. SSH 到新服务器，以 root 执行部署命令
4. 等待节点在 Web 端显示"在线"
5. 验证：`systemctl status openvpn-* vpn-agent wg-quick@*`

## 11. 控制面迁移

1. 备份数据库：`bash scripts/backup.sh`
2. 在新机器上部署 vpn-api 和 vpn-admin-web
3. 恢复数据库
4. 更新 DNS 指向新机器
5. 所有节点 Agent 会自动重连（通过 DNS 解析到新地址）
