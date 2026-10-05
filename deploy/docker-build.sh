#!/usr/bin/env bash
set -euo pipefail
IMAGE="${PROXY_DISPATCHER_IMAGE:-proxy-dispatcher:1.0.0}"
APP_UID="${PROXY_DISPATCHER_UID:-10001}"
APP_GID="${PROXY_DISPATCHER_GID:-10001}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker build --pull --build-arg APP_UID="$APP_UID" --build-arg APP_GID="$APP_GID" -f "$ROOT/deploy/Dockerfile" -t "$IMAGE" "$ROOT"
