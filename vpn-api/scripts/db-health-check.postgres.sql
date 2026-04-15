-- =============================================================================
-- VPN 控制面库体检（PostgreSQL）
-- 与 GORM 默认表名一致：nodes / tunnels / instances / node_segments / user_grants / tunnel_metrics
--
-- 用法（只读；仓库根 vpn-server/ 下执行，DB_PATH 与 vpn-api 进程配置一致）：
--   psql "$DB_PATH" -f vpn-api/scripts/db-health-check.postgres.sql
-- =============================================================================

\x off
\timing off

-- ---------------------------------------------------------------------------
-- 0) 库是否已初始化（public 下是否存在 nodes / tunnels 表）
-- nodes_table_present / tunnels_table_present：0 或 1，仅表示表是否存在，不是业务行数。
-- 01～08 节：无输出行 = 该项无异常。
-- ---------------------------------------------------------------------------
SELECT '00_schema_sanity' AS section,
       (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS total_tables,
       (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nodes') AS nodes_table_present,
       (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tunnels') AS tunnels_table_present;

-- ---------------------------------------------------------------------------
-- 1) 孤儿隧道
-- ---------------------------------------------------------------------------
SELECT '01_orphan_tunnels' AS section, t.id AS tunnel_id, t.node_a, t.node_b
FROM tunnels t
LEFT JOIN nodes na ON na.id = t.node_a
LEFT JOIN nodes nb ON nb.id = t.node_b
WHERE na.id IS NULL OR nb.id IS NULL;

-- ---------------------------------------------------------------------------
-- 2) 孤儿实例
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
-- 4) 缺 WireGuard 公钥的节点
-- ---------------------------------------------------------------------------
SELECT '04_nodes_empty_wg_pubkey' AS section, id, name, public_ip
FROM nodes
WHERE trim(coalesce(wg_public_key, '')) = '';

-- ---------------------------------------------------------------------------
-- 5) 同一 subnet 多条隧道
-- ---------------------------------------------------------------------------
SELECT '05_duplicate_tunnel_subnet' AS section, subnet, COUNT(*) AS cnt
FROM tunnels
GROUP BY subnet
HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------------
-- 6) 可疑节点 id（路径/换行/..）
-- ---------------------------------------------------------------------------
SELECT '06_nodes_suspicious_id' AS section, id, name
FROM nodes
WHERE strpos(id, '/') > 0
   OR strpos(id, chr(10)) > 0
   OR strpos(id, chr(13)) > 0
   OR strpos(id, E'\\') > 0
   OR strpos(id, '..') > 0;

-- ---------------------------------------------------------------------------
-- 7) orphan tunnel_metrics
-- ---------------------------------------------------------------------------
SELECT '07_orphan_tunnel_metrics' AS section, m.id AS metric_id, m.tunnel_id
FROM tunnel_metrics m
LEFT JOIN tunnels t ON t.id = m.tunnel_id
WHERE t.id IS NULL;

-- ---------------------------------------------------------------------------
-- 8) orphan user_grants
-- ---------------------------------------------------------------------------
SELECT '08_orphan_user_grants' AS section, g.id AS grant_id, g.instance_id
FROM user_grants g
LEFT JOIN instances i ON i.id = g.instance_id
WHERE i.id IS NULL;
