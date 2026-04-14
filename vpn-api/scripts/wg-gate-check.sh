#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# wg-gate-check.sh
#
# 作用（给运维/管理员）：
#   一键执行 WG-only 刷新门禁，验证“只刷新 WireGuard，不影响 OpenVPN”。
#
# 脚本会做什么：
#   1) 调用 POST /api/nodes/:id/wg-refresh 触发目标节点 WG 刷新
#   2) 对比刷新前后 openvpn-* 的 MainPID，确认 OpenVPN 未被重启
#   3) （可选）检查 invalid_config 是否仅落在预期异常 peer
#
# 前置条件：
#   - 在控制面机器执行（能访问 API）
#   - 具备管理员 JWT
#   - 系统安装: curl / jq / systemctl
#
# 快速用法（自动拉取在线节点并逐个执行）：
#   bash wg-gate-check.sh \
#     --api-url "http://127.0.0.1:56700" \
#     --username "admin" \
#     # 不传 --password 时会安全交互输入（不回显）
#
# 或使用已有 JWT：
#   bash wg-gate-check.sh \
#     --api-url "http://127.0.0.1:56700" \
#     --jwt "<admin-jwt>"
#
# 指定单节点（可选）：
#   bash wg-gate-check.sh \
#     --api-url "http://127.0.0.1:56700" \
#     --jwt "<admin-jwt>" \
#     --node-id "node-50"
#
# 进阶用法（校验异常隔离到 node-10）：
#   bash wg-gate-check.sh \
#     --api-url "http://127.0.0.1:56700" \
#     --jwt "<admin-jwt>" \
#     --expect-invalid-peer "node-10" \
#     --wait-sec 10
#
# 结果判读：
#   - [OK] openvpn main pid unchanged       => OpenVPN 未受影响（关键门禁）
#   - [OK] invalid_config isolation passed  => 异常只落在预期 peer
#   - [OK] wg gate checks passed            => 本次门禁通过
#
# 常见失败：
#   - "agent does not support wg_refresh_v1" => 节点 agent 版本过旧，先升级 agent
#   - "node offline or ws send failed"       => 节点离线或 WS 不可达
#   - "openvpn pid changed"                  => WG 刷新过程影响了 OpenVPN，需要阻断发布
# -----------------------------------------------------------------------------

API_URL=""
JWT=""
USERNAME=""
PASSWORD=""
NODE_ID=""
EXPECT_INVALID_PEER=""
WAIT_SEC=8
API_BASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="${2:-}"
      shift 2
      ;;
    --jwt)
      JWT="${2:-}"
      shift 2
      ;;
    --username)
      USERNAME="${2:-}"
      shift 2
      ;;
    --password)
      PASSWORD="${2:-}"
      shift 2
      ;;
    --node-id)
      NODE_ID="${2:-}"
      shift 2
      ;;
    --expect-invalid-peer)
      EXPECT_INVALID_PEER="${2:-}"
      shift 2
      ;;
    --wait-sec)
      WAIT_SEC="${2:-8}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$API_URL" ]]; then
  echo "[ERR] 参数不足：--api-url 必填"
  echo "usage: bash wg-gate-check.sh --api-url URL [--jwt TOKEN] [--username USER --password PASS] [--node-id NODE] [--expect-invalid-peer PEER] [--wait-sec 8]" >&2
  exit 2
fi

# 兼容传入形式：
# - http://127.0.0.1:56700
# - http://127.0.0.1:56700/
# - http://127.0.0.1:56700/api
API_BASE="${API_URL%/}"
if [[ "$API_BASE" =~ /api$ ]]; then
  API_BASE="${API_BASE%/api}"
fi

if [[ -z "$JWT" ]]; then
  if [[ -z "$USERNAME" ]]; then
    echo "[ERR] 未提供 --jwt 时，必须提供 --username（--password 可留空并交互输入）"
    echo "usage: bash wg-gate-check.sh --api-url URL [--jwt TOKEN] [--username USER --password PASS] [--node-id NODE] [--expect-invalid-peer PEER] [--wait-sec 8]" >&2
    exit 2
  fi
  if [[ -z "$PASSWORD" ]]; then
    echo "[INFO] password not provided, prompt securely"
    read -r -s -p "Admin password for ${USERNAME}: " PASSWORD
    echo ""
    if [[ -z "$PASSWORD" ]]; then
      echo "[ERR] empty password"
      exit 2
    fi
  fi
  echo "[INFO] jwt not provided, login as $USERNAME"
  LOGIN_RESP=""
  LOGIN_OK=0
  for login_path in "/api/auth/login" "/api/login"; do
    if LOGIN_RESP="$(curl -fsS -X POST "$API_BASE${login_path}" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"; then
      echo "[INFO] login endpoint matched: $login_path"
      LOGIN_OK=1
      break
    fi
  done
  if [[ "$LOGIN_OK" -ne 1 ]]; then
    echo "[FAIL] login failed: tried /api/auth/login and /api/login"
    exit 1
  fi
  JWT="$(echo "$LOGIN_RESP" | jq -r '.token // .jwt // empty')"
  if [[ -z "$JWT" || "$JWT" == "null" ]]; then
    echo "[FAIL] login success but token missing in response"
    echo "$LOGIN_RESP" | jq .
    exit 1
  fi
  echo "[OK] login success, jwt acquired"
fi

# 依赖检查：缺少任一工具直接失败，避免执行半截。
for bin in curl jq systemctl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[FAIL] missing dependency: $bin" >&2
    exit 1
  fi
