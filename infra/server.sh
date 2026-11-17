#!/usr/bin/env bash
# Set up the app on a server created by `./tf.sh <env> apply`, and save its data
# before `./tf.sh <env> destroy`. Runs from your machine over SSH; it never runs
# Terraform. Only QA for now.
#
#   ./server.sh qa save                     # backup on the server, copied here
#   ./server.sh qa deploy                   # clone, .env, build, start, cron, health
#   ./server.sh qa deploy --restore <dir>   # ...then restore a saved backup
#
# Options:
#   --ip <address>    server IP (default: public_ip from envs/<env>/terraform.tfstate)
#   --ref <git ref>   what to deploy (default: origin/main)
#   --yes             restore without asking
#   --smtp            ask for the email (SMTP) settings again; a new server's
#                     deploy always asks (leave the host empty for no email)
# Environment:
#   REPO_URL          git URL the server clones (default: the public GitHub repo)
#   IMAGE_PREFIX      registry the images come from (default: ghcr.io/milo80/)
#   QA_BACKUP_DIR     where `save` puts backups (default: envs/qa/backups)
#
# Running `deploy` again on a server that is already set up updates it: it backs
# up the running stack, checks out --ref and switches to its images. Its .env is
# kept. Servers never build images: deploy pulls the ones CI built and tested
# for that commit, so it fails until CI has passed on it.
# The SMTP password is typed here and sent over SSH's stdin, never as an argument.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/milo80/EntityNetworksWoS.git}
# CI pushes the images it tested here, tagged with the full commit SHA.
IMAGE_PREFIX=${IMAGE_PREFIX:-ghcr.io/milo80/}
APP_DIR=/opt/entitynetworks

usage() {
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

env="${1:-}"
cmd="${2:-}"
[[ "$env" == "qa" ]] || { echo "only 'qa' is supported for now" >&2; usage; }
[[ "$cmd" == "save" || "$cmd" == "deploy" ]] || usage
shift 2

ip="" ref="origin/main" restore="" yes=false ask_smtp=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ip) ip="$2"; shift 2 ;;
        --ref) ref="$2"; shift 2 ;;
        --restore) restore="$2"; shift 2 ;;
        --yes) yes=true; shift ;;
        --smtp) ask_smtp=true; shift ;;
        *) usage ;;
    esac
done

# Paths you pass are relative to where you run the script; the defaults to infra/.
[[ -z "$restore" ]] || restore=$(realpath "$restore")
[[ -z "${QA_BACKUP_DIR:-}" ]] || QA_BACKUP_DIR=$(realpath -m "$QA_BACKUP_DIR")
cd "$(dirname "$0")"

if [[ -z "$ip" ]]; then
    ip=$(python3 -c '
import json, sys
outputs = json.load(open(sys.argv[1])).get("outputs", {})
print(outputs.get("public_ip", {}).get("value", ""))
' "envs/$env/terraform.tfstate" 2>/dev/null || true)
    [[ -n "$ip" ]] || { echo "no server in envs/$env/terraform.tfstate: run ./tf.sh $env apply, or pass --ip" >&2; exit 1; }
fi
host="ubuntu@$ip"
address="${ip//./-}.sslip.io"
ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }

# Run the script on stdin (a heredoc) on the server, with the given arguments.
# It goes over as an argument, not on ssh's stdin: commands like `docker compose
# exec` read stdin and would swallow the rest of the script.
remote_script() {
    local script
    script=$(cat)
    ssh "${ssh_opts[@]}" "$host" "bash -c $(printf '%q' "$script") remote $(printf '%q ' "$@")" </dev/null
}

