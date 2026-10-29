#!/usr/bin/env bash
# Builds everything RACS needs to serve its web UI and starts the server with it:
# submodules, the server (release), the web UI (racs-webapp) and laserline (laserthing/),
# then runs rust-cam-serve with --web-root pointing at the built web dist.
# Usage: scripts/run-racs.sh [options] [-- server args...]
#   --skip-build       start with what is already built
#   --skip-laserline   build without laserline (no wasm toolchain needed)
#   --no-npm-ci        reuse racs-webapp/node_modules instead of a clean npm ci
#   --build-only       build, don't start
#   Server args after -- are passed through (e.g. -- --port 8743 --host 127.0.0.1).
#   RACS_HOST/RACS_PORT and RUST_LOG (default info) apply as usual.
# Needs: cargo, node/npm; for laserline also rustup (wasm32-unknown-unknown), see build-laserline.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
web="$root/racs-webapp"
dist="$web/dist/racs-webapp/browser"

build=1 laserline=1 npm_ci=1 start=1
server_args=()
while (($#)); do
    case "$1" in
        --skip-build) build=0 ;;
        --skip-laserline) laserline=0 ;;
        --no-npm-ci) npm_ci=0 ;;
        --build-only) start=0 ;;
        --) shift; server_args=("$@"); break ;;
        -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (--help)" >&2; exit 1 ;;
    esac
    shift
done

step() { printf '\n==> %s\n' "$*"; }

if ((build)); then
    step "submodules"
    git -C "$root" submodule update --init --recursive

    step "server (cargo build --release)"
    (cd "$root" && cargo build --release)

    step "web UI (racs-webapp)"
    cd "$web"
    if ((npm_ci)) || [[ ! -d node_modules ]]; then npm ci; fi
    npx ng build

    # ng build empties dist/, so laserline goes in afterwards.
    if ((laserline)); then
        step "laserline (laserthing/)"
        "$root/scripts/build-laserline.sh" "$dist"
    fi
fi

bin="$root/target/release/rust-cam-serve"
[[ -x "$bin" ]] || { echo "server not built: $bin" >&2; exit 1; }
[[ -f "$dist/index.html" ]] || { echo "web UI not built: $dist/index.html" >&2; exit 1; }
((start)) || { echo "built: $bin, web root $dist"; exit 0; }

# Don't start a second server on a port that is taken (a developer server often runs on 8742).
port="${RACS_PORT:-8742}"
for ((i = 0; i < ${#server_args[@]}; i++)); do
    case "${server_args[i]}" in
        --port) port="${server_args[i+1]:-$port}" ;;
        --port=*) port="${server_args[i]#--port=}" ;;
    esac
done
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is already in use (another RACS server?): stop it or pass -- --port <other>" >&2
    exit 1
fi

step "starting rust-cam-serve on port $port (web UI at http://localhost:$port/)"
cd "$root"
export RUST_LOG="${RUST_LOG:-info}"
exec "$bin" --web-root "$dist" "${server_args[@]}"
