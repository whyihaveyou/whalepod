#!/bin/bash
# =============================================================================
# build-app.sh — 组装可双击运行的 HarnessShell.app（纯命令行，无完整 Xcode）
#
# 流程：
#   1) swift build -c release            （SwiftPM 编译可执行文件）
#   2) 手工组装 .app bundle 目录结构      （Contents/MacOS + Resources + Info.plist）
#   3) 挂载 AppIcon.icns（由 make-icns.sh 从 design/assets 生成）
#   4) codesign 签名（默认 ad-hoc，可用 SIGN_IDENTITY 指定 Developer ID）
#   5) codesign --verify 校验
#
# 产物：dist/HarnessShell.app
#
# 环境变量（均可覆盖）：
#   APP_NAME        应用名/可执行名       默认 HarnessShell
#   BUNDLE_ID       Bundle Identifier     默认 io.whalepod.desktop
#   VERSION         CFBundleShortVersionString  默认 0.1.0
#   BUILD_NUMBER    CFBundleVersion       默认 1
#   DEPLOY_TARGET   LSMinimumSystemVersion 默认 13.0
#   SIGN_IDENTITY   codesign 身份          默认 "-"（ad-hoc）；产品化填 "Developer ID Application: ..."
#   SIGN_OPTIONS    附加签名选项           默认 ""；产品化建议 "--options runtime --timestamp"
#   DIST_DIR        输出目录               默认 dist
#   KEEP_BUILD      是否复用 .build（跳过重新编译）默认 0（不跳过）
#   ARCH            架构（swift --arch 命名：x86_64 / arm64）默认$(uname -m)（宿主）
#                   交叉构建示例：ARCH=x86_64 ./Scripts/build-app.sh
#   SCRATCH_PATH    隔离编译缓存（跨架构并存时建议设，避免 .build/release 指针互踩）默认空
#   RUNTIME_BUNDLE  1=装箱运行时（node+dsh+honeycomb+内置 dsh_home seed）默认 1；0=纯壳（Slim/调试）
#   HONEYCOMB_TARBALL 指定 honeycomb tarball（默认自动 npm pack 或复用 /tmp/honeycomb-pack）
#   HONEYCOMB_PACK_DIR npm pack 输出目录 默认 /tmp/honeycomb-pack
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---- 可配置项 -------------------------------------------------------------
APP_NAME="${APP_NAME:-HarnessShell}"
BUNDLE_ID="${BUNDLE_ID:-io.whalepod.desktop}"
VERSION="${VERSION:-0.1.0}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
DEPLOY_TARGET="${DEPLOY_TARGET:-13.0}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_OPTIONS="${SIGN_OPTIONS:-}"
DIST_DIR="${DIST_DIR:-dist}"
KEEP_BUILD="${KEEP_BUILD:-0}"
ARCH="${ARCH:-$(uname -m)}"
SCRATCH_PATH="${SCRATCH_PATH:-}"
RUNTIME_BUNDLE="${RUNTIME_BUNDLE:-1}"
HONEYCOMB_PACK_DIR="${HONEYCOMB_PACK_DIR:-/tmp/honeycomb-pack}"

PLIST_TEMPLATE="Sources/HarnessShell/Info.plist"
ICON_ICNS="Resources/AppIcon.icns"

echo "==> 配置：APP_NAME=$APP_NAME BUNDLE_ID=$BUNDLE_ID VERSION=$VERSION SIGN_IDENTITY=$SIGN_IDENTITY ARCH=$ARCH"

# ---- 1) 编译 --------------------------------------------------------------
if [ "$KEEP_BUILD" = "1" ]; then
  echo "==> 跳过编译（KEEP_BUILD=1），使用现有 .build/release/$APP_NAME"
else
  echo "==> swift build -c release --arch $ARCH ..."
  if [ -n "$SCRATCH_PATH" ]; then
    swift build -c release --product "$APP_NAME" --arch "$ARCH" --scratch-path "$SCRATCH_PATH"
  else
    swift build -c release --product "$APP_NAME" --arch "$ARCH"
  fi
fi
# swift build --arch 后 .build/release 会指向最后构建的三元组；设置了 SCRATCH_PATH 时必须从 scratch 取，
# 否则相对路径 .build/release 会落回宿主（arm64）产物 → 声言交叉实拷错库。
if [ -n "$SCRATCH_PATH" ]; then
  BIN="$SCRATCH_PATH/release/$APP_NAME"
else
  BIN=".build/release/$APP_NAME"
fi
[ -x "$BIN" ] || { echo "!! 找不到可执行文件 $BIN"; exit 1; }
echo "==> 可执行文件就绪: $BIN ($(du -h "$BIN" | cut -f1))"

# ---- 2) 组装 .app ---------------------------------------------------------
APP="$DIST_DIR/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"

# Info.plist：模板变量替换（模板里是 $(...) 占位符，替换为实际值）
sed -e "s/\$(EXECUTABLE_NAME)/$APP_NAME/g" \
    -e "s/\$(PRODUCT_NAME)/$APP_NAME/g" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$BUNDLE_ID/g" \
    -e "s/\$(MACOSX_DEPLOYMENT_TARGET)/$DEPLOY_TARGET/g" \
    "$PLIST_TEMPLATE" > "$APP/Contents/Info.plist"

