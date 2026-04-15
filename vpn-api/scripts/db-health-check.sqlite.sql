-- =============================================================================
-- VPN 控制面库体检（SQLite）
-- 与 GORM 默认表名一致：nodes / tunnels / instances / node_segments / user_grants / tunnel_metrics
--
-- 用法（只读）。须从「已有表」的真实库复制后再打开，否则会建空库、全表 no such table。
--
-- 【布局 A：Git 仓库 vpn-server/，当前目录为仓库根】
--   cp -a vpn-api/vpn.db vpn-api/vpn-healthcheck.db
--   sqlite3 vpn-api/vpn-healthcheck.db ".read vpn-api/scripts/db-health-check.sqlite.sql"
--   Docker 开发库：vpn-api/docker-data/data/vpn.db
--
-- 【布局 B：安装目录 INSTALL_DIR，常见 /opt/vpn-api，见 deploy-control-plane.sh】
--   cd /opt/vpn-api
--   cp -a data/vpn.db ./vpn-healthcheck.db
--   sqlite3 vpn-healthcheck.db ".read scripts/db-health-check.sqlite.sql"
-- =============================================================================

.headers on
.mode column

-- ---------------------------------------------------------------------------
-- 0) 库是否已由 vpn-api 建表（必读）
--
-- sqlite3 若打开「尚不存在」的 .db 路径，会静默创建空库，随后所有 SELECT 都会报 no such table。
-- 正确顺序：先 `cp -a` 真实库到本路径，再执行本脚本；且相对路径 `vpn-api/...` 须在仓库根目录下执行。
--
-- 00 节列含义：nodes_table_present / tunnels_table_present 仅为 0 或 1，表示「是否已有该表」，
--             不是 nodes / tunnels 业务表里的行数（勿与节点个数混淆）。
-- 01～08 节：若某节查询结果为空（无输出行），表示该项检查通过，不是脚本出错。
-- ---------------------------------------------------------------------------
SELECT '00_schema_sanity' AS section,
       (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table') AS total_tables,
       (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'nodes') AS nodes_table_present,
       (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tunnels') AS tunnels_table_present;

-- ---------------------------------------------------------------------------
-- 1) 孤儿隧道：node_a / node_b 在 nodes 中不存在
-- 处理：先恢复误删节点，或删除孤儿隧道行后再 repair-mesh / 刷新 WG
-- ---------------------------------------------------------------------------
SELECT '01_orphan_tunnels' AS section, t.id AS tunnel_id, t.node_a, t.node_b
FROM tunnels t
LEFT JOIN nodes na ON na.id = t.node_a
LEFT JOIN nodes nb ON nb.id = t.node_b
WHERE na.id IS NULL OR nb.id IS NULL;

-- ---------------------------------------------------------------------------
-- 2) 孤儿实例：node_id 不在 nodes
-- ---------------------------------------------------------------------------
SELECT '02_orphan_instances' AS section, i.id AS instance_id, i.node_id
FROM instances i
LEFT JOIN nodes n ON n.id = i.node_id
WHERE n.id IS NULL;

-- ---------------------------------------------------------------------------
-- 3) 孤儿 node_segments
-- ---------------------------------------------------------------------------
SELECT '03_orphan_node_segments' AS section, ns.node_id, ns.segment_id
FROM node_segments ns
LEFT JOIN nodes n ON n.id = ns.node_id
WHERE n.id IS NULL;

-- ---------------------------------------------------------------------------
-- 4) 缺 WireGuard 公钥的节点（WG 对端会 invalid）
-- 处理：节点上生成 key 后由 agent report 上报，或 PATCH 节点相关流程后刷新 WG
-- ---------------------------------------------------------------------------
SELECT '04_nodes_empty_wg_pubkey' AS section, id, name, public_ip
FROM nodes
WHERE trim(coalesce(wg_public_key, '')) = '';

-- ---------------------------------------------------------------------------
-- 5) 同一 subnet 多条隧道（违反唯一语义）
-- ---------------------------------------------------------------------------
SELECT '05_duplicate_tunnel_subnet' AS section, subnet, COUNT(*) AS cnt
FROM tunnels
GROUP BY subnet
HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------------
-- 6) 可疑节点 id（含路径分隔、换行、..），与 agent wg 文件名安全策略不一致
-- 处理：禁止直接改 id；删节点重建或一次性迁移项目
-- ---------------------------------------------------------------------------
SELECT '06_nodes_suspicious_id' AS section, id, name
FROM nodes
WHERE instr(id, '/') > 0
   OR instr(id, char(10)) > 0
   OR instr(id, char(13)) > 0
   OR instr(id, char(92)) > 0
   OR instr(id, '..') > 0;

-- ---------------------------------------------------------------------------
-- 7) tunnel_metrics 指向不存在的 tunnel_id（历史残留）
-- ---------------------------------------------------------------------------
SELECT '07_orphan_tunnel_metrics' AS section, m.id AS metric_id, m.tunnel_id
FROM tunnel_metrics m
LEFT JOIN tunnels t ON t.id = m.tunnel_id
WHERE t.id IS NULL;

-- ---------------------------------------------------------------------------
-- 8) user_grants 指向不存在的 instance_id
-- ---------------------------------------------------------------------------
SELECT '08_orphan_user_grants' AS section, g.id AS grant_id, g.instance_id
FROM user_grants g
LEFT JOIN instances i ON i.id = g.instance_id
WHERE i.id IS NULL;
