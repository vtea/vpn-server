#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/vpn-api/vpn.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/vpn-api/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
BACKUP_FILE="${BACKUP_DIR}/vpn_${TIMESTAMP}.db"

sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"
gzip "${BACKUP_FILE}"

log_file="${BACKUP_DIR}/vpn_${TIMESTAMP}.db.gz"
echo "[$(date)] Backup created: ${log_file} ($(du -h "$log_file" | cut -f1))"

find "$BACKUP_DIR" -name "vpn_*.db.gz" -mtime +${KEEP_DAYS} -delete
echo "[$(date)] Cleaned backups older than ${KEEP_DAYS} days"

# Install as cron:
#   echo "0 2 * * * /opt/vpn-api/scripts/backup.sh >> /var/log/vpn-backup.log 2>&1" | crontab -
