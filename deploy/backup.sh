#!/usr/bin/env bash
# Back up the database and the uploaded files of the running Compose stack.
#
#   deploy/backup.sh                       # writes to deploy/backups/
#   BACKUP_DIR=/srv/backups KEEP_DAYS=30 deploy/backup.sh
#   COMPOSE="podman compose" deploy/backup.sh
#
# Daily cron on the server (and copy the directory OFF the server, e.g. with
# rclone or rsync, so a lost VM doesn't take its backups with it):
#   15 3 * * *  /opt/entitynetworks/deploy/backup.sh >> /var/log/entitynetworks-backup.log 2>&1
#
# Restore: see "Backups" in deploy/README.md.
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=${COMPOSE:-docker compose}
DEST=${BACKUP_DIR:-./backups}
KEEP_DAYS=${KEEP_DAYS:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077  # dumps hold password hashes and user data: owner-only
mkdir -p "$DEST"

# Write to *.partial and rename only on success, so a failed run never leaves a
# truncated file that looks like a good backup.
$COMPOSE exec -T db pg_dump -U entitynet -d entitynet --format=custom \
  > "$DEST/db-$stamp.dump.partial"
mv "$DEST/db-$stamp.dump.partial" "$DEST/db-$stamp.dump"

$COMPOSE exec -T api tar -C /data -czf - uploads > "$DEST/uploads-$stamp.tar.gz.partial"
mv "$DEST/uploads-$stamp.tar.gz.partial" "$DEST/uploads-$stamp.tar.gz"

find "$DEST" -maxdepth 1 \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) \
  -mtime +"$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok: $DEST/db-$stamp.dump, $DEST/uploads-$stamp.tar.gz"
