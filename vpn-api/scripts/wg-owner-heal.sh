#!/usr/bin/env bash
set -euo pipefail

# 在当前节点自动修复 WireGuard ListenPort 冲突：
# - 仅一个 owner 接口保留 ListenPort=51820
# - 其它 wg-node-* 接口删除 ListenPort（自动端口）
# 用法：
#   bash wg-owner-heal.sh
#   bash wg-owner-heal.sh --owner wg-node-20

OWNER_IFACE=""
LISTEN_PORT=51820
WG_DIR="/etc/wireguard"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER_IFACE="${2:-}"
      shift 2
      ;;
    --listen-port)
      LISTEN_PORT="${2:-51820}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

shopt -s nullglob
CONF_FILES=("${WG_DIR}"/wg-node-*.conf)
if [[ ${#CONF_FILES[@]} -eq 0 ]]; then
  echo "[FAIL] no files matched ${WG_DIR}/wg-node-*.conf" >&2
  exit 1
fi

pick_default_owner() {
  for f in "${CONF_FILES[@]}"; do
    iface="$(basename "$f" .conf)"
    if ss -lunp 2>/dev/null | grep -q ":${LISTEN_PORT}\b" && [[ "$iface" == "wg-node-"* ]]; then
      current_ifaces="$(wg show interfaces 2>/dev/null || true)"
      if [[ " ${current_ifaces} " == *" ${iface} "* ]]; then
        echo "$iface"
        return 0
      fi
    fi
  done
  for f in "${CONF_FILES[@]}"; do
    iface="$(basename "$f" .conf)"
    num="${iface#wg-node-}"
    if [[ "$num" =~ ^[0-9]+$ ]]; then
      echo "$num $iface"
    fi
  done | sort -n | head -n1 | awk "{print \$2}"
}

if [[ -z "$OWNER_IFACE" ]]; then
  OWNER_IFACE="$(pick_default_owner)"
fi
if [[ -z "$OWNER_IFACE" ]]; then
  echo "[FAIL] cannot determine owner iface" >&2
  exit 1
fi

echo "[INFO] owner iface: ${OWNER_IFACE}"
echo "[INFO] fixed listen port: ${LISTEN_PORT}"

TS="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="/root/wg-owner-heal-${TS}"
mkdir -p "$BACKUP_DIR"
cp -a "${WG_DIR}" "$BACKUP_DIR/" 2>/dev/null || true
echo "[INFO] backup saved: ${BACKUP_DIR}"

for f in "${CONF_FILES[@]}"; do
  iface="$(basename "$f" .conf)"
  if [[ "$iface" == "$OWNER_IFACE" ]]; then
    if grep -q "^ListenPort[[:space:]]*=" "$f"; then
      sed -i -E "s/^ListenPort[[:space:]]*=.*/ListenPort = ${LISTEN_PORT}/" "$f"
    else
      sed -i "/^\[Interface\]/a ListenPort = ${LISTEN_PORT}" "$f"
    fi
    echo "[FIX] ${iface}: keep ListenPort=${LISTEN_PORT}"
  else
    sed -i "/^ListenPort[[:space:]]*=/d" "$f"
    echo "[FIX] ${iface}: remove ListenPort (auto)"
  fi
done

for f in "${CONF_FILES[@]}"; do
  iface="$(basename "$f" .conf)"
  systemctl restart "wg-quick@${iface}" || true
done

sleep 2
echo "===== verify ====="
systemctl --no-pager -l --type=service | grep "wg-quick@wg-node-" || true
ip -br link show | grep "^wg-node-" || true
wg show || true
echo "===== listen summary ====="
for f in "${CONF_FILES[@]}"; do
  iface="$(basename "$f" .conf)"
  lp="$(grep -E "^ListenPort[[:space:]]*=" "$f" || true)"
  [[ -z "$lp" ]] && lp="ListenPort auto"
  echo "${iface}: ${lp}"
done

