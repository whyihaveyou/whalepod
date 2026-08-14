#!/bin/bash
# =============================================================================
# make-zip.sh — zip 备选分发格式（无 DMG 需求时用）
# 产物：dist/HarnessShell.zip（保留可执行位与软链）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="${APP_NAME:-HarnessShell}"
DIST_DIR="${DIST_DIR:-dist}"

APP="$DIST_DIR/$APP_NAME.app"
ZIP="$DIST_DIR/$APP_NAME.zip"

[ -d "$APP" ] || { echo "!! 缺少 $APP，请先运行 Scripts/build-app.sh"; exit 1; }

rm -f "$ZIP"
# -y : 保留符号链接；-X : 去扩展属性
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "✅ ZIP 完成：$ZIP ($(du -h "$ZIP" | cut -f1))"
echo "   解压即用；若走产品化分发请配合签名后打包。"
