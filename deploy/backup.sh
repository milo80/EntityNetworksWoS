#!/usr/bin/env bash
# Back up the database and the uploaded files of the running Compose stack.
#
#   deploy/backup.sh                       # writes to deploy/backups/
#   BACKUP_DIR=/srv/backups KEEP_DAYS=30 deploy/backup.sh
#   COMPOSE="podman compose" deploy/backup.sh
#
# Off-server copy: with BACKUP_S3_URI set (in the environment or in .env next to
# this script, e.g. BACKUP_S3_URI=s3://entitynetworks-prod-backups-123456789012/),
# both files are also uploaded there with a pinned aws-cli container. On PROD the
# server's IAM role may only write to that bucket; S3 deletes old copies.
#
# Daily cron on the server, in the crontab of the user that runs the stack:
#   15 3 * * *  /opt/entitynetworks/deploy/backup.sh >> $HOME/entitynetworks-backup.log 2>&1
#
# Restore: see "Backups" in deploy/README.md.
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=${COMPOSE:-docker compose}
DEST=${BACKUP_DIR:-./backups}
KEEP_DAYS=${KEEP_DAYS:-14}
AWS_CLI_IMAGE=docker.io/amazon/aws-cli:2.39.3
if [[ -z "${BACKUP_S3_URI:-}" && -f .env ]]; then
  BACKUP_S3_URI=$(sed -n 's/^BACKUP_S3_URI=//p' .env | tail -1)
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077  # dumps hold password hashes and user data: owner-only
mkdir -p "$DEST"

# Write to *.partial and rename only on success, so a failed run never leaves a
# truncated file that looks like a good backup.
$COMPOSE exec -T db pg_dump -U entitynet -d entitynet --format=custom \
  > "$DEST/db-$stamp.dump.partial"
mv "$DEST/db-$stamp.dump.partial" "$DEST/db-$stamp.dump"

# A one-off container on the uploads volume, so this works even when api is
# stopped or failing (e.g. a broken migration).
$COMPOSE run --rm --no-deps -T api tar -C /data -czf - uploads > "$DEST/uploads-$stamp.tar.gz.partial"
mv "$DEST/uploads-$stamp.tar.gz.partial" "$DEST/uploads-$stamp.tar.gz"

find "$DEST" -maxdepth 1 \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) \
  -mtime +"$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok: $DEST/db-$stamp.dump, $DEST/uploads-$stamp.tar.gz"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  # Host network: the container reaches the server's IAM role credentials
  # (instance metadata, IMDSv2 with a hop limit of 1).
  for file in "db-$stamp.dump" "uploads-$stamp.tar.gz"; do
    ${COMPOSE%% *} run --rm --network host -v "$(realpath "$DEST")":/backups:ro "$AWS_CLI_IMAGE" \
      s3 cp --only-show-errors "/backups/$file" "${BACKUP_S3_URI%/}/$file"
  done
  echo "$(date -u +%FT%TZ) copied to ${BACKUP_S3_URI%/}/"
fi
