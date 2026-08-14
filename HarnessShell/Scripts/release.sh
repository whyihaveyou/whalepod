#!/bin/bash
# =============================================================================
# release.sh — 一键发布：图标 → 构建 .app → 签名 → DMG/ZIP
#
# 用法：
#   ./release.sh               # ad-hoc + DMG（个人本地使用）
#   ./release.sh --zip         # ad-hoc + ZIP
#   ./release.sh --devid       # 产品化：Developer ID 签名 .app + DMG（公证需在 Xcode 环境另跑 sign.sh devid --dmg）
#   ./release.sh --pkg         # 产品化：.app + .pkg 安装器
#
# 详细档位说明见 docs/distribution.md
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-dmg}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
APP_NAME="${APP_NAME:-HarnessShell}"

case "$MODE" in
  dmg|zip)
    SIGN_IDENTITY="-" ;;
  devid)
    SIGN_IDENTITY="${DEV_ID:-Developer ID Application: YOUR_NAME (TEAMID)}" ;;
  pkg)
    SIGN_IDENTITY="${DEV_ID:-Developer ID Application: YOUR_NAME (TEAMID)}" ;;
  *)
    echo "用法: $0 {dmg|zip|devid|pkg}"; exit 1 ;;
esac

echo "########## [1/3] 图标（如缺） ##########"
[ -f Resources/AppIcon.icns ] || Scripts/make-icns.sh

echo "########## [2/3] 构建并签名 .app ##########"
SIGN_IDENTITY="$SIGN_IDENTITY" Scripts/build-app.sh

echo "########## [3/3] 分发物 ##########"
case "$MODE" in
  dmg)
    SIGN_IDENTITY="$SIGN_IDENTITY" Scripts/make-dmg.sh ;;
  zip)
    Scripts/make-zip.sh ;;
  devid|pkg)
    # .app 已带 Developer ID 签名；生成 DMG（未公证）
    SIGN_IDENTITY="$SIGN_IDENTITY" Scripts/make-dmg.sh
    echo "==> 下一步（需证书 + Xcode 环境）："
    echo "    Scripts/sign.sh devid --dmg   # 公证 DMG"
    if [ "$MODE" = "pkg" ]; then
      echo "    Scripts/sign.sh pkg           # 打 .pkg 安装器并公证"
    fi
    ;;
esac

echo ""
echo "✅ 全部完成。产物见 dist/"
ls -lh dist/ 2>/dev/null | tail -n +2
