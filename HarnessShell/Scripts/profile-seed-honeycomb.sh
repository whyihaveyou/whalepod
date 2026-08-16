#!/usr/bin/env bash
# =============================================================================
# profile-seed-honeycomb.sh — 把 @whalepod/honeycomb 装箱进 dsh profile（幂等）
#
# 依据 docs/honeycomb-bundling-verification.md V1-V3 + profile.ts 源码核实：
#   - V2：loader 的 Loader.baseUrl = profile 目录；插件名经「父目录上溯」解析。
#         honeycomb 放进 **profiles/node_modules 共享层**（symlink，对齐
#         healProfilesModuleFallback 的 BFS 形态），任意 profile 都能解析到。
#   - V3：profile 自己的 cordis.patch.yml 是「用户 patch 层」，在 bundle 层之后
#         应用。`- insert:`（无 id）→ root append 新建条目（源码确认
#         applyEntryPatches: `else data.push(...insert)`）；普通 `- id:` 行对
#         不存在的 id 只会 warn+skip，不能建新条目 → 必须用 insert 形态。
#   - 反模式（本脚本明确避开）：把 honeycomb append 进 dsh.profile.bundles
#         —— profile.ts `loadProfile` 对无 dsh.bundle 清单的 bundle **fail loud**
#         （"declares no dsh.bundle in its package.json"）。honeycomb 没有
#         dsh.bundle 字段，走 bundles 会让整个 profile 起不来。
#
# 用法：
#   ./Scripts/profile-seed-honeycomb.sh --profile web --src <honeycomb 包目录> [--dsh-home DIR]
#   --apply：真写 DSH_HOME；缺省对 /tmp/profile-seed-demo 副本演练（只读）。
#
# 依赖：node（写 YAML 用）+ 可选的 dsh CLI（验证用）。
# 零 Swift：不改 RuntimeBootstrap.swift / Sources/。
# =============================================================================
set -euo pipefail

# ---- 参数（CLI 优先，env 兜底）--------------------------------------------------
PROFILE=${PROFILE:-web}
SRC=${SRC:-}
DSH_HOME=${DSH_HOME:-"$HOME/Library/Application Support/WhalePod/harness"}
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=1;      shift 1 ;;
    --profile)      PROFILE="$2"; shift 2 ;;
    --src)          SRC="$2";     shift 2 ;;
    --dsh-home)     DSH_HOME="$2"; shift 2 ;;
    *)              shift 1 ;;   # 忽略未知 flag
  esac
done
[ -n "$SRC" ] || { echo "❌ 需要 --src 指向 honeycomb 包目录（含 package.json + lib/）" >&2; exit 2; }

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
SHARED_NM="$DSH_HOME/profiles/node_modules"
DEST="$SHARED_NM/@whalepod/honeycomb"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

echo "==> profile=$PROFILE  dsh-home=$DSH_HOME  apply=$APPLY"

# ---- 0. 校验 -----------------------------------------------------------------
[ -d "$PROFILE_DIR" ] || { echo "❌ profile 目录不存在: $PROFILE_DIR（先启动 dsh 建 profile）" >&2; exit 2; }
[ -f "$SRC/package.json" ] || { echo "❌ src 不是 honeycomb 包目录: $SRC" >&2; exit 2; }
[ -f "$SRC/lib/index.js" ] || { echo "❌ src 缺 lib/index.js（先 npm run build）: $SRC" >&2; exit 2; }

# 演练模式：对 /tmp 副本操作，不写装机
if [ "$APPLY" -ne 1 ]; then
  DEMO_DIR="/tmp/profile-seed-demo"
  rm -rf "$DEMO_DIR"
  mkdir -p "$DEMO_DIR/profiles/$PROFILE"
  # 没有现成 patch 文件时造一个最小占位，验证「append 保留既有内容」
  [ -f "$PATCH_FILE" ] && cp "$PATCH_FILE" "$DEMO_DIR/profiles/$PROFILE/cordis.patch.yml" \
    || printf '%s\n' "# demo 空 patch 层（占位）" > "$DEMO_DIR/profiles/$PROFILE/cordis.patch.yml"
  SHARED_NM="$DEMO_DIR/profiles/node_modules"
  PROFILE_DIR="$DEMO_DIR/profiles/$PROFILE"
  DEST="$SHARED_NM/@whalepod/honeycomb"
  PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
  echo "    （demo 模式：对 $DEMO_DIR 副本演练，不写装机）"
fi

# ---- 1. V2：预置到共享层 profiles/node_modules（symlink，对齐 heal BFS 形态）----
mkdir -p "$SHARED_NM/@whalepod"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "    [1] 共享层已存在（幂等跳过）: $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "    [1] symlink 共享层: $DEST -> $SRC"
fi

# ---- 2. V3：幂等 append `- insert:` 块到 cordis.patch.yml ----------------------
# 判定依据：id: honeycomb 已存在（含 insert 内嵌与普通行）→ 跳过；否则 append。
# 用 node 做文本判定 + append（零 YAML 依赖，行为可审计）。
node - "$PATCH_FILE" <<'EOF'
const fs = require('fs');
const file = process.argv[2];
const BLOCK = [
  '',
  '# --- @whalepod/honeycomb（装箱 seed 注入，幂等）---',
  '- insert:',
  '    - id: honeycomb',
  "      name: '@whalepod/honeycomb'",
  '      config:',
  '        transport:',
  '          enabled: true',
  '          host: 127.0.0.1',
  '          port: 4800',
  '',
].join('\n');

let content = '';
try { content = fs.readFileSync(file, 'utf8'); } catch { /* 新文件 */ }

// 已有 honeycomb 条目（含注释内出现的都算——保守跳过最安全）
if (/id:\s*honeycomb/.test(content)) {
  console.log('    [2] cordis.patch.yml 已含 honeycomb 条目（幂等，跳过）');
} else {
  fs.writeFileSync(file, content.replace(/\s*$/, '') + '\n' + BLOCK);
  console.log('    [2] append insert 块 → ' + file);
  console.log('        - insert: { id: honeycomb, name: @whalepod/honeycomb, transport: 127.0.0.1:4800 }');
}
EOF

# ---- 3. 展示最终 patch 层 ------------------------------------------------------
echo "    [3] $PATCH_FILE 现状："
sed 's/^/        /' "$PATCH_FILE"

echo ""
echo "Done (apply=$APPLY). 真装机验证（--apply 后）:"
echo "    dsh --profile $PROFILE --dump-config | grep -i honeycomb   # 应出现 honeycomb entry"
echo "    dsh --profile $PROFILE 启动后 transport 监听 127.0.0.1:4800"
