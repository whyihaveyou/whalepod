#!/usr/bin/env bash
# =============================================================================
# profile-seed.draft.sh — 【PHASE 2-A DRAFT · 评审用，未接进主构建】
#
# 把 @whalepod/honeycomb 注入一个 dsh profile（以 `web` 为默认示例），幂等。
# 依据 docs/honeycomb-bundling-verification.md V2/V3 结论：
#   - V2：loader 对插件 name 做「父目录上溯」（baseUrl=profile 目录）。
#         包放进 **profiles/node_modules 共享层**（对齐 healProfilesModuleFallback
#         的 BFS+symlink 形态），即可被任意 profile 经父目录上溯解析到——
#         无需为每个 profile 单独 pnpm install，且离线友好。
#   - V3：`dsh.profile.bundles` 是 loader 的「合成顺序清单」（patch 层）。
#         append 用「已存在则跳过」守卫（key=包名），幂等，不重复 append。
#
# 本草案演示：
#   ① 把 honeycomb 以 symlink 形式放进 $DSH_HOME/profiles/node_modules/@whalepod/（共享层）；
#   ② 幂等地把 @whalepod/honeycomb append 进 profile 的 dsh.profile.bundles；
#   ③ 用官方 dsh --dump-config 验证合成树里出现 honeycomb entry（只读，不改装机）。
#
# 用法：  ./Scripts/profile-seed.draft.sh --profile web \
#                 --src /path/to/Resources/node_modules/@whalepod/honeycomb [--dsh-home DIR]
# 边界：默认对**拷出的临时 profile 副本**运行演示；--apply 才真写（先评审后启用）。
#       不碰 Sources/；不改 build-runtime.sh。
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
[ -n "$SRC" ] || { echo "❌ 需要 --src 指向 honeycomb 包目录（如 Resources/node_modules/@whalepod/honeycomb）" >&2; exit 2; }

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
SHARED_NM="$DSH_HOME/profiles/node_modules"
DEST="$SHARED_NM/@whalepod/honeycomb"

echo "==> profile=$PROFILE  dsh-home=$DSH_HOME  apply=$APPLY"

# ---- 0. 校验 -----------------------------------------------------------------
[ -d "$PROFILE_DIR" ] || { echo "❌ profile 目录不存在: $PROFILE_DIR（fuse 空 bundles?先建 profile 或检查 dsh-home）" >&2; exit 2; }
[ -f "$PROFILE_DIR/package.json" ] || { echo "❌ profile 缺 package.json: $PROFILE_DIR/package.json" >&2; exit 2; }
[ -f "$SRC/package.json" ] || { echo "❌ src 不是 honeycomb 包目录: $SRC" >&2; exit 2; }
# 空 bundles 兜底：node 段自动处理（缺失 dsh/dsh.profile/dsh.profile.bundles 均回退 []）。

# 演示安全：非 --apply 时对 profile 副本演练
if [ "$APPLY" -ne 1 ]; then
  DEMO_DIR="/tmp/profile-seed-demo"
  rm -rf "$DEMO_DIR"
  mkdir -p "$DEMO_DIR/profiles/$PROFILE"
  cp "$PROFILE_DIR/package.json" "$DEMO_DIR/profiles/$PROFILE/package.json"
  mkdir -p "$DEMO_DIR/profiles/node_modules"
  PROFILE_DIR="$DEMO_DIR/profiles/$PROFILE"
  SHARED_NM="$DEMO_DIR/profiles/node_modules"
  DEST="$SHARED_NM/@whalepod/honeycomb"
  echo "    （demo 模式：对 $DEMO_DIR 副本演练，不写装机）"
fi

# ---- 1. V2：预置到共享层 profiles/node_modules（symlink，对齐 heal BFS 形态）----
mkdir -p "$SHARED_NM/@whalepod"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "    [1] 共享层已存在 @whalepod/honeycomb（幂等跳过）: $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "    [1] symlink 共享层: $DEST -> $SRC"
fi

# ---- 2. V3：幂等 append 到 dsh.profile.bundles --------------------------------
MANIFEST="$PROFILE_DIR/package.json"
node - "$MANIFEST" <<'EOF'
const fs = require('fs');
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
const PKG = '@whalepod/honeycomb';
const bundles = pkg.dsh?.profile?.bundles ?? [];
if (bundles.includes(PKG)) {
  console.log('    [2] bundles 已含 ' + PKG + '（幂等，跳过）');
} else {
  bundles.push(PKG);
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log('    [2] append ' + PKG + ' → bundles（新顺序如下）');
  console.log('        ' + bundles.join(', '));
}
EOF

# ---- 3. 展示：dump-config 合成序（需在真 DSH_HOME 下跑，demo 副本这里只列 manifest）----
echo "    [3] (demo 仅打印 profile manifest bundles；真 --apply 后可在真 DSH_HOME 跑:"
echo "         dsh --profile $PROFILE --dump-config | grep -i honeycomb)"

echo ""
echo "Done (apply=$APPLY). 折叠进 profile seed：'$PROFILE_DIR/package.json' 现含:"
node -e "const p=require('$MANIFEST');console.log('   bundles =', JSON.stringify(p.dsh?.profile?.bundles))"
