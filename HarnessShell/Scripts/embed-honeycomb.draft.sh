#!/usr/bin/env bash
# =============================================================================
# embed-honeycomb.draft.sh — 【PHASE 2-A DRAFT · 评审用，未接进主构建】
#
# 把 @whalepod/honeycomb tarball 装进 runtime node_modules，与 dsh 同一 npm 事务
# （单 lockfile → cordis/schemastery peerDeps 天然去重，与 dsh 用同一份物理副本）。
#
# 依据 docs/honeycomb-app-bundling.md Q5 + V1-V3 验证结论（docs/honeycomb-bundling-verification.md）：
#   - V1：profile/运行时 node_modules 的「安装清单」是 package.json dependencies；
#         `dsh.profile.bundles` 只是 loader 的「合成顺序清单」（patch 层），不管安装。
#         故 honeycomb 要进 node_modules，必须在 dependencies 里声明（这里经 file: tarball）。
#   - V2：包解析走「父目录上溯」——放在共享层 profiles/node_modules 即可对所有 profile 解析（见 profile-seed）。
#   - V3：bundles 是合成顺序清单，append 用「已存在则跳过」守卫幂等（见 profile-seed）。
#
# 本草案演示的是「build-runtime.sh 第 2 步（npm install dsh 全家桶）嵌入 honeycomb」
# 的确切段落——它独立可跑，验证同事务安装 + peerDedup，之后由 Leader 评审再决定是否
# 折进 build-runtime.sh 主链（届时把 HONEYCOMB_TARBALL 段并入其临时 package.json）。
#
# 用法（评审 demo）：
#   HONEYCOMB_TARBALL=/path/to/@whalepod-honeycomb-0.1.0.tgz \
#   ./Scripts/embed-honeycomb.draft.sh /tmp/embed-demo
#
# 边界：不进主构建；不碰 Sources/；产物只在传入的 WORKDIR（默认 /tmp）。
# =============================================================================
set -euo pipefail

# ---- 可配置参数 ---------------------------------------------------------------
HONEYCOMB_TARBALL=${HONEYCOMB_TARBALL:?需要 HONEYCOMB_TARBALL 指向 npm pack 产出的 .tgz}
DSH_VERSION=${DSH_VERSION:-0.1.0-rc.6}
WORKDIR=${1:-/tmp/embed-demo}

# ---- 0. 前置校验 --------------------------------------------------------------
[ -f "$HONEYCOMB_TARBALL" ] || { echo "❌ tarball 不存在: $HONEYCOMB_TARBALL" >&2; exit 2; }
echo "==> honeycomb tarball: $HONEYCOMB_TARBALL"

BUNDLE_DIR="$WORKDIR/bundle"
rm -rf "$WORKDIR"
mkdir -p "$BUNDLE_DIR"
cd "$BUNDLE_DIR"

# ---- 1. 临时 package.json：dsh + honeycomb 同事务 ---------------------------
# 这是与 build-runtime.sh 第 2 步完全同构的形态——唯一差异：dependencies 里多了
# honeycomb 的 file: 本地 tarball 引用。npm 在**同一 install 图**里解析二者，
# honeycomb 的 peerDeps（cordis / schemastery / @deepseek-ai/* ）会被去重到与
# dsh 完全相同的物理副本（单份 cordis），这就是「cordis 单实例」的安装侧保证。
cat > package.json <<EOF
{
  "name": "whalepod-embed-honeycomb-demo",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "$DSH_VERSION",
    "@whalepod/honeycomb": "file:$HONEYCOMB_TARBALL"
  }
}
EOF
echo "==> [1/3] 临时 package.json（dsh + honeycomb 同事务）"
cat package.json

# ---- 2. npm install（--omit=dev + 锁 exact） --------------------------------
echo "==> [2/3] npm install（同一事务；cordis/schemastery peerDedup）"
npm install --omit=dev --save-exact=true --no-audit --no-fund --loglevel=error 2>&1 | tail -5 \
  || { echo "❌ npm install 失败（tarball 路径 / 网络 / peer 冲突）" >&2; exit 4; }

# ---- 3. 验证安装结果 + 单实例断言 ---------------------------------------------
echo "==> [3/3] 验证"
HONEYCOMB_INDEX="$BUNDLE_DIR/node_modules/@whalepod/honeycomb/lib/index.js"
[ -f "$HONEYCOMB_INDEX" ] || { echo "❌ honeycomb lib/index.js 缺失" >&2; exit 5; }
echo "    ✅ @whalepod/honeycomb 已安装: $HONEYCOMB_INDEX"

DSH_BIN="$BUNDLE_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN" ] || { echo "❌ dsh 缺失（回归）" >&2; exit 6; }
echo "    ✅ @deepseek-ai/dsh 仍在: $DSH_BIN"

# cordis 单实例断言：honeycomb 与 dsh 必须解析到**同一份** cordis（peer 去重）。
# 真实 peer 名是 scoped 的 @deepseek-ai/cordis / @deepseek-ai/schemastery（见 honeycomb peerDeps）。
echo "---- cordis / schemastery 单实例断言 ----"
for pkg in "@deepseek-ai/cordis" "@deepseek-ai/schemastery"; do
  TOP_META="$BUNDLE_DIR/node_modules/$pkg/package.json"
  NESTED="$BUNDLE_DIR/node_modules/@whalepod/honeycomb/node_modules/$pkg"
  if [ -f "$TOP_META" ] && [ ! -e "$NESTED" ]; then
    VER=$(node -e "const p=require('$TOP_META');console.log(p.version)")
    echo "    ✅ $pkg 单实例（顶层唯一，honeycomb peer 复用）: version=$VER"
  elif [ -e "$NESTED" ]; then
    echo "    ❌ $pkg 被嵌套，存在重复实例（未去重！）"
  else
    echo "    ℹ️  $pkg 未探测到（信息性：可能不在本档 deps）"
  fi
done
echo "---- 树级唯一性（任意位置出现次数应=1）----"
for pkg in "@deepseek-ai/cordis" "@deepseek-ai/schemastery"; do
  N=$(find "$BUNDLE_DIR/node_modules" -maxdepth 4 -type d -name "$(basename "$pkg")" 2>/dev/null | wc -l | tr -d ' ')
  echo "    $pkg 目录出现次数: $N"
done

echo ""
echo "Demo 完成。产物: $BUNDLE_DIR/node_modules"
echo "折叠进 build-runtime.sh：将 HONEYCOMB_TARBALL 段并入其【第 2 步临时 package.json】dependencies + 验证块。"
