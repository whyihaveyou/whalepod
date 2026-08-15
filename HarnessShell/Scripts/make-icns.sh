#!/bin/bash
# =============================================================================
# make-icns.sh — 把 design/assets 的图标（SVG+PNG）转成 .icns
#
# 输入：$ROOT/../design/assets/*.svg（详见下方 ICON_SPECS）
# 输出：HarnessShell/Resources/{AppIcon,IconDarkTile,IconMono}.icns
#
# 依赖：qlmanage（macOS 自带）、sips（macOS 自带）、iconutil（macOS 自带）
# 说明：SVG 由 qlmanage 渲染成 1024x1024 PNG 作为 icns 主图（icns 最大尺寸 ic10=1024@2x）。
#
# 2026-08-15 修正：原 ASSETS 硬编码 /Users/qzp/aion2dsh/design/assets（仅本机可用）。
#               改为 ROOT 相对，跨机/容器/CI 都能跑。
# TODO(rebrand)：ICON_SPECS 仍引用旧 icon-master/icon-dark-tile/icon-mono.svg
#               （rebrand 后已不存在，新图标是 whalepod-icon-final.svg 等）。
#               下一步打包链路需把 ICON_SPECS 切到新文件名 —— 留给打包 owner。
# =============================================================================
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/../design/assets"
RES="$ROOT/Resources"
WORK="$(mktemp -d /tmp/dsh-icns.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# 输出名:源 SVG（macOS bash 3.2 兼容：不用关联数组）
ICON_SPECS=(
  "AppIcon:icon-master.svg"
  "IconDarkTile:icon-dark-tile.svg"
  "IconMono:icon-mono.svg"
)

mkdir -p "$RES"

for entry in "${ICON_SPECS[@]}"; do
  name="${entry%%:*}"; svgfile="${entry##*:}"
  svg="$ASSETS/$svgfile"
  echo "==> $name  <-  $svgfile"

  # 1) SVG -> 1024x1024 PNG（qlmanage 输出名会带 .svg.png 后缀）
  qlmanage -t -s 1024 -o "$WORK" "$svg" >/dev/null 2>&1
  master="$WORK/$(basename "$svg").png"
  [ -f "$master" ] || { echo "!! qlmanage 渲染失败: $svg"; exit 1; }

  # 2) 按 icns iconset 规格切尺寸
  iconset="$WORK/$name.iconset"
  mkdir -p "$iconset"
  # name: size
  for spec in \
    "icon_16x16.png:16" \
    "icon_16x16@2x.png:32" \
    "icon_32x32.png:32" \
    "icon_32x32@2x.png:64" \
    "icon_128x128.png:128" \
    "icon_128x128@2x.png:256" \
    "icon_256x256.png:256" \
    "icon_256x256@2x.png:512" \
    "icon_512x512.png:512" \
    "icon_512x512@2x.png:1024"; do
    file="${spec%%:*}"; size="${spec##*:}"
    sips -z "$size" "$size" "$master" --out "$iconset/$file" >/dev/null
  done

  # 3) iconset -> icns
  iconutil -c icns "$iconset" -o "$RES/$name.icns"
  echo "    -> $RES/$name.icns ($(du -h "$RES/$name.icns" | cut -f1))"
done

echo "完成："
ls -lh "$RES"/*.icns
