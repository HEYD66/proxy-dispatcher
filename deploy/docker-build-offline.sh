#!/usr/bin/env bash
set -euo pipefail
# Linux only. Whitelist application files and runtime libraries; never copy data,
# authentication files, host accounts, Docker configuration or private TLS keys.
SOURCE="${PROXY_DISPATCHER_SOURCE:-/opt/proxy-dispatcher}"
NODE="${PROXY_DISPATCHER_NODE:-$SOURCE/runtime/node}"
MIHOMO="${PROXY_DISPATCHER_MIHOMO:-$SOURCE/bin/mihomo}"
IMAGE="${PROXY_DISPATCHER_IMAGE:-proxy-dispatcher:1.0.0}"
APP_UID="${PROXY_DISPATCHER_UID:-$(id -u proxy-dispatcher)}"
APP_GID="${PROXY_DISPATCHER_GID:-$(id -g proxy-dispatcher)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test -x "$NODE"; test -x "$MIHOMO"
BUILD="$(mktemp -d /tmp/pd-docker-build.XXXXXX)"
trap 'rm -rf -- "$BUILD"' EXIT
mkdir -p "$BUILD/rootfs/app/vendor/mihomo" "$BUILD/rootfs/usr/local/bin" "$BUILD/rootfs/etc/ssl/certs" "$BUILD/rootfs/home/proxy-dispatcher" "$BUILD/rootfs/var/lib/proxy-dispatcher/data" "$BUILD/rootfs/tmp"
for file in server.mjs server-auth.mjs shared-bridge.mjs event-log.mjs settings-store.mjs store.mjs proxy-probe.mjs package.json; do cp "$SOURCE/$file" "$BUILD/rootfs/app/$file"; done
cp -a "$SOURCE/public" "$SOURCE/node_modules" "$BUILD/rootfs/app/"
cp "$NODE" "$BUILD/rootfs/usr/local/bin/node"
cp "$MIHOMO" "$BUILD/rootfs/app/vendor/mihomo/mihomo"
ldd "$NODE" > "$BUILD/node-libraries.txt"
if grep -q 'not found' "$BUILD/node-libraries.txt"; then echo 'Node runtime has missing libraries' >&2; exit 1; fi
awk '{for(i=1;i<=NF;i++) if($i ~ /^\//) print $i}' "$BUILD/node-libraries.txt" | sort -u | while IFS= read -r library; do
  mkdir -p "$BUILD/rootfs$(dirname "$library")"
  cp -L "$library" "$BUILD/rootfs$library"
done
# Mihomo's official Linux binary must be static for this offline builder.
if ldd "$MIHOMO" 2>&1 | grep -q '=>'; then echo 'Offline build requires a static Mihomo binary' >&2; exit 1; fi
cp /etc/ssl/certs/ca-certificates.crt "$BUILD/rootfs/etc/ssl/certs/"
if test -f /usr/share/zoneinfo/Asia/Shanghai; then cp /usr/share/zoneinfo/Asia/Shanghai "$BUILD/rootfs/etc/localtime"; fi
printf 'proxy-dispatcher:x:%s:%s::/home/proxy-dispatcher:/usr/sbin/nologin\n' "$APP_UID" "$APP_GID" > "$BUILD/rootfs/etc/passwd"
printf 'proxy-dispatcher:x:%s:\n' "$APP_GID" > "$BUILD/rootfs/etc/group"
chown "$APP_UID:$APP_GID" "$BUILD/rootfs/home/proxy-dispatcher" "$BUILD/rootfs/var/lib/proxy-dispatcher/data"
chmod 1777 "$BUILD/rootfs/tmp"
chmod 755 "$BUILD/rootfs/usr/local/bin/node" "$BUILD/rootfs/app/vendor/mihomo/mihomo"
docker build --build-arg APP_UID="$APP_UID" --build-arg APP_GID="$APP_GID" -f "$SCRIPT_DIR/Dockerfile.offline" -t "$IMAGE" "$BUILD"
