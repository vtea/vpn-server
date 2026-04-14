#!/usr/bin/env bash
set -euo pipefail

# Unified Linux installer entrypoint.
# Delegates to deploy-control-plane.sh while preserving all arguments.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-control-plane.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/agent-release-version.inc.sh"

if [[ ! -f "${DEPLOY_SCRIPT}" ]]; then
  echo "[ERROR] deploy script not found: ${DEPLOY_SCRIPT}" >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "[WARN] cannot detect distro from /etc/os-release; continue anyway."
else
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-unknown}" in
    ubuntu|debian|centos|rhel|rocky|almalinux|fedora)
      echo "[INFO] detected distro: ${PRETTY_NAME:-$ID}"
      ;;
    *)
      echo "[WARN] unverified distro: ${PRETTY_NAME:-$ID}. installer will still try."
      ;;
  esac
fi

_VPN_API_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
echo "[INFO] AGENT_RELEASE_VERSION（预览，与 Phase 3 编译结果一致）: $(resolve_agent_release_version "${_VPN_API_ROOT}")"
echo ""

exec bash "${DEPLOY_SCRIPT}" "$@"
