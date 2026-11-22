#!/usr/bin/env bash
set -euo pipefail

# Build a signed, self-contained WebView APK.
#
# Interactive by default: it asks for the version, keystore, output path and
# whether to rebuild the web assets or install the result. Flags and env vars
# skip the questions, so the same script works in a non-interactive shell:
#
#   ./build-apk.sh --yes                 # defaults, needs KS_PASS
#   KS_PASS=... ./build-apk.sh --yes --no-build-web
#   ./build-apk.sh --version 2.7.9 --version-code 279 --install
#
# Requirements:
#   - Android SDK platform 34 + build-tools 34.0.0 or newer (default $HOME/android-sdk)
#   - JDK 17/21 (a newer javac may reject -source 8; the script picks 21 when present)
#   - built web assets in ../dist (or let the script run pnpm build)
#
# Signing (the keystore is intentionally not part of this repository):
#   KEYSTORE=/path/to/xiaohuangbo.jks KS_PASS=... KEY_ALIAS=xiaohuangbo ./build-apk.sh
#
# The app serves ../dist from assets over http://127.0.0.1:18765; the Python
# MCP backend sources under assets/backend are bundled for reference but are
# not executed by Android (they need Python/torch/EasyJailbreak on a host).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/android"

ASSUME_YES=0
IS_TTY=0
[ -t 0 ] && IS_TTY=1
BUILD_WEB="ask"   # ask | yes | no
DO_INSTALL="ask"  # ask | yes | no

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-}"
PLATFORM="${PLATFORM:-}"
KEYSTORE="${KEYSTORE:-$HOME/桌面/xiaohuangbo.jks}"
KEY_ALIAS="${KEY_ALIAS:-xiaohuangbo}"
KS_PASS="${KS_PASS:-}"
KEY_PASS="${KEY_PASS:-}"
VERSION_NAME="${VERSION_NAME:-}"
VERSION_CODE="${VERSION_CODE:-}"
OUT="${OUT:-}"

# Defaults from the app, not from the flags above.
DEFAULT_VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)"
[ -n "$DEFAULT_VERSION" ] || DEFAULT_VERSION="2.7.9"
DEFAULT_VERSION_CODE="$(printf '%s' "$DEFAULT_VERSION" | awk -F. '{ printf "%d", ($1 * 100) + ($2 * 10) + $3 }' 2>/dev/null || true)"
[ -n "$DEFAULT_VERSION_CODE" ] || DEFAULT_VERSION_CODE="279"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Interactive prompts are skipped with --yes (or when stdin is not a terminal).

Options:
  -y, --yes             use the defaults, no questions
      --build-web       run pnpm build before packaging
      --no-build-web    use the existing dist as-is
      --install         adb install -r the APK after building
      --no-install      never install (default)
      --version NAME    versionName (default: package.json, $DEFAULT_VERSION)
      --version-code N  versionCode (default: $DEFAULT_VERSION_CODE)
      --keystore PATH   signing keystore (default: $KEYSTORE)
      --alias NAME      key alias (default: $KEY_ALIAS)
      --out PATH        output APK (default: android/deepseek-unrestricted-<version>.apk)
      --sdk PATH        Android SDK root (default: $SDK)
  -h, --help            this help

Environment: KEYSTORE, KS_PASS, KEY_ALIAS, KEY_PASS, VERSION_NAME,
VERSION_CODE, OUT, ANDROID_HOME, BUILD_TOOLS, PLATFORM.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --build-web) BUILD_WEB=yes ;;
    --no-build-web) BUILD_WEB=no ;;
    --install) DO_INSTALL=yes ;;
    --no-install) DO_INSTALL=no ;;
    --version) VERSION_NAME="${2:?--version needs a value}"; shift ;;
    --version-code) VERSION_CODE="${2:?--version-code needs a value}"; shift ;;
    --keystore) KEYSTORE="${2:?--keystore needs a value}"; shift ;;
    --alias) KEY_ALIAS="${2:?--alias needs a value}"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift ;;
    --sdk) SDK="${2:?--sdk needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

VERSION_NAME="${VERSION_NAME:-$DEFAULT_VERSION}"
VERSION_CODE="${VERSION_CODE:-$DEFAULT_VERSION_CODE}"

expand_tilde() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
KEYSTORE="$(expand_tilde "$KEYSTORE")"

# --- a small ask/ask_secret pair ------------------------------------------------
# When --yes or no TTY, the current value is kept (or the default is used).
ask() { # VAR PROMPT DEFAULT
  local __var="$1" __prompt="$2" __default="$3" __in=""
  if [ "$ASSUME_YES" -eq 1 ] || [ "$IS_TTY" -eq 0 ]; then
    printf -v "$__var" '%s' "${!__var:-$__default}"
    return 0
  fi
  read -r -p "$__prompt [$__default]: " __in || true
  printf -v "$__var" '%s' "${__in:-$__default}"
}

