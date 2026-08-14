#!/bin/bash
# =============================================================================
# sign.sh — 三档签名/分发脚本
#
#   ./sign.sh ad-hoc          # 档位 1：个人本地使用（ad-hoc，无证书）
#   ./sign.sh devid [--dmg]   # 档位 2：产品化分发（Developer ID + 公证 DMG）
#   ./sign.sh pkg             # 档位 3：安装器 .pkg（Developer ID Installer + 公证）
#
# 环境变量：
#   APP_NAME          默认 HarnessShell
#   DIST_DIR          默认 dist
#   DEV_ID            开发者 ID 应用证书："Developer ID Application: 你的名字 (TEAMID)"
#   DEV_ID_INSTALLER  开发者 ID 安装证书："Developer ID Installer: 你的名字 (TEAMID)"
#   NOTARY_PROFILE    notarytool keychain profile 名（先在装有 Xcode 的机器上：
#                     xcrun notarytool store-credentials PROFILE --apple-id ... --team-id ... --password ...）
#
# 注意：
#   * ad-hoc 档在本机（仅有 Command Line Tools）可直接运行。
#   * devid/pkg 档需要 Developer ID 证书；notarytool/stapler 需要装有 Xcode 的环境
#     （本机无完整 Xcode 时，可在 macOS CI 如 GitHub Actions 上执行本脚本）。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="${APP_NAME:-HarnessShell}"
DIST_DIR="${DIST_DIR:-dist}"
DEV_ID="${DEV_ID:-Developer ID Application: YOUR_NAME (TEAMID)}"
DEV_ID_INSTALLER="${DEV_ID_INSTALLER:-Developer ID Installer: YOUR_NAME (TEAMID)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-dfh-notary}"

APP="$DIST_DIR/$APP_NAME.app"
DMG="$DIST_DIR/$APP_NAME.dmg"
PKG="$DIST_DIR/$APP_NAME.pkg"

MODE="${1:-ad-hoc}"
[ -d "$APP" ] || { echo "!! 缺少 $APP，请先运行 Scripts/build-app.sh"; exit 1; }

has_notarytool() { command -v notarytool >/dev/null 2>&1 || xcrun --find notarytool >/dev/null 2>&1; }

case "$MODE" in
  # --------------------------------------------------------------------------
  # 档位 1：ad-hoc（个人顺手工具，本机可直接跑）
  # --------------------------------------------------------------------------
  ad-hoc)
    echo "==> [档位1/ad-hoc] 对 .app 做 ad-hoc 签名（去时间戳，无需网络）"
    codesign --force --sign - --timestamp=none "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    echo "✅ 完成。首次运行提示'无法验证开发者'时：右键->打开 或 执行:"
    echo "   sudo xattr -dr com.apple.quarantine \"$APP\""
    ;;

  # --------------------------------------------------------------------------
  # 档位 2：Developer ID + 公证（产品化分发 .app / .dmg）
  # --------------------------------------------------------------------------
  devid)
    if [ "$DEV_ID" = "Developer ID Application: YOUR_NAME (TEAMID)" ]; then
      echo "!! 请先设置 DEV_ID 环境变量（Developer ID Application 证书名）"; exit 1
    fi
    echo "==> [档位2/DeveloperID] codesign .app（hardened runtime + timestamp）"
    codesign --force --options runtime --timestamp --sign "$DEV_ID" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"

    if [ "${2:-}" = "--dmg" ]; then
      [ -f "$DMG" ] || { echo "!! 缺少 $DMG，请先运行 Scripts/make-dmg.sh SIGN_IDENTITY=\"$DEV_ID\""; exit 1; }
      echo "==> 公证 DMG ..."
      has_notarytool || { echo "!! 本机无 notarytool（需要 Xcode）。公证命令如下，请在装有 Xcode 的机器/CI 上执行:"; echo "   xcrun notarytool submit \"$DMG\" --keychain-profile \"$NOTARY_PROFILE\" --wait"; echo "   xcrun stapler staple \"$DMG\""; exit 2; }
      xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
      xcrun stapler staple "$DMG"
      echo "✅ 公证完成：$DMG"
    else
      echo "==> 公证 .app（zip 提交）..."
      has_notarytool || { echo "!! 本机无 notarytool（需要 Xcode）。公证命令如下，请在装有 Xcode 的机器/CI 上执行:"; echo "   ditto -c -k --keepParent \"$APP\" /tmp/$APP_NAME-notarize.zip"; echo "   xcrun notarytool submit /tmp/$APP_NAME-notarize.zip --keychain-profile \"$NOTARY_PROFILE\" --wait"; echo "   xcrun stapler staple \"$APP\""; exit 2; }
      TMPZIP="$(mktemp -d)/notarize.zip"
      ditto -c -k --keepParent "$APP" "$TMPZIP"
      xcrun notarytool submit "$TMPZIP" --keychain-profile "$NOTARY_PROFILE" --wait
      xcrun stapler staple "$APP"
      echo "✅ 公证完成：$APP"
    fi
    ;;

  # --------------------------------------------------------------------------
  # 档位 3：安装器 .pkg（Developer ID Installer + 公证）
  # --------------------------------------------------------------------------
  pkg)
    if [ "$DEV_ID_INSTALLER" = "Developer ID Installer: YOUR_NAME (TEAMID)" ]; then
      echo "!! 请先设置 DEV_ID_INSTALLER 环境变量（Developer ID Installer 证书名）"; exit 1
    fi
    [ -d "$APP" ] || { echo "!! 缺少 $APP，请先运行 Scripts/build-app.sh"; exit 1; }
    echo "==> [档位3/pkg] pkgbuild --component ... --install-location /Applications"
    pkgbuild \
      --component "$APP" \
      --install-location /Applications \
      --version "${VERSION:-0.1.0}" \
      --sign "$DEV_ID_INSTALLER" \
      "$PKG"

    echo "==> 公证 pkg ..."
    has_notarytool || { echo "!! 本机无 notarytool（需要 Xcode）。公证命令如下，请在装有 Xcode 的机器/CI 上执行:"; echo "   xcrun notarytool submit \"$PKG\" --keychain-profile \"$NOTARY_PROFILE\" --wait"; echo "   xcrun stapler staple \"$PKG\""; exit 2; }
    xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$PKG"
    echo "✅ 公证完成：$PKG"
    ;;

  *)
    echo "用法: $0 {ad-hoc|devid [--dmg]|pkg}"
    exit 1
    ;;
esac