# 用 PlistBuddy 补齐打包必需的键（模板中没有的）
PB="/usr/libexec/PlistBuddy"
[ -f "$ICON_ICNS" ] || { echo "!! 缺少图标 $ICON_ICNS，先运行 Scripts/make-icns.sh"; exit 1; }
cp "$ICON_ICNS" "$APP/Contents/Resources/AppIcon.icns"
$PB -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist" 2>/dev/null || \
  $PB -c "Set :CFBundleIconFile AppIcon" "$APP/Contents/Info.plist"
$PB -c "Add :CFBundleDisplayName string $APP_NAME" "$APP/Contents/Info.plist" 2>/dev/null || true
$PB -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"

# plist 语法自检
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "==> .app 组装完成: $APP"

# ---- 3) 运行时装箱（OOB-1：node + dsh + honeycomb 同事务 + 内置 dsh_home seed）----
if [ "$RUNTIME_BUNDLE" = "1" ]; then
  echo "==> [OOB-1] RUNTIME_BUNDLE=1：装箱 node + dsh + honeycomb + dsh_home seed"

  # 3a. honeycomb tarball：显式 HONEYCOMB_TARBALL > 已 pack 产物 > npm pack 现产
  if [ -n "${HONEYCOMB_TARBALL:-}" ]; then
    [ -f "$HONEYCOMB_TARBALL" ] || { echo "!! HONEYCOMB_TARBALL 不存在: $HONEYCOMB_TARBALL"; exit 1; }
    echo "==> 使用指定 HONEYCOMB_TARBALL=$HONEYCOMB_TARBALL"
  else
    mkdir -p "$HONEYCOMB_PACK_DIR"
    HONEYCOMB_TARBALL="$HONEYCOMB_PACK_DIR/whalepod-honeycomb-0.1.0.tgz"
    if [ ! -f "$HONEYCOMB_TARBALL" ]; then
      echo "==> npm pack @whalepod/honeycomb → $HONEYCOMB_PACK_DIR/"
      (cd "$REPO_ROOT/packages/honeycomb" && npm pack --pack-destination "$HONEYCOMB_PACK_DIR")
    else
      echo "==> 复用已有 pack 产物: $HONEYCOMB_TARBALL"
    fi
    [ -f "$HONEYCOMB_TARBALL" ] || { echo "!! honeycomb tarball 未产出: $HONEYCOMB_TARBALL"; exit 1; }
  fi

  # 3b. build-runtime.sh：node + dsh + honeycomb 同事务 npm install（内含 cordis 单实例断言 + ESM 冒烟）
  HONEYCOMB_TARBALL="$HONEYCOMB_TARBALL" APP_PATH="$APP" "$ROOT/Scripts/build-runtime.sh"

  # 3c. 内置 DSH_HOME 预置 seed（打包期，零 Swift）：
  #     dsh --dump-config 自举建 profile 结构（initProfile + heal 共享层），
  #     然后 profile-seed 写 V2 共享层相对链接 + V3 cordis.patch.yml insert 块。
  BUNDLED_HOME="$APP/Contents/Resources/dsh_home"
  BUNDLED_NODE="$APP/Contents/Resources/node/bin/node"
  BUNDLED_BIN="$APP/Contents/Resources/node_modules/@deepseek-ai/dsh/lib/bin.js"
  echo "==> [OOB-1] 内置 DSH_HOME 预置: $BUNDLED_HOME"
  mkdir -p "$BUNDLED_HOME"
  DSH_HOME="$BUNDLED_HOME" "$BUNDLED_NODE" "$BUNDLED_BIN" --profile web --dump-config >/dev/null 2>&1
  "$ROOT/Scripts/profile-seed-honeycomb.sh" --apply --dsh-home "$BUNDLED_HOME" \
    --src "$APP/Contents/Resources/node_modules/@whalepod/honeycomb" --rel-src

  # 3d. 验证：dump-config 合成 patch 含 honeycomb 条目（守门判据 10 的配套断言）
  if DSH_HOME="$BUNDLED_HOME" "$BUNDLED_NODE" "$BUNDLED_BIN" --profile web --dump-config 2>/dev/null \
       | grep -q "honeycomb"; then
    echo "    ✅ 内置 dsh_home dump-config 合成含 honeycomb 条目"
  else
    echo "    ❌ 内置 dsh_home dump-config 未见 honeycomb 条目"; exit 1
  fi
else
  echo "==> RUNTIME_BUNDLE=0：跳过运行时装箱（纯壳，Slim/调试用）"
fi

# ---- 4) 签名 --------------------------------------------------------------
echo "==> codesign --force --sign '$SIGN_IDENTITY' $SIGN_OPTIONS $APP"
# shellcheck disable=SC2086
codesign --force --sign "$SIGN_IDENTITY" $SIGN_OPTIONS "$APP"

# ---- 5) 校验 --------------------------------------------------------------
echo "==> codesign --verify --deep --strict --verbose=2 $APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|TeamIdentifier|Signature|CodeDirectory" || true

echo ""
echo "✅ 打包完成：$APP"
echo "   双击即可运行；或执行: open \"$APP\""