ask_yes_no() { # VAR PROMPT DEFAULT(y|n)
  local __var="$1" __prompt="$2" __default="$3" __in=""
  if [ "$ASSUME_YES" -eq 1 ] || [ "$IS_TTY" -eq 0 ]; then
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  read -r -p "$__prompt [${__default}] " __in || true
  case "${__in:-$__default}" in
    y|Y|yes|YES) printf -v "$__var" '%s' "yes" ;;
    *)            printf -v "$__var" '%s' "no" ;;
  esac
}

say() { printf '\n==> %s\n' "$*"; }

# --- JDK: prefer 21 (or 17) over a newer default --------------------------------
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  :
else
  for candidate in \
    /usr/lib/jvm/java-21-openjdk \
    /usr/lib/jvm/java-21-openjdk-* \
    /usr/lib/jvm/java-17-openjdk \
    /usr/lib/jvm/java-17-openjdk-*; do
    if [ -x "$candidate/bin/javac" ]; then
      JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi
JAVAC_MAJOR="$(javac -version 2>&1 | sed -n 's/^javac \([0-9][0-9]*\).*/\1/p' | head -1)"
if [ -n "$JAVAC_MAJOR" ] && [ "$JAVAC_MAJOR" -ge 22 ] 2>/dev/null; then
  echo "warning: javac $JAVAC_MAJOR may reject -source 8; install JDK 21 or set JAVA_HOME" >&2
fi

# --- interactive values ---------------------------------------------------------
say "APK build"
if [ "$ASSUME_YES" -eq 0 ] && [ "$IS_TTY" -eq 1 ]; then
  echo "直接回车使用括号里的默认值。"
  ask VERSION_NAME "版本名 (versionName)" "$VERSION_NAME"
  ask VERSION_CODE "版本号 (versionCode)" "$VERSION_CODE"
  ask KEYSTORE "签名文件 keystore" "$KEYSTORE"
  ask KEY_ALIAS "密钥别名 key alias" "$KEY_ALIAS"
  if [ -z "$KS_PASS" ]; then
    read -r -s -p "签名密码 (keystore password): " KS_PASS || true
    echo
  fi
  if [ -z "$KEY_PASS" ]; then
    local_kp=""
    read -r -s -p "密钥密码 (回车 = 同签名密码): " local_kp || true
    echo
    [ -n "$local_kp" ] && KEY_PASS="$local_kp"
  fi
  [ -n "$OUT" ] || OUT="$HERE/deepseek-unrestricted-$VERSION_NAME.apk"
  ask OUT "输出文件 output APK" "$OUT"
fi

# Validate values that came from flags/env.
case "$VERSION_CODE" in
  ''|*[!0-9]*) echo "version code must be a number: $VERSION_CODE" >&2; exit 1 ;;
esac
KEYSTORE="$(expand_tilde "$KEYSTORE")"
[ -n "$OUT" ] || OUT="$HERE/deepseek-unrestricted-$VERSION_NAME.apk"
[ -f "$KEYSTORE" ] || { echo "keystore not found: $KEYSTORE" >&2; exit 1; }
OUT="$(expand_tilde "$OUT")"
mkdir -p "$(dirname "$OUT")"
if [ -z "$KS_PASS" ]; then
  echo "KS_PASS is required (set it in the environment or run interactively)" >&2
  exit 1
fi
[ -n "$KEY_PASS" ] || KEY_PASS="$KS_PASS"

# SDK paths. If the default is missing, let an interactive user point at it.
if [ -z "$BUILD_TOOLS" ]; then
  # Prefer the newest installed build-tools (d8 34.0.0 NPEs on a null
  # MethodParameters name that JDK 21 emits for anonymous classes).
  BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
  [ -n "$BUILD_TOOLS" ] || BUILD_TOOLS="$SDK/build-tools/34.0.0"
fi
if [ -z "$PLATFORM" ]; then PLATFORM="$SDK/platforms/android-34/android.jar"; fi
if [ ! -x "$BUILD_TOOLS/aapt2" ] && [ "$ASSUME_YES" -eq 0 ] && [ "$IS_TTY" -eq 1 ]; then
  read -r -p "Android SDK 路径 [$SDK]: " __sdk || true
  SDK="${__sdk:-$SDK}"
  BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
  [ -n "$BUILD_TOOLS" ] || BUILD_TOOLS="$SDK/build-tools/34.0.0"
  PLATFORM="$SDK/platforms/android-34/android.jar"
fi
for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS/$tool" ]; then
    echo "missing $BUILD_TOOLS/$tool" >&2
    echo "install build-tools 34.0.0 or set --sdk / ANDROID_HOME" >&2
    exit 1
  fi
