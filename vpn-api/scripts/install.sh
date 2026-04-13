#!/usr/bin/env bash
set -euo pipefail

# Unified Linux installer entrypoint.
# Delegates to deploy-control-plane.sh while preserving all arguments.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-control-plane.sh"

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

exec bash "${DEPLOY_SCRIPT}" "$@"