done

SERVICES=(
  "openvpn-local-only"
  "openvpn-hk-smart-split"
  "openvpn-hk-global"
  "openvpn-us-global"
)

discover_target_nodes() {
  if [[ -n "$NODE_ID" ]]; then
    echo "$NODE_ID"
    return 0
  fi
  local nodes_json
  nodes_json="$(curl -fsS "$API_BASE/api/nodes" -H "Authorization: Bearer $JWT")"
  echo "$nodes_json" | jq -r '.items[]? | select((.node.status // "") == "online") | .node.id'
}

# 读取 OpenVPN 主进程 PID 快照，用于前后对比是否被误重启。
snapshot_pids() {
  local out=""
  for s in "${SERVICES[@]}"; do
    local pid
    pid="$(systemctl show -p MainPID --value "$s" 2>/dev/null || true)"
    if [[ -z "$pid" ]]; then
      pid="0"
    fi
    out+="${s}:${pid}"$'\n'
  done
  echo "$out"
}

echo "[INFO] snapshot openvpn pids (before)"
BEFORE="$(snapshot_pids)"
echo "$BEFORE" | sed 's/^/[PID-BEFORE] /'

TARGET_NODES="$(discover_target_nodes)"
if [[ -z "${TARGET_NODES// }" ]]; then
  echo "[FAIL] no target nodes found (node offline or list empty)"
  exit 1
fi
echo "$TARGET_NODES" | sed 's/^/[TARGET] /'

overall_failed=0
while IFS= read -r nid; do
  [[ -z "$nid" ]] && continue
  echo "[INFO] trigger wg-refresh for node=$nid"
  refresh_raw="$(curl -sS -X POST "$API_BASE/api/nodes/$nid/wg-refresh" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -w $'\n%{http_code}')"
  refresh_code="$(echo "$refresh_raw" | tail -n 1)"
  REFRESH_RESP="$(echo "$refresh_raw" | sed '$d')"
  if [[ ! "$refresh_code" =~ ^2 ]]; then
    if [[ "$refresh_code" == "412" ]]; then
      echo "[FAIL] wg-refresh rejected for node=$nid: HTTP 412 (precondition failed)"
      if [[ -n "${REFRESH_RESP// }" ]]; then
        echo "$REFRESH_RESP" | jq . 2>/dev/null || echo "$REFRESH_RESP"
      fi
      echo "[HINT] node=$nid 需要先升级 vpn-agent，使其上报 capability: wg_refresh_v1"
    else
      echo "[FAIL] wg-refresh request failed for node=$nid: HTTP $refresh_code"
      if [[ -n "${REFRESH_RESP// }" ]]; then
        echo "$REFRESH_RESP" | jq . 2>/dev/null || echo "$REFRESH_RESP"
      fi
    fi
    overall_failed=1
    continue
  fi
  echo "$REFRESH_RESP" | jq .
  echo "[INFO] wait ${WAIT_SEC}s for wg_refresh_result (node=$nid)"
  sleep "$WAIT_SEC"

  if [[ -n "$EXPECT_INVALID_PEER" ]]; then
    STATUS_JSON="$(curl -fsS "$API_BASE/api/nodes/$nid/status" \
      -H "Authorization: Bearer $JWT")"
    # 若指定了预期异常 peer，要求 invalid_config 仅出现在该 peer 关联隧道上。
    invalid_count="$(echo "$STATUS_JSON" | jq --arg p "$EXPECT_INVALID_PEER" '[.tunnels[] | select(.status=="invalid_config" and (.node_a==$p or .node_b==$p))] | length')"
    other_invalid_count="$(echo "$STATUS_JSON" | jq --arg p "$EXPECT_INVALID_PEER" '[.tunnels[] | select(.status=="invalid_config" and (.node_a!=$p and .node_b!=$p))] | length')"
    echo "[INFO] node=$nid invalid_config expected-peer=$invalid_count other-peers=$other_invalid_count"
    if [[ "$invalid_count" -ge 1 && "$other_invalid_count" -eq 0 ]]; then
      echo "[OK] node=$nid invalid_config isolation passed"
    else
      echo "[FAIL] node=$nid invalid_config isolation failed"
      overall_failed=1
    fi
  fi
done <<< "$TARGET_NODES"

echo "[INFO] snapshot openvpn pids (after)"
AFTER="$(snapshot_pids)"
echo "$AFTER" | sed 's/^/[PID-AFTER]  /'

# 比较刷新前后 PID：只要某个 openvpn 实例 PID 变化，即判定失败。
pid_changed=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  svc="${line%%:*}"
  bpid="${line##*:}"
  apid="$(echo "$AFTER" | awk -F: -v s="$svc" '$1==s{print $2}')"
  [[ -z "$apid" ]] && apid="0"
  if [[ "$bpid" != "$apid" ]]; then
    # tolerate disabled/not-running service where both 0 is stable
    if [[ "$bpid" != "0" || "$apid" != "0" ]]; then
      echo "[FAIL] openvpn pid changed: $svc before=$bpid after=$apid"
      pid_changed=1
    fi
  fi
done <<< "$BEFORE"

if [[ "$pid_changed" -eq 0 ]]; then
  echo "[OK] openvpn main pid unchanged"
fi

if [[ "$pid_changed" -ne 0 || "$overall_failed" -ne 0 ]]; then
  exit 1
fi

echo "[OK] wg gate checks passed"
