#!/bin/sh
# Fetch ANGLE (libEGL, libGLESv2) and SwiftShader (libvk_swiftshader + ICD json) for motion-render's
# WebGL. They come from an Electron release on GitHub: the same Chromium ANGLE build Chrome uses,
# BSD-licensed, checked against the release's SHASUMS256.txt.
#
# The pin: Electron 43.x is the last line that ships libEGL/libGLESv2 as separate files; from 44 on
# Electron links ANGLE into its framework (Chrome already does), so this source has no future. It
# keeps working for 43.x patch releases. Follow-up, before 43 stops being useful:
#   1. build ANGLE from source in CI (gn args: angle_enable_metal/vulkan/swiftshader, is_debug=false,
#      angle_build_all=false) for the four release targets, and
#   2. publish the result as motion-use's own pinned release asset (angle-<rev>-<os>-<arch>.tar.gz +
#      .sha256), which this script then downloads instead of the Electron zip.
# CI (native.yml) runs this script and packs the libraries next to motion-render in each tarball.
#
#   native/scripts/fetch-angle.sh [<dest dir>]
#
# Default destination: ~/.cache/motion-render/angle/<electron-version>-<platform>/ — one of the
# places motion-render looks (MOTION_RENDER_ANGLE_DIR, next to the binary, then that cache).
set -eu
ELECTRON="${MOTION_RENDER_ELECTRON:-v43.7.9}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLAT=darwin-arm64 ;;
  Darwin-x86_64) PLAT=darwin-x64 ;;
  Linux-x86_64) PLAT=linux-x64 ;;
  Linux-aarch64) PLAT=linux-arm64 ;;
  *) echo "fetch-angle: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
DEST="${1:-$HOME/.cache/motion-render/angle/$ELECTRON-$PLAT}"
if [ -f "$DEST/.ok" ]; then echo "$DEST"; exit 0; fi
ZIP="electron-$ELECTRON-$PLAT.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/electron/electron/releases/download/$ELECTRON"
echo "fetch-angle: downloading $ZIP" >&2
curl -fsSL "$BASE/$ZIP" -o "$TMP/$ZIP"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
WANT="$(grep " \*\{0,1\}$ZIP\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/$ZIP" | awk '{print $1}')"; else GOT="$(shasum -a 256 "$TMP/$ZIP" | awk '{print $1}')"; fi
if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then echo "fetch-angle: checksum mismatch for $ZIP" >&2; exit 1; fi
mkdir -p "$DEST"
case "$PLAT" in
  darwin-*)
    LIBS="Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries"
    unzip -q -o "$TMP/$ZIP" "$LIBS/*" -d "$TMP/x"
    for f in libEGL.dylib libGLESv2.dylib libvk_swiftshader.dylib vk_swiftshader_icd.json; do cp "$TMP/x/$LIBS/$f" "$DEST/"; done
    ;;
  linux-*)
    unzip -q -o "$TMP/$ZIP" libEGL.so libGLESv2.so libvk_swiftshader.so vk_swiftshader_icd.json libvulkan.so.1 -d "$TMP/x"
    cp "$TMP/x/"* "$DEST/"
    ;;
esac
unzip -p "$TMP/$ZIP" LICENSES.chromium.html > "$DEST/LICENSES.chromium.html" 2>/dev/null || true
echo "$ELECTRON $PLAT" > "$DEST/.ok"
echo "$DEST"
