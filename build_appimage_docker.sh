#!/usr/bin/env bash
set -euo pipefail
TARGET_ARCH="${1:-x86_64}"
VARIANT="${2:-api}"
web_environment=()
# Build frontend assets with Node 22, independently of the Rust builder's Node version.
if [ "$VARIANT" = webapp ]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app/racs-webapp \
    -e npm_config_cache=/tmp/racs-npm-cache node:22-bookworm \
    /bin/sh -c 'npm ci && npm run build'
  web_environment=(-e RACS_WEB_DIST=/app/racs-webapp/dist/racs-webapp/browser)
fi
# Local builds compile Rust rather than expecting artifacts from another CI job.
docker run --rm -it -v "$PWD:/app" -w /app "${web_environment[@]}" --entrypoint /bin/bash \
  git-docker.javerik.dev/opensource/rustcamserve:2-debian-builder \
  -c 'cd appimage && ./build.sh "$@"' -- "$TARGET_ARCH" "$VARIANT"
