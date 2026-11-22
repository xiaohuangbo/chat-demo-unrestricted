#!/usr/bin/env bash
# 一键构建并签名 Android APK。
#
# 用法：
#   KS_PASS=你的签名口令 ./构建APK.sh
#
# 可选环境变量：
#   JDK_HOME     JDK 21/17 根目录（默认自动探测 /tmp/jdk21、/tmp/jdk17、~/.jdks、/usr/lib/jvm）
#   ANDROID_HOME Android SDK（默认 ~/android-sdk）
#   KEYSTORE     签名文件（默认 ~/桌面/xiaohuangbo.jks）
#   KEY_ALIAS    签名别名（默认 xiaohuangbo）
#   KEY_PASS     私钥口令（默认与 KS_PASS 相同）
#   VERSION_NAME 版本名（默认读 package.json，版本号保持不变）
#   VERSION_CODE 版本代码（默认按 主*100 + 次*10 + 修订 计算）
#
# 脚本不写死签名口令；非交互环境请用 KS_PASS 传入。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION_NAME="${VERSION_NAME:-$(node -p "require('./package.json').version")}"
IFS=. read -r MAJOR MINOR PATCH <<< "$VERSION_NAME"
MINOR="${MINOR:-0}"
PATCH="${PATCH:-0}"
VERSION_CODE="${VERSION_CODE:-$((10#$MAJOR * 100 + 10#$MINOR * 10 + 10#$PATCH))}"

ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
KEYSTORE="${KEYSTORE:-$HOME/桌面/xiaohuangbo.jks}"
KEY_ALIAS="${KEY_ALIAS:-xiaohuangbo}"

find_jdk() {
  local candidates=()
  [ -n "${JDK_HOME:-}" ] && candidates+=("$JDK_HOME")
  [ -n "${JDK17_HOME:-}" ] && candidates+=("$JDK17_HOME")
  [ -n "${JAVA_HOME:-}" ] && candidates+=("$JAVA_HOME")
  candidates+=("/tmp/jdk21" "/tmp/jdk17")
  for dir in "$HOME/.jdks"/* "$HOME/.sdkman/candidates/java"/* /usr/lib/jvm/*; do
    [ -d "$dir" ] && candidates+=("$dir")
  done
  for dir in "${candidates[@]}"; do
    [ -x "$dir/bin/javac" ] || continue
    if "$dir/bin/javac" -version 2>&1 | head -n 1 | grep -Eq 'javac (17|21)\.'; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  return 1
}

JAVA_HOME_FOUND="$(find_jdk || true)"
if [ -z "$JAVA_HOME_FOUND" ]; then
  echo "未找到 JDK 21/17。请安装 JDK 21 或 17，并设置 JDK_HOME=/path/to/jdk。" >&2
  echo "示例：JDK_HOME=/usr/lib/jvm/java-21-openjdk KS_PASS=... ./构建APK.sh" >&2
  exit 1
fi
export JAVA_HOME="$JAVA_HOME_FOUND"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME

if [ ! -d "$ANDROID_HOME/platforms/android-34" ]; then
  echo "Android SDK platform 34 不完整：$ANDROID_HOME" >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/build-tools" ]; then
  echo "Android build-tools 不完整：$ANDROID_HOME/build-tools" >&2
  exit 1
fi
if [ ! -f "$KEYSTORE" ]; then
  echo "找不到签名文件：$KEYSTORE" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "找不到 pnpm，请先安装依赖（pnpm install）。" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "缺少 node_modules，请先执行 pnpm install。" >&2
  exit 1
fi

if [ -z "${KS_PASS:-}" ]; then
  if [ -t 0 ]; then
    read -rsp "签名口令（$KEYSTORE）：" KS_PASS
    echo
  else
    echo "非交互环境需要通过 KS_PASS 提供签名口令。" >&2
    exit 1
  fi
fi
export KS_PASS
export KEY_PASS="${KEY_PASS:-$KS_PASS}"
export KEY_ALIAS KEYSTORE

echo "==> JDK: $JAVA_HOME"
echo "==> Android SDK: $ANDROID_HOME"
echo "==> 版本: $VERSION_NAME (versionCode $VERSION_CODE)"
echo "==> 构建 Web 资源"
pnpm build

echo "==> 构建并签名 APK"
VERSION_NAME="$VERSION_NAME" VERSION_CODE="$VERSION_CODE" ./android/build-apk.sh --yes --no-build-web

OUT="android/deepseek-unrestricted-$VERSION_NAME.apk"
if [ ! -f "$OUT" ]; then
  echo "构建结束但没有找到 $OUT" >&2
  exit 1
fi
cp "$OUT" "deepseek-unrestricted-$VERSION_NAME.apk"

echo
echo "==> 完成"
ls -lh "$OUT" "deepseek-unrestricted-$VERSION_NAME.apk"
sha256sum "deepseek-unrestricted-$VERSION_NAME.apk"
