#!/usr/bin/env bash
set -euo pipefail

# Build a signed, self-contained WebView APK.
#
# Requirements:
#   - Android SDK platform 34 + build-tools 34.0.0 in $ANDROID_HOME
#   - JDK 17/21 (JDK 27 may reject -source 8)
#   - built web assets in ../dist (pnpm build)
#
# Signing (the keystore is intentionally not part of this repository):
#   KEYSTORE=/path/to/xiaohuangbo.jks KS_PASS=... KEY_ALIAS=xiaohuangbo ./build-apk.sh
#
# The app serves ../dist from assets over http://127.0.0.1:18765; the Python
# MCP backend sources under assets/backend are bundled for reference but are
# not executed by Android (they need Python/torch/EasyJailbreak on a host).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/android"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
PLATFORM="${PLATFORM:-$SDK/platforms/android-34/android.jar}"
KEYSTORE="${KEYSTORE:-$HOME/桌面/xiaohuangbo.jks}"
KEY_ALIAS="${KEY_ALIAS:-xiaohuangbo}"
: "${KS_PASS:?set KS_PASS (keystore password)}"
KEY_PASS="${KEY_PASS:-$KS_PASS}"
VERSION_CODE="${VERSION_CODE:-272}"
VERSION_NAME="${VERSION_NAME:-2.7.2}"
OUT="${OUT:-$HERE/deepseek-unrestricted-$VERSION_NAME.apk}"

for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS/$tool" ]; then
    echo "missing $BUILD_TOOLS/$tool" >&2
    exit 1
  fi
done
if [ ! -f "$PLATFORM" ]; then
  echo "missing $PLATFORM" >&2
  exit 1
fi
if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "missing $ROOT/dist/index.html; run pnpm build first" >&2
  exit 1
fi

rm -rf "$HERE/assets/public" "$HERE/build"
mkdir -p "$HERE/assets/public" "$HERE/build/gen" "$HERE/build/classes" "$HERE/build/dex"
cp -a "$ROOT/dist/." "$HERE/assets/public/"

"$BUILD_TOOLS/aapt2" compile --dir "$HERE/res" -o "$HERE/build/resources.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$HERE/build/unsigned.apk" \
  -I "$PLATFORM" \
  --manifest "$HERE/AndroidManifest.xml" \
  -R "$HERE/build/resources.zip" \
  --auto-add-overlay \
  --java "$HERE/build/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --replace-version \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  -A "$HERE/assets"

javac -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$PLATFORM" \
  -d "$HERE/build/classes" \
  "$HERE/build/gen/com/xiaohuangbo/deepseekunrestricted/R.java" \
  "$HERE/src/com/xiaohuangbo/deepseekunrestricted/MainActivity.java" \
  "$HERE/src/com/xiaohuangbo/deepseekunrestricted/LocalServer.java"

find "$HERE/build/classes" -name '*.class' -print > "$HERE/build/classes.list"
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 24 --output "$HERE/build/dex" @"$HERE/build/classes.list"

cp "$HERE/build/unsigned.apk" "$HERE/build/with-dex.apk"
(cd "$HERE/build/dex" && zip -q -j ../with-dex.apk classes.dex)
"$BUILD_TOOLS/zipalign" -p -f 4 "$HERE/build/with-dex.apk" "$HERE/build/aligned.apk"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --out "$OUT" \
  "$HERE/build/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT"
"$BUILD_TOOLS/aapt2" dump badging "$OUT" | sed -n '1,4p'
echo "APK: $OUT"