done
[ -f "$PLATFORM" ] || { echo "missing $PLATFORM" >&2; exit 1; }
command -v javac >/dev/null || { echo "javac not found" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip not found" >&2; exit 1; }
case "$(basename "$BUILD_TOOLS")" in
  34*)
    if [ -n "$JAVAC_MAJOR" ] && [ "$JAVAC_MAJOR" -ge 21 ] 2>/dev/null; then
      echo "warning: build-tools 34 d8 can NPE on JDK 21 bytecode; install build-tools 35+ (sdkmanager "build-tools;35.0.1") and rerun" >&2
    fi
    ;;
esac

# --- web assets -----------------------------------------------------------------
if [ "$BUILD_WEB" = "ask" ]; then
  if [ ! -f "$ROOT/dist/index.html" ]; then
    BUILD_WEB="yes"
  elif [ "$IS_TTY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
    ask_yes_no BUILD_WEB "先重新构建网页资源 (pnpm build)? (y/N)" "n"
  else
    BUILD_WEB="no"
  fi
fi
if [ "$BUILD_WEB" = "yes" ]; then
  say "pnpm build"
  (cd "$ROOT" && pnpm build)
fi
[ -f "$ROOT/dist/index.html" ] || { echo "missing $ROOT/dist/index.html; run pnpm build" >&2; exit 1; }

# --- install? -------------------------------------------------------------------
if [ "$DO_INSTALL" = "ask" ]; then
  if [ "$IS_TTY" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ]; then
    ask_yes_no DO_INSTALL "构建完成后安装到已连接的设备? (y/N)" "n"
  else
    DO_INSTALL="no"
  fi
fi

# --- summary --------------------------------------------------------------------
echo
echo "  version : $VERSION_NAME ($VERSION_CODE)"
echo "  keystore: $KEYSTORE ($KEY_ALIAS)"
echo "  sdk     : $SDK"
echo "  jdk     : ${JAVA_HOME:-$(command -v javac)}"
echo "  web     : $([ "$BUILD_WEB" = "yes" ] && echo "rebuild with pnpm build" || echo "existing dist")"
echo "  output  : $OUT"
echo "  install : $DO_INSTALL"
if [ "$ASSUME_YES" -eq 0 ] && [ "$IS_TTY" -eq 1 ]; then
  read -r -p "开始构建? [Y/n] " __go || true
  case "${__go:-y}" in
    n|N|no|NO) echo "cancelled"; exit 0 ;;
  esac
fi

# --- build ----------------------------------------------------------------------
START=$SECONDS
rm -rf "$HERE/assets/public" "$HERE/build"
mkdir -p "$HERE/assets/public" "$HERE/build/gen" "$HERE/build/classes" "$HERE/build/dex"
cp -a "$ROOT/dist/." "$HERE/assets/public/"

say "aapt2 compile/link"
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

say "javac"
javac -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$PLATFORM" \
  -d "$HERE/build/classes" \
  "$HERE/build/gen/com/xiaohuangbo/deepseekunrestricted/R.java" \
  "$HERE/src/com/xiaohuangbo/deepseekunrestricted/MainActivity.java" \
  "$HERE/src/com/xiaohuangbo/deepseekunrestricted/LocalServer.java" \
  "$HERE/src/com/xiaohuangbo/deepseekunrestricted/PhotoProvider.java"

say "d8"
find "$HERE/build/classes" -name '*.class' -print > "$HERE/build/classes.list"
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 24 --output "$HERE/build/dex" @"$HERE/build/classes.list"

cp "$HERE/build/unsigned.apk" "$HERE/build/with-dex.apk"
(cd "$HERE/build/dex" && zip -q -j ../with-dex.apk classes.dex)

say "zipalign + apksigner"
"$BUILD_TOOLS/zipalign" -p -f 4 "$HERE/build/with-dex.apk" "$HERE/build/aligned.apk"
rm -f "$OUT" "$OUT.idsig"
export KS_PASS KEY_PASS
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "env:KS_PASS" \
  --key-pass "env:KEY_PASS" \
  --out "$OUT" \
  "$HERE/build/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT"
"$BUILD_TOOLS/aapt2" dump badging "$OUT" | sed -n '1,4p'

SIZE="$(du -h "$OUT" | cut -f1)"
HASH="$(sha256sum "$OUT" | cut -d' ' -f1)"
say "done in $((SECONDS - START))s"
echo "APK : $OUT"
echo "size: $SIZE"
echo "sha256: $HASH"

# --- optional install -----------------------------------------------------------
if [ "$DO_INSTALL" = "yes" ]; then
  if ! command -v adb >/dev/null; then
    echo "adb not found; cannot install" >&2
    exit 1
  fi
  mapfile -t DEVICES < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if [ "${#DEVICES[@]}" -eq 0 ]; then
    echo "no adb device connected; APK left at $OUT" >&2
    exit 1
  fi
  SERIAL="${ANDROID_SERIAL:-${DEVICES[0]}}"
  if [ "${#DEVICES[@]}" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
    echo "multiple devices, using $SERIAL (set ANDROID_SERIAL to choose)" >&2
  fi
  say "adb install -r ($SERIAL)"
  adb -s "$SERIAL" install -r "$OUT"
fi
