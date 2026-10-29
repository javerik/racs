#!/usr/bin/env bash
# Usage: ./build.sh [x86_64|aarch64|armhf] [api|webapp]
set -euo pipefail

TARGET_ARCH="${1:-x86_64}"
VARIANT="${2:-api}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_NAME=rust-cam-serve
VERSION="${APPIMAGE_VERSION:-$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$SRC_DIR/Cargo.toml" | head -n 1)}"
case "$VARIANT" in
    api) APP_NAME=rust-cam-serve; DISPLAY_NAME="Rust Camera Server" ;;
    webapp) APP_NAME=racs-webapp; DISPLAY_NAME="RACS Webapp" ;;
    *) echo "Unsupported variant: $VARIANT" >&2; exit 1 ;;
esac
case "$TARGET_ARCH" in
    x86_64) CARGO_FLAGS=(--release); BIN_PATH="$SRC_DIR/target/release/$BINARY_NAME" ;;
    aarch64) RUST_TARGET=aarch64-unknown-linux-gnu; CARGO_FLAGS=(--release --target "$RUST_TARGET"); BIN_PATH="$SRC_DIR/target/$RUST_TARGET/release/$BINARY_NAME" ;;
    armhf) RUST_TARGET=armv7-unknown-linux-gnueabihf; CARGO_FLAGS=(--release --target "$RUST_TARGET"); BIN_PATH="$SRC_DIR/target/$RUST_TARGET/release/$BINARY_NAME" ;;
    *) echo "Unsupported architecture: $TARGET_ARCH" >&2; exit 1 ;;
esac
# Guard cleanup paths and keep artifacts from different variants separate.
[[ "$VERSION" =~ ^[a-zA-Z0-9._+-]+$ ]] || { echo "Invalid AppImage version: $VERSION" >&2; exit 1; }
WORK_DIR="$SCRIPT_DIR/build/$VARIANT-$TARGET_ARCH"
APP_DIR="$WORK_DIR/AppDir"
OUTPUT_DIR="${APPIMAGE_OUTPUT_DIR:-$SCRIPT_DIR}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
OUTPUT="$OUTPUT_DIR/$APP_NAME-$VERSION-$TARGET_ARCH.AppImage"

if [ "${CI:-false}" != true ]; then
    (cd "$SRC_DIR" && cargo build "${CARGO_FLAGS[@]}")
    if [ "$VARIANT" = webapp ] && [ -z "${RACS_WEB_DIST:-}" ]; then
        (cd "$SRC_DIR/racs-webapp" && npm ci && npm run build)
        # Bundles laserline under tools/laserline/ (needs the wasm toolchain; RACS_SKIP_LASERLINE=1 skips it).
        if [ "${RACS_SKIP_LASERLINE:-}" != 1 ]; then
            "$SRC_DIR/scripts/build-laserline.sh"
        fi
    fi
fi
[ -f "$BIN_PATH" ] || { echo "Binary not found: $BIN_PATH" >&2; exit 1; }
WEB_DIST="${RACS_WEB_DIST:-$SRC_DIR/racs-webapp/dist/racs-webapp/browser}"
if [ "$VARIANT" = webapp ] && [ ! -f "$WEB_DIST/index.html" ]; then
    echo "Website build not found: $WEB_DIST/index.html" >&2; exit 1
fi
if [ "$VARIANT" = webapp ] && [ "${RACS_SKIP_LASERLINE:-}" != 1 ] && [ ! -f "$WEB_DIST/tools/laserline/index.html" ]; then
    echo "Laserline not bundled: $WEB_DIST/tools/laserline/index.html (scripts/build-laserline.sh; RACS_SKIP_LASERLINE=1 packages without it)" >&2; exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cat > "$WORK_DIR/$APP_NAME.desktop" <<DESKTOP
[Desktop Entry]
Name=$DISPLAY_NAME
Exec=$BINARY_NAME
Icon=$APP_NAME
Type=Application
Terminal=true
Categories=Utility;
DESKTOP
cat > "$WORK_DIR/$APP_NAME.svg" <<'ICON'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <rect width="64" height="64" fill="blue"/>
  <text x="10" y="40" fill="white" font-family="sans-serif" font-size="20">RACS</text>
</svg>
ICON

# Packaging tools run on the x86_64 build host; ARCH selects the target runtime.
for tool in linuxdeploy linuxdeploy-plugin-appimage; do
    if [ ! -f "$SCRIPT_DIR/$tool-x86_64.AppImage" ]; then
        curl --fail --location "https://github.com/linuxdeploy/$tool/releases/download/continuous/$tool-x86_64.AppImage" \
            --output "$SCRIPT_DIR/$tool-x86_64.AppImage"
    fi
    chmod +x "$SCRIPT_DIR/$tool-x86_64.AppImage"
done
ln -s "$SCRIPT_DIR/linuxdeploy-plugin-appimage-x86_64.AppImage" "$WORK_DIR/linuxdeploy-plugin-appimage"
export ARCH="$TARGET_ARCH" NO_STRIP=1 LINUXDEPLOY_OUTPUT_VERSION="$VERSION"
if [ "${CI:-false}" = true ]; then export APPIMAGE_EXTRACT_AND_RUN=1; fi

cd "$WORK_DIR"
# Separate staging from output so web assets and the custom launcher are present
# before the plugin constructs the read-only filesystem.
"$SCRIPT_DIR/linuxdeploy-x86_64.AppImage" \
    --executable "$BIN_PATH" --desktop-file "$WORK_DIR/$APP_NAME.desktop" \
    --icon-file "$WORK_DIR/$APP_NAME.svg" --appdir "$APP_DIR"
if [ "$VARIANT" = webapp ]; then
    mkdir -p "$APP_DIR/usr/share/racs-webapp"
    cp -a "$WEB_DIST/." "$APP_DIR/usr/share/racs-webapp/"
    # linuxdeploy's default AppRun is a symlink; replace it before writing.
    rm -f "$APP_DIR/AppRun"
    cp "$SCRIPT_DIR/AppRun.webapp" "$APP_DIR/AppRun"
    chmod +x "$APP_DIR/AppRun"
fi
# The plugin uses LDAI_OUTPUT verbatim. No glob or stale artifact discovery.
export LDAI_OUTPUT="$OUTPUT"
"$SCRIPT_DIR/linuxdeploy-plugin-appimage-x86_64.AppImage" --appdir "$APP_DIR"
[ -s "$OUTPUT" ] || { echo "AppImage was not created: $OUTPUT" >&2; exit 1; }
echo "Created: $OUTPUT"
