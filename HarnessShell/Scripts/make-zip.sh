#!/bin/bash
# =============================================================================
# make-zip.sh — zip 备选分发格式（无 DMG 需求时用）
# 产物：dist/${ZIP_NAME:-$APP_NAME}.zip（保留可执行位与软链）
# 可选 ZIP_NAME 覆盖文件名（make-slim.sh 用于产出 WhalePod-<ver>-macos-<arch>-slim.zip）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="${APP_NAME:-HarnessShell}"
DIST_DIR="${DIST_DIR:-dist}"

APP="$DIST_DIR/$APP_NAME.app"
ZIP="$DIST_DIR/${ZIP_NAME:-$APP_NAME.zip}"

[ -d "$APP" ] || { echo "❌ 找不到 $APP（先跑 build-app.sh）"; exit 1; }

rm -f "$ZIP"
# -y : 保留符号链接；-X : 去扩展属性
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "✅ ZIP 完成：$ZIP ($(du -h "$ZIP" | cut -f1))"
echo "   解压即用；若走产品化分发请配合签名后打包。"