if [[ "$cmd" == "save" ]]; then
    # Prints the two file names backup.sh just wrote.
    files=$(remote_script "$APP_DIR" <<'EOF'
set -euo pipefail
cd "$1/deploy"
./backup.sh >&2
ls -t backups/db-*.dump | head -1
ls -t backups/uploads-*.tar.gz | head -1
EOF
    )
    db_file=$(sed -n 1p <<<"$files")
    uploads_file=$(sed -n 2p <<<"$files")
    stamp=$(basename "$db_file" .dump)
    stamp=${stamp#db-}
    dest="${QA_BACKUP_DIR:-envs/qa/backups}/$stamp"
    umask 077  # the dump holds password hashes and user data
    mkdir -p "$dest"
    scp "${ssh_opts[@]}" -q "$host:$APP_DIR/deploy/$db_file" "$host:$APP_DIR/deploy/$uploads_file" "$dest/"
    chmod 600 "$dest"/*
    echo "saved: $dest"
    echo "restore it after the next apply with: ./server.sh $env deploy --restore $dest"
    exit 0
fi

# --- deploy ---

if [[ -n "$restore" ]]; then
    db_dump=$(ls "$restore"/db-*.dump 2>/dev/null | tail -1 || true)
    uploads_tgz=$(ls "$restore"/uploads-*.tar.gz 2>/dev/null | tail -1 || true)
    [[ -n "$db_dump" && -n "$uploads_tgz" ]] || { echo "$restore needs a db-*.dump and an uploads-*.tar.gz" >&2; exit 1; }
    if ! $yes; then
        read -r -p "Replace all data on $address with $restore? [y/N] " answer
        [[ "$answer" == [yY]* ]] || { echo "cancelled" >&2; exit 1; }
    fi
fi

echo "waiting for SSH on $ip..."
for _ in $(seq 30); do
    remote true 2>/dev/null && break
    sleep 10
done
remote true

echo "waiting for first-boot setup (cloud-init)..."
# Exit status 2 means done with warnings, which is fine.
remote 'cloud-init status --wait >/dev/null; rc=$?; [ $rc -eq 0 ] || [ $rc -eq 2 ]'

# Email for password reset links: asked on a new server (no .env yet) or with
# --smtp, before the long build. The values stay in this shell's memory.
smtp_host=""
new_server=false
remote "test -f $APP_DIR/deploy/.env" || { new_server=true; ask_smtp=true; }
if $ask_smtp; then
    if [[ -t 0 ]]; then
        echo "Email for password reset links (SMTP, port 587 with STARTTLS)."
        echo "Leave the host empty to send no email (links then go to the API log)."
        read -r -p "SMTP host (e.g. email-smtp.us-east-1.amazonaws.com): " smtp_host
        if [[ -n "$smtp_host" ]]; then
            read -r -p "SMTP user name: " smtp_user
            read -r -s -p "SMTP password (not shown): " smtp_pass; echo
            read -r -p "From (e.g. EntityNetworks <you@example.org>): " smtp_from
            for value in "$smtp_host" "$smtp_user" "$smtp_pass" "$smtp_from"; do
                [[ -n "$value" && "$value" != *"'"* ]] || { echo "SMTP values must be non-empty and contain no single quote" >&2; exit 1; }
            done
        fi
    else
        echo "not a terminal: no email set up (run again with --smtp to add it)"
    fi
fi

# New session, so the docker group from cloud-init applies.
remote_script "$APP_DIR" "$REPO_URL" "$ref" "$address" "$IMAGE_PREFIX" <<'EOF'
set -euo pipefail
app_dir=$1 repo_url=$2 ref=$3 address=$4 prefix=$5

if [ ! -d "$app_dir/.git" ]; then
    git clone --quiet "$repo_url" "$app_dir"
fi
cd "$app_dir/deploy"
git -C "$app_dir" fetch --quiet origin
tag=$(git -C "$app_dir" rev-parse "$ref^{commit}")

# Pull first: if CI hasn't published images for this commit, stop before
# anything on the server changes.
echo "pulling the images CI built for $tag..."
for name in entitynetworks-api entitynetworks-web; do
    if ! docker pull --quiet "$prefix$name:$tag" >/dev/null; then
        echo "no image $prefix$name:$tag: has CI passed on this commit (and are the packages public)?" >&2
        exit 1
    fi
done

# Updating a running stack: back it up first.
if [ -f .env ] && [ -n "$(docker compose ps -q db 2>/dev/null)" ]; then
    ./backup.sh
fi

git -C "$app_dir" checkout --quiet --detach "$tag"

if [ ! -f .env ]; then
    # The secret is generated here and never leaves the server.
    (umask 077 && cp .env.example .env)
    sed -i \
        -e "s/^SITE_ADDRESS=.*/SITE_ADDRESS=$address/" \
        -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" \
        -e "s/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/" \
        .env
    echo "created .env for $address"
fi
chmod 600 .env
sed -i "s/^TAG=.*/TAG=$tag/" .env
if grep -q '^IMAGE_PREFIX=' .env; then
    sed -i "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=$prefix|" .env
else
    echo "IMAGE_PREFIX=$prefix" >> .env
fi
EOF

if [[ -n "$smtp_host" ]]; then
    # Values go on stdin, so they never show up in a process list. The script
    # rewrites .env with shell builtins only, for the same reason. Single quotes
    # keep Compose from reading "$" in a password as a variable.
    script=$(cat <<'EOF'
set -euo pipefail
cd "$1/deploy"
IFS= read -r host; IFS= read -r user; IFS= read -r pass; IFS= read -r from
umask 077
: > .env.new
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        SMTP_HOST=*) line="SMTP_HOST=$host" ;;
        SMTP_USERNAME=*) line="SMTP_USERNAME=$user" ;;
        SMTP_PASSWORD=*) line="SMTP_PASSWORD='$pass'" ;;
        SMTP_FROM=*) line="SMTP_FROM='$from'" ;;
    esac
    printf '%s\n' "$line" >> .env.new
