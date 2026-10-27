#!/usr/bin/env bash
# Read-only deployment inspection. Never reads .env, passwords, or container env.
set -euo pipefail
deploy_dir=/root/paperclip-deploy
source_file="$deploy_dir/src/server/src/adapters/member-agent/execute.ts"
expected_source_sha=dd155718d00d5b1a7426c8955c0d063400ca0be045bd812c07d69529839ada53

printf 'REMOTE_UTC=%s\n' "$(date -u +%FT%TZ)"
printf 'REMOTE_USER=%s\n' "$(id -un)"
if [[ -f /etc/ssh/ssh_host_ed25519_key.pub ]]; then
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
fi
if [[ ! -d "$deploy_dir" || ! -f "$source_file" ]]; then
  printf 'PREFLIGHT_STOP=expected deployment source path missing\n' >&2
  exit 20
fi
printf 'DEPLOY_DIRECTORY=%s\n' "$(realpath "$deploy_dir")"
actual_sha=$(sha256sum "$source_file" | cut -d ' ' -f 1)
printf 'SOURCE_SHA256=%s\n' "$actual_sha"
if [[ "$actual_sha" != "$expected_source_sha" ]]; then
  printf 'PREFLIGHT_STOP=source baseline differs; do not apply the patch\n' >&2
  exit 21
fi
if [[ -e "$deploy_dir/src/server/src/adapters/member-agent/cancellation.test.ts" ]]; then
  printf 'PREFLIGHT_STOP=new patch test already exists; inspect prior deployment\n' >&2
  exit 22
fi
cd "$deploy_dir"
docker compose version --short
docker compose ps --format json
server_id=$(docker compose ps -q server)
if [[ -z "$server_id" ]]; then
  printf 'PREFLIGHT_STOP=no running server service\n' >&2
  exit 23
fi
# Select only runtime identity and mount destinations, never all inspect fields.
docker inspect --format 'APPLICATION_IMAGE_ID={{.Image}} APPLICATION_STARTED_AT={{.State.StartedAt}} APPLICATION_STATUS={{.State.Status}}' "$server_id"
docker inspect --format '{{range .Mounts}}MOUNT_TYPE={{.Type}} DESTINATION={{.Destination}}{{println}}{{end}}' "$server_id"
printf 'HEALTH_JSON='
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3100/api/health
printf '\n'
df -h "$deploy_dir"
command -v git >/dev/null
command -v tar >/dev/null
printf 'PREFLIGHT_READONLY=PASS\n'
printf 'ACTIVE_TASK_GATE=still required through the owner board session before container replacement\n'
