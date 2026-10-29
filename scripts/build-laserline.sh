#!/usr/bin/env bash
# Builds the laserline web app (submodule laserthing/) for /tools/laserline/ and copies it
# into a RACS web dist.
# Usage: scripts/build-laserline.sh [web-dist]   (default: racs-webapp/dist/racs-webapp/browser)
# Needs: node/npm, rustup with the wasm32-unknown-unknown target. A wasm-bindgen-cli of the
# version laserthing's Cargo.lock pins is used from PATH, otherwise its prebuilt release is
# downloaded (x86_64/aarch64 Linux) or, failing that, built with cargo install.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/laserthing"
dist="$(realpath -m "${1:-$root/racs-webapp/dist/racs-webapp/browser}")"
base="/tools/laserline/"

if [[ ! -f "$src/package.json" ]]; then
    echo "laserthing/ is empty: git submodule update --init --recursive" >&2
    exit 1
fi

want="$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' "$src/Cargo.lock" | head -n1)"
have="$(wasm-bindgen --version 2>/dev/null | cut -d' ' -f2 || true)"
if [[ "$have" != "$want" ]]; then
    tools="$src/target/tools/wasm-bindgen-$want"
    if [[ ! -x "$tools/wasm-bindgen" ]]; then
        arch="$(uname -m)"
        url="https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$want/wasm-bindgen-$want-$arch-unknown-linux-musl.tar.gz"
        mkdir -p "$tools"
        if ! curl -fsSL "$url" | tar -xz -C "$tools" --strip-components=1; then
            echo "no prebuilt wasm-bindgen $want for $arch: cargo install" >&2
            cargo install wasm-bindgen-cli --version "$want" --locked --root "$tools"
            mv "$tools/bin/wasm-bindgen" "$tools/"
        fi
    fi
    export PATH="$tools:$PATH"
fi
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

cd "$src"
npm ci
npm run build:wasm
npm run build:laserline
npm run build:angular
npx ng build laserline-web --base-href "$base"

rm -rf "$dist/tools/laserline"
mkdir -p "$dist/tools/laserline"
cp -a "$src/apps/laserline-web/dist/browser/." "$dist/tools/laserline/"
echo "laserline -> $dist/tools/laserline"
