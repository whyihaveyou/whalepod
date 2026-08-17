#!/bin/bash
# =============================================================================
# make-slim.sh — 生成 Slim 轻量版 zip（不内嵌 node + dsh，命中 npxFallback 探测链）
#
# 依据：docs/version-tiers.md（版本分档）
#   Slim = build-app.sh（【不跑】build-runtime.sh，因此 .app 里无 Resources/node 与
#          node_modules）→ 签名 → make-zip.sh 产出 WhalePod-<ver>-macos-arm64-slim.zip
#   RuntimeBootstrap 探测链：bundled 缺失 → 本机 node 探测 → npxFallback / unavailable，
#   对 Slim 自然命中（有系统 node 走 npx；无 node 走 unavailable 引导文案）。
#
# 参数风格与 build-app.sh / make-zip.sh / make-dmg.sh 一致：
#   APP_NAME    应用名          默认 HarnessShell
#   VERSION     版本号          默认 0.1.0（zip 文件名用）
#   ARCH        CPU 架构        默认 arm64
#   DIST_DIR    输出目录        默认 dist
#   SIGN_IDENTITY codesign 身份 默认 "-"（ad-hoc）——透传给 build-app.sh
#
# 产物：dist/WhalePod-<VERSION>-macos-<ARCH>-slim.zip
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_NAME="${APP_NAME:-HarnessShell}"
VERSION="${VERSION:-0.1.0}"
ARCH="${ARCH:-arm64}"
DIST_DIR="${DIST_DIR:-dist}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"

echo "==> [Slim] 1/3 build-app.sh（不跑 build-runtime.sh → .app 不带 bundled node/dsh）"
# build-app.sh 内部已做 swift 编译 + ad-hoc 签名 + codesign --verify（各参数走环境变量）
# 必须透传 ARCH（与 zip 文件名一致）+ SCRATCH_PATH（交叉构建隔离，避免拷错宿主产物）
APP_NAME="$APP_NAME" VERSION="$VERSION" BUILD_NUMBER="$BUILD_NUMBER" DIST_DIR="$DIST_DIR" SIGN_IDENTITY="$SIGN_IDENTITY" \
  ARCH="$ARCH" SCRATCH_PATH="${SCRATCH_PATH:-}" RUNTIME_BUNDLE=0 \
  "$ROOT/Scripts/build-app.sh"

APP="$DIST_DIR/$APP_NAME.app"

echo "==> [Slim] 2/3 codesign 确认（ad-hoc / 指定身份）"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> [Slim] 3/3 make-zip.sh → 版本化 slim zip"
ZIP_NAME="WhalePod-${VERSION}-macos-${ARCH}-slim.zip"
APP_NAME="$APP_NAME" DIST_DIR="$DIST_DIR" ZIP_NAME="$ZIP_NAME" \
  "$ROOT/Scripts/make-zip.sh"

ZIP="$DIST_DIR/$ZIP_NAME"

echo ""
echo "✅ Slim 产出：$ZIP"
echo "   体积：$(du -h "$ZIP" | cut -f1)  $(du -m "$ZIP" | cut -f1) MB"
echo "   SHA-256：$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
echo ""
echo "   （Slim 命中 RuntimeBootstrap：无 bundled → 本机 node → npx；无 node → unavailable 引导)"
