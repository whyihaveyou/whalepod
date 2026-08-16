#!/bin/bash
# =============================================================================
# make-dmg.sh — 把 dist/HarnessShell.app 打成可分发 .dmg（hdiutil，纯命令行）
#
# 流程：
#   1) 构建临时目录 staging：放入 HarnessShell.app + /Applications 软链
#   2) hdiutil create -format UDZO（压缩只读镜像）
#   3) 可选：对 dmg 签名（SIGN_IDENTITY 非 "-" 时）+ 打印公证/stapler 提示
#
# 产物：dist/HarnessShell.dmg（内附 /Applications 软链，拖拽即安装）
#
# 环境变量：
#   APP_NAME     默认 HarnessShell
#   DIST_DIR     默认 dist
#   DMG_NAME     输出文件名，默认 "$APP_NAME.dmg"（传 WhalePod-<ver>-macos-<arch>.dmg 可品牌化）
#   VOLUME_NAME  挂载卷名，默认 "WhalePod"
#   SIGN_IDENTITY dmg 签名身份；默认 "-"（ad-hoc，跳过对 dmg 的额外签名）
#   STAGING_TMP  调试用：保留临时目录（默认清理）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="${APP_NAME:-HarnessShell}"
DIST_DIR="${DIST_DIR:-dist}"
DMG_NAME="${DMG_NAME:-$APP_NAME.dmg}"
VOLUME_NAME="${VOLUME_NAME:-WhalePod}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
STAGING_TMP="${STAGING_TMP:-0}"

APP="$DIST_DIR/$APP_NAME.app"
DMG="$DIST_DIR/$DMG_NAME"

[ -d "$APP" ] || { echo "!! 缺少 $APP，请先运行 Scripts/build-app.sh"; exit 1; }

STAGING="$(mktemp -d /tmp/dsh-dmg.XXXXXX)"
[ "$STAGING_TMP" = "1" ] && echo "==> 临时目录（保留）: $STAGING"
trap '[ "$STAGING_TMP" = "1" ] || rm -rf "$STAGING"' EXIT

# ---- 1) staging -----------------------------------------------------------
echo "==> 组装 staging ..."
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

# ---- 2) 制作镜像 ----------------------------------------------------------
echo "==> hdiutil create -volname '$VOLUME_NAME' ..."
rm -f "$DMG"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG" >/dev/null

# ---- 3) 签名（仅当明确给了 Developer ID 身份时）----------------------------
if [ "$SIGN_IDENTITY" != "-" ]; then
  echo "==> codesign --sign '$SIGN_IDENTITY' $DMG"
  codesign --force --sign "$SIGN_IDENTITY" "$DMG"
else
  echo "==> dmg 签名：跳过（ad-hoc 分发无需对 dmg 签名；产品化请设 SIGN_IDENTITY=Developer ID Application: ...）"
fi

echo ""
echo "✅ DMG 完成：$DMG ($(du -h "$DMG" | cut -f1))"
echo "   校验镜像：hdiutil verify $DMG"
echo "   公证/stapler 提示：详见 docs/distribution.md"
