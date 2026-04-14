#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PROJECT_DIR}/dist"
OUT_NAME="vpn-api-linux-bundle"
VERSION="${VERSION:-$(date +%Y%m%d.%H%M%S)}"
PKG_ROOT="${DIST_DIR}/${OUT_NAME}-${VERSION}"
AGENT_RELEASE_FALLBACK="${VERSION}"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/agent-release-version.inc.sh"
AGENT_RELEASE_VERSION="${AGENT_RELEASE_VERSION:-${VERSION}}"

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[ERROR] missing command: ${cmd}" >&2
    exit 1
  fi
}

echo "[1/6] check toolchain"
require_cmd go
require_cmd tar

echo "[2/6] prepare output directories"
rm -rf "${PKG_ROOT}"
mkdir -p "${PKG_ROOT}/bin" "${PKG_ROOT}/scripts" "${PKG_ROOT}/systemd" "${PKG_ROOT}/config"

echo "[3/6] build binaries (agent buildVersion=${AGENT_RELEASE_VERSION})"
cd "${PROJECT_DIR}"
go mod tidy
agent_ldflags="-X main.buildVersion=${AGENT_RELEASE_VERSION}"
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o "${PKG_ROOT}/bin/vpn-api" ./cmd/api
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "${agent_ldflags}" -o "${PKG_ROOT}/bin/vpn-agent-linux-amd64" ./cmd/agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags "${agent_ldflags}" -o "${PKG_ROOT}/bin/vpn-agent-linux-arm64" ./cmd/agent
chmod +x "${PKG_ROOT}/bin/"*

echo "[4/6] copy runtime scripts"
cp "${PROJECT_DIR}/scripts/backup.sh" "${PKG_ROOT}/scripts/backup.sh"
cp "${PROJECT_DIR}/scripts/node-setup.sh" "${PKG_ROOT}/scripts/node-setup.sh"
chmod +x "${PKG_ROOT}/scripts/"*.sh

echo "[5/6] write env/systemd templates"
cat > "${PKG_ROOT}/config/vpn-api.env.example" <<EOF
API_PORT=56700
DB_DRIVER=sqlite
DB_PATH=/opt/vpn-api/data/vpn.db
JWT_SECRET=replace-with-strong-random-secret
CA_DIR=/opt/vpn-api/ca
EXTERNAL_URL=http://127.0.0.1:56700
# EXTERNAL_URL_LAN=http://192.168.1.10:56700
# CORS_ALLOWED_ORIGINS=https://vpn-admin.example.com
AGENT_LATEST_VERSION=${AGENT_RELEASE_VERSION}
# IPLIST_DUAL_ENABLED=true
VPN_AGENT_BIN_DIR=/opt/vpn-api/bin
EOF

cat > "${PKG_ROOT}/systemd/vpn-api.service" <<'EOF'
[Unit]
Description=VPN Control Plane API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/vpn-api/data
EnvironmentFile=/opt/vpn-api/config/vpn-api.env
ExecStart=/opt/vpn-api/bin/vpn-api
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "${PKG_ROOT}/README.txt" <<'EOF'
Quick deploy:
1) Copy this bundle to server and extract under /opt/vpn-api
2) cp config/vpn-api.env.example /opt/vpn-api/config/vpn-api.env
3) Edit JWT_SECRET and EXTERNAL_URL
4) cp systemd/vpn-api.service /etc/systemd/system/vpn-api.service
5) systemctl daemon-reload && systemctl enable --now vpn-api
6) curl http://127.0.0.1:56700/api/health
EOF

echo "[6/6] create tarball"
TARBALL="${DIST_DIR}/${OUT_NAME}-${VERSION}.tar.gz"
tar -C "${DIST_DIR}" -czf "${TARBALL}" "$(basename "${PKG_ROOT}")"

echo ""
echo "Build done:"
echo "  folder : ${PKG_ROOT}"
echo "  tar.gz : ${TARBALL}"