done < .env
mv .env.new .env
echo "email settings written to .env"
EOF
    )
    printf '%s\n' "$smtp_host" "$smtp_user" "$smtp_pass" "$smtp_from" |
        ssh "${ssh_opts[@]}" "$host" "bash -c $(printf '%q' "$script") remote $(printf '%q' "$APP_DIR")"
    unset smtp_pass
fi

remote_script "$APP_DIR" <<'EOF'
set -euo pipefail
cd "$1/deploy"
echo "starting $(sed -n 's/^TAG=//p' .env)..."
docker compose up -d --no-build --quiet-pull
EOF

if [[ -n "$restore" ]]; then
    echo "restoring $restore..."
    remote 'install -d -m 700 /tmp/entitynetworks-restore'
    scp "${ssh_opts[@]}" -q "$db_dump" "$host:/tmp/entitynetworks-restore/db.dump"
    scp "${ssh_opts[@]}" -q "$uploads_tgz" "$host:/tmp/entitynetworks-restore/uploads.tar.gz"
    remote_script "$APP_DIR" <<'EOF'
set -euo pipefail
cd "$1/deploy"
src=/tmp/entitynetworks-restore
docker compose stop api worker
docker compose exec -T db pg_restore -U entitynet -d entitynet --clean --if-exists < "$src/db.dump"
docker compose run --rm --no-deps -T api sh -c 'rm -rf /data/uploads/* && tar -C /data -xzf -' \
    < "$src/uploads.tar.gz"
docker compose run --rm migrate   # in case the code is newer than the backup
docker compose start api worker
rm -rf "$src"
EOF
fi

# Daily backup, added once.
remote_script "$APP_DIR" <<'EOF'
set -euo pipefail
line="15 3 * * *  $1/deploy/backup.sh >> \$HOME/entitynetworks-backup.log 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "$1/deploy/backup.sh"; then
    (crontab -l 2>/dev/null || true; echo "$line") | crontab -
    echo "added the daily backup to the crontab"
fi
EOF

echo "waiting for https://$address/api/health (Caddy gets its certificate first)..."
for _ in $(seq 24); do
    if curl -fsS -m 10 "https://$address/api/health" >/dev/null 2>&1; then
        echo "ready: https://$address"
        if $new_server && [[ -z "$restore" ]]; then
            echo "empty database: create the admin with"
            echo "  ssh -t $host 'cd $APP_DIR/deploy && docker compose exec api python -m app.manage create-user you@example.org --admin'"
        fi
        exit 0
    fi
    sleep 5
done
echo "https://$address/api/health is not answering; check: ssh $host 'cd $APP_DIR/deploy && docker compose ps && docker compose logs --tail 50'" >&2
exit 1
