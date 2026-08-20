#!/bin/bash
# =============================================================================
# make-appcast.sh — 生成 / 维护 Sparkle 2 兼容的 appcast.xml
#
# 设计要点：
#   1. 每条 release = 一个 <item>，含两条 <enclosure>（Full DMG + Slim ZIP）
#      —— 同一 build 号对应同一发版的两份产物。Swift M1 端按 channel 拉取时
#      自动按自己装的版本/可用网络选合适 enclosure（见 docs/auto-update-proposal.md §4.1）
#   2. <sparkle:version> = BUILD_NUMBER（整型，单调，主排序键；Sparkle 按它判断是否升级）
#   3. <sparkle:shortVersionString> = VERSION（如 "0.1.0-alpha.3"，用户可见版本号）
#   4. enclosure 用 length + 自定义 edSignature（sha256）作完整性约束
#   5. 维护语义：每次发版替换 build 号 == BUILD_NUMBER 的旧 item（去重），
#      其余 item 全部保留（历史可追溯）
#
# 简化版对比：
#   - 当前实现：1 item × 2 enclosure（Full + Slim），与 §4.3 一致
#   - 「先 Full 一条」更简化，但会让 Slim 用户被指向 DMG 200+MB，不友好，故不采用
#
# 产物路径：$APPCAST_PATH（默认 $DIST_DIR/appcast.xml）
# CI 钩子：release.yml 末尾 `gh release upload --clobber appcast.xml`
# 消费端：Swift M1 按 $GITHUB_RELEASES/latest/download/appcast.xml 拉取
#        （需要 release 已 publish；draft 状态下 latest/download 落到上一条）
# =============================================================================
set -euo pipefail

# ---- 入参（必传；未传即退出） -------------------------------------------
: "${VERSION:?need VERSION (e.g. 0.1.0-alpha.3)}"
: "${BUILD_NUMBER:?need BUILD_NUMBER (e.g. 3)}"
: "${FULL_DMG:?need FULL_DMG (filename in dist/, e.g. WhalePod-0.1.0-alpha.3-macos-arm64.dmg)}"
: "${SLIM_ZIP:?need SLIM_ZIP (filename in dist/, e.g. WhalePod-0.1.0-alpha.3-macos-arm64-slim.zip)}"
: "${DIST_DIR:=dist}"
: "${APPCAST_PATH:=$DIST_DIR/appcast.xml}"

# ---- 校验产物文件存在 ---------------------------------------------------
[ -f "$DIST_DIR/$FULL_DMG" ] || { echo "!! 缺 Full DMG: $DIST_DIR/$FULL_DMG"; exit 1; }
[ -f "$DIST_DIR/$SLIM_ZIP" ] || { echo "!! 缺 Slim ZIP: $DIST_DIR/$SLIM_ZIP"; exit 1; }

# ---- 计算 sha256 + length ----------------------------------------------
FULL_SHA=$(shasum -a 256 "$DIST_DIR/$FULL_DMG" | awk '{print $1}')
FULL_LEN=$(stat -f%z "$DIST_DIR/$FULL_DMG")
SLIM_SHA=$(shasum -a 256 "$DIST_DIR/$SLIM_ZIP" | awk '{print $1}')
SLIM_LEN=$(stat -f%z "$DIST_DIR/$SLIM_ZIP")

# ---- 取已有 items，按 build 号去重 --------------------------------------
EXISTING_ITEMS=""
if [ -f "$APPCAST_PATH" ]; then
  EXISTING_ITEMS=$(awk -v bn="$BUILD_NUMBER" '
    BEGIN { capture = 0 }
    /<item>/ { capture = 1; item = $0 ORS; next }
    capture && /<\/item>/ {
      item = item $0 ORS
      capture = 0
      # 仅检查 item 级 sparkle:version（enclosure 级的同名属性供 Sparkle delta 用）
      if (item !~ "<sparkle:version>"bn"</sparkle:version>") {
        printf "%s", item
      }
      item = ""
      next
    }
    capture { item = item $0 ORS; next }
  ' "$APPCAST_PATH")
fi

# ---- 拼装新 item --------------------------------------------------------
# 字段对齐 docs/auto-update-proposal.md §4.1：
#   - sparkle:shortVersionString / sparkle:version 在 item 级（排序与判定主键）
#   - enclosure 用 sha256 属性校验（自研 B 方案约定；Sparkle edSignature 是
#     ed25519，与 B 方案的 sha256 校验语义不同，故不混用字段名）
#   - 不在 enclosure 上重复 shortVersionString（按 §4.1 示例最小化）
ITEM_XML=$(cat <<EOF
    <item>
      <title>Version ${VERSION}</title>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:version>${BUILD_NUMBER}</sparkle:version>
      <enclosure
        url="${FULL_DMG}"
        sparkle:version="${BUILD_NUMBER}"
        length="${FULL_LEN}"
        type="application/octet-stream"
        sha256="${FULL_SHA}"/>
      <enclosure
        url="${SLIM_ZIP}"
        sparkle:version="${BUILD_NUMBER}"
        length="${SLIM_LEN}"
        type="application/octet-stream"
        sha256="${SLIM_SHA}"/>
      <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
    </item>
EOF
)

# ---- 写出 appcast.xml ---------------------------------------------------
mkdir -p "$(dirname "$APPCAST_PATH")"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">'
  echo '  <channel>'
  echo '    <title>WhalePod 更新通道</title>'
  echo '    <description>WhalePod 每日 alpha 自动更新通道（Sparkle 2 兼容；item 内含 Full DMG + Slim ZIP 双 enclosure）</description>'
  echo '    <language>zh-CN</language>'
  if [ -n "$EXISTING_ITEMS" ]; then
    printf "%s\n" "$EXISTING_ITEMS"
  fi
  printf "%s\n" "$ITEM_XML"
  echo '  </channel>'
  echo '</rss>'
} > "$APPCAST_PATH"

echo "==> appcast.xml 写出: $APPCAST_PATH"
echo "   VERSION=$VERSION BUILD_NUMBER=$BUILD_NUMBER"
echo "   Full: $FULL_DMG ($FULL_LEN bytes, sha256=$FULL_SHA)"
echo "   Slim: $SLIM_ZIP ($SLIM_LEN bytes, sha256=$SLIM_SHA)"

# ---- 自检：xmllint 验证 --------------------------------------------------
if command -v xmllint >/dev/null 2>&1; then
  xmllint --noout "$APPCAST_PATH" && echo "✅ xmllint 验证通过" || { echo "!! xmllint 验证失败"; exit 1; }
else
  echo "(跳过 xmllint 验证：本机未安装)"
fi