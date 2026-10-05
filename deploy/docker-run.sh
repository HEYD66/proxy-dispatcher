#!/usr/bin/env bash
set -euo pipefail
IMAGE="${PROXY_DISPATCHER_IMAGE:-proxy-dispatcher:1.0.0}"
CONTAINER="${PROXY_DISPATCHER_CONTAINER:-proxy-dispatcher}"
ENV_FILE="${PROXY_DISPATCHER_ENV:-/etc/proxy-dispatcher/proxy-dispatcher.env}"
DATA_DIR="${PROXY_DISPATCHER_DATA:-/var/lib/proxy-dispatcher/data}"
test -r "$ENV_FILE"; test -d "$DATA_DIR"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Host networking is intentional on Linux: Node stays on 127.0.0.1 while Mihomo
# retains the host listener range and Nginx/SSH tunnel keep their existing paths.
exec docker run --detach --name "$CONTAINER" --restart unless-stopped --network host \
  --env-file "$ENV_FILE" --env MIHOMO_PATH=/app/vendor/mihomo/mihomo \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --mount "type=bind,src=$DATA_DIR,dst=/var/lib/proxy-dispatcher/data" \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 \
  --ulimit nofile=65536:65536 --log-opt max-size=10m --log-opt max-file=3 \
  --memory 768m --memory-swap 768m "$IMAGE"
