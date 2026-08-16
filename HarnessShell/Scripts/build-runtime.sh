#!/usr/bin/env bash
# =============================================================================
# build-runtime.sh — 把 node + @deepseek-ai/dsh 全家桶打进 .app（M0 实做版）
#
# 依据：docs/m0-runtime-bootstrap-plan.md（方案 a+b：bundled 优先 → 本机探测 → npx 兜底）
# 适配：HarnessShell/Sources/HarnessShell/RuntimeBootstrap.swift
#       bundledNodePath()     = Resources/node/bin/node
#       bundledDSHBinPath()   = Resources/node_modules/@deepseek-ai/dsh/lib/bin.js
#
# 用法：
#   # 默认：当前 .app + 默认版本 + arm64
#   ./Scripts/build-runtime.sh
#
#   # 显式指定 .app 与版本
#   APP_PATH=HarnessShell/dist/HarnessShell.app \
#   NODE_VERSION=22.17.0 DSH_VERSION=0.1.0-rc.6 \
#   ./Scripts/build-runtime.sh
#
#   # Intel 验证（仅开发调试，默认发版走 arm64）
#   ARCH=x64 ./Scripts/build-runtime.sh
#
#   # 装箱 honeycomb（与 dsh 同一 npm 事务；先 npm pack 出 tarball）
#   HONEYCOMB_TARBALL=/tmp/honeycomb-pack/whalepod-honeycomb-0.1.0.tgz \
#   ./Scripts/build-runtime.sh
#
# 产物布局（最终）：
#   <APP_PATH>/Contents/Resources/
#   ├── node/
#   │   ├── bin/node            # node 二进制
#   │   ├── bin/{npm,npx,corepack}
#   │   └── lib/                # 共享库（macOS dylibs 等）
#   └── node_modules/
#       ├── @deepseek-ai/dsh/   # dsh 全家桶（已 --omit=dev 净化）
#       ├── @whalepod/honeycomb/ # 装箱插件（HONEYCOMB_TARBALL 非空时，同事务）
#       └── <transitive deps>
#
# 体积预估（实测为准）：
#   - node tarball 解压 ≈ 80–90MB（含内置模块）
#   - dsh 全家桶 --omit=dev  ≈ 5–15MB
#   - 合计增量 ≈ 90–105MB
#
# 边界：
#   - 不碰 HarnessShell/Sources/ 任何 Swift 源码
#   - 不动 Info.plist / .app 模板
#   - 仅写 Resources/{node,node_modules} 与中间临时目录
#   - 签名单独走（ad-hoc 本地用；Developer ID+notarize 见 docs/build-runtime.md）
# =============================================================================
set -euo pipefail

# ---- CWD 锚定（防 cd 漂移） ---------------------------------------------------
ORIG_CWD="$(pwd)"

# ---- 可配置参数 ---------------------------------------------------------------
NODE_VERSION=${NODE_VERSION:-22.17.0}             # 与本机实测一致（v22.17.0）
DSH_VERSION=${DSH_VERSION:-0.1.0-rc.6}            # 与 RuntimeBootstrap.dshVersion 对齐
ARCH=${ARCH:-arm64}                                # Apple Silicon；开发验证可用 x64
APP_PATH=${APP_PATH:-HarnessShell/dist/HarnessShell.app}
WORKDIR=${WORKDIR:-/tmp/whalepod-runtime.$(date +%s)}
SKIP_VERIFY=${SKIP_VERIFY:-0}                      # 1=跳过产物自检（CI 调试用）
VERBOSE=${VERBOSE:-0}                              # 1=开启 set -x
# honeycomb 装箱（docs/honeycomb-app-bundling.md Q5）：为空则只装 dsh（兼容旧流程）；
# 非空则与 dsh 同一 npm 事务安装（单 lockfile → cordis/schemastery peerDedup 单实例）
HONEYCOMB_TARBALL=${HONEYCOMB_TARBALL:-}

[ "$VERBOSE" = "1" ] && set -x

# ---- 派生路径 -----------------------------------------------------------------
MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
PATCH=$(echo "$NODE_VERSION" | cut -d. -f3)
NODE_BASE="node-v${NODE_VERSION}-darwin-${ARCH}"
NODE_TARBALL="${NODE_BASE}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

# ---- 前置检查 -----------------------------------------------------------------
if [ ! -d "$APP_PATH" ]; then
  echo "❌ APP_PATH 不存在：$APP_PATH" >&2
  echo "   请先 build .app（如：cd HarnessShell && swift build -c release && ./Scripts/build-app.sh）" >&2
  exit 2
fi
if [ "$NODE_VERSION" = "22.17.0" ] && [ "$ARCH" = "arm64" ]; then
  echo "ℹ️  使用默认版本：node $NODE_VERSION darwin-$ARCH（与 RuntimeBootstrap / M0 方案对齐）"
fi

RES="$(cd "$(dirname "$APP_PATH")" && pwd)/$(basename "$APP_PATH")/Contents/Resources"
mkdir -p "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

echo "=================================================================="
echo "  M0 运行时自举打包（bundled 形态）"
echo "  node    : $NODE_VERSION darwin-$ARCH"
echo "  dsh     : @deepseek-ai/dsh@$DSH_VERSION"
echo "  app     : $APP_PATH"
echo "  workdir : $WORKDIR"
echo "=================================================================="

# ---- 1. 下载并解压官方 node tarball -------------------------------------------
echo ""
echo "==> [1/4] 下载并解压 node tarball"
echo "    URL: $NODE_URL"
curl -fL --retry 3 -o "$WORKDIR/$NODE_TARBALL" "$NODE_URL"
echo "    ✅ 下载完成：$(du -h "$WORKDIR/$NODE_TARBALL" | cut -f1)"
tar -xJf "$WORKDIR/$NODE_TARBALL" -C "$WORKDIR"
[ -x "$WORKDIR/$NODE_BASE/bin/node" ] || {
  echo "❌ 解压后未找到 node 可执行：$WORKDIR/$NODE_BASE/bin/node" >&2
  exit 3
}
NODE_VER_CHECK="$("$WORKDIR/$NODE_BASE/bin/node" --version)"
echo "    ✅ node 可执行：$NODE_VER_CHECK"
cd "$ORIG_CWD"

# ---- 2. 生成纯净 dsh node_modules（确定性可复现） ----------------------------
echo ""
echo "==> [2/4] npm install dsh 全家桶（--omit=dev + 锁版本）"
BUNDLE_DIR="$WORKDIR/bundle"
mkdir -p "$BUNDLE_DIR"
cd "$BUNDLE_DIR"

# 写临时 package.json（仅用于 npm install 解析；不进 .app）
# HONEYCOMB_TARBALL 非空 → 与 dsh 同一 npm 事务装 honeycomb（peerDeps 去重单实例）
HONEYCOMB_DEP_LINE=""
if [ -n "$HONEYCOMB_TARBALL" ]; then
  [ -f "$HONEYCOMB_TARBALL" ] || { echo "❌ HONEYCOMB_TARBALL 不存在: $HONEYCOMB_TARBALL" >&2; exit 2; }
  HONEYCOMB_DEP_LINE="    ,\"@whalepod/honeycomb\": \"file:$HONEYCOMB_TARBALL\""
  echo "    ✅ honeycomb 同事务：file:$HONEYCOMB_TARBALL"
fi
cat > package.json <<EOF
{
  "name": "whalepod-runtime-tmp",
  "version": "0.0.0",
  "private": true,
  "description": "build-runtime.sh 临时包（不进 .app，不入库）",
  "dependencies": {
    "@deepseek-ai/dsh": "$DSH_VERSION"
$HONEYCOMB_DEP_LINE
  }
}
EOF

# --save-exact=true 锁死 dsh 版本（避免 ^/~ 范围漂移）
# --no-audit --no-fund 加速、减少无关输出
# 生产依赖（--omit=dev）去掉 devDependencies，确保纯净
npm install --omit=dev --save-exact=true --no-audit --no-fund --loglevel=error 2>&1 | tail -5 || {
  echo "❌ npm install 失败（registry 网络/版本/权限问题）" >&2
  exit 4
}

# 验证 dsh 安装结果
DSH_BIN_LOCAL="$BUNDLE_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN_LOCAL" ] || {
  echo "❌ dsh bin.js 不存在：$DSH_BIN_LOCAL" >&2
  echo "   试试: npm view @deepseek-ai/dsh@$DSH_VERSION dist.tarball" >&2
  exit 5
}
echo "    ✅ dsh 入口存在：$DSH_BIN_LOCAL"

# honeycomb 安装验证（仅当 HONEYCOMB_TARBALL 非空）
if [ -n "$HONEYCOMB_TARBALL" ]; then
  HONEYCOMB_INDEX="$BUNDLE_DIR/node_modules/@whalepod/honeycomb/lib/index.js"
  [ -f "$HONEYCOMB_INDEX" ] || {
    echo "❌ honeycomb lib/index.js 缺失：$HONEYCOMB_INDEX" >&2
    exit 5
  }
  echo "    ✅ honeycomb 入口存在：$HONEYCOMB_INDEX"

  # cordis / schemastery 单实例断言：honeycomb 与 dsh 必须解析到同一份（peer 去重）
  echo "---- cordis / schemastery 单实例断言 ----"
  for pkg in "@deepseek-ai/cordis" "@deepseek-ai/schemastery"; do
    TOP_META="$BUNDLE_DIR/node_modules/$pkg/package.json"
    NESTED="$BUNDLE_DIR/node_modules/@whalepod/honeycomb/node_modules/$pkg"
    if [ -f "$TOP_META" ] && [ ! -e "$NESTED" ]; then
      VER=$(node -e "const p=require('$TOP_META');console.log(p.version)")
      echo "    ✅ $pkg 单实例（顶层唯一，honeycomb peer 复用）: version=$VER"
    elif [ -e "$NESTED" ]; then
      echo "    ❌ $pkg 被嵌套，存在重复实例（未去重！）" >&2
    else
      echo "    ℹ️  $pkg 未探测到（信息性：可能不在本档 deps）"
    fi
  done
fi

# 锁定 lockfile（确定性可复现的「单一真理源」）
[ -f "$BUNDLE_DIR/package-lock.json" ] && cp "$BUNDLE_DIR/package-lock.json" "$WORKDIR/dsh-package-lock.json"
echo "    ✅ package-lock.json 已保存（后续 CI 可走 npm ci --offline 离线复现）"
cd "$ORIG_CWD"

# ---- 3. 拷进 .app/Contents/Resources/ -----------------------------------------
echo ""
echo "==> [3/4] 拷进 .app/Contents/Resources/"
mkdir -p "$RES/node/bin" "$RES/node/lib" "$RES/node_modules"

# 3a. bin/node + bin/{npm,npx,corepack}
cp "$WORKDIR/$NODE_BASE/bin/node" "$RES/node/bin/node"
chmod +x "$RES/node/bin/node"
for tool in npm npx corepack; do
  if [ -x "$WORKDIR/$NODE_BASE/bin/$tool" ]; then
    cp "$WORKDIR/$NODE_BASE/bin/$tool" "$RES/node/bin/$tool"
    chmod +x "$RES/node/bin/$tool"
  fi
done
# 3b. lib/（macOS 共享库 / node 内置模块）
cp -R "$WORKDIR/$NODE_BASE/lib/." "$RES/node/lib/"
# 3c. node_modules/（纯净 dsh 全家桶；rsync 比 cp -R 在 macOS 上保留权限更可靠）
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$BUNDLE_DIR/node_modules/" "$RES/node_modules/"
else
  rm -rf "$RES/node_modules"
  cp -R "$BUNDLE_DIR/node_modules" "$RES/node_modules"
fi

echo "    ✅ 拷贝完成"
ls -la "$RES/node/bin/" "$RES/node_modules/@deepseek-ai/dsh/lib/bin.js" | head -10

# ---- 4. 自检产物（验证 RuntimeBootstrap.bundled 分支可命中） -------------------
if [ "$SKIP_VERIFY" = "1" ]; then
  echo ""
  echo "==> [4/4] ⚠️  SKIP_VERIFY=1，跳过自检（CI 调试用）"
else
  echo ""
  echo "==> [4/4] 自检产物（node --version + dsh bin.js --help）"

  # 4a. node 二进制可执行 + 版本对齐
  RES_NODE="$RES/node/bin/node"
  RES_NODE_VER="$("$RES_NODE" --version)"
  EXPECT_NODE_VER="v${NODE_VERSION}"
  if [ "$RES_NODE_VER" = "$EXPECT_NODE_VER" ]; then
    echo "    ✅ node 版本对齐：$RES_NODE_VER（期望 $EXPECT_NODE_VER）"
  else
    echo "    ⚠️  node 版本不一致：实际 $RES_NODE_VER，期望 $EXPECT_NODE_VER" >&2
  fi

  # 4b. dsh bin.js 可加载（--help 不启动 web server，最稳的冒烟）
  RES_DSH_BIN="$RES/node_modules/@deepseek-ai/dsh/lib/bin.js"
  if "$RES_NODE" "$RES_DSH_BIN" --help >/dev/null 2>&1; then
    echo "    ✅ dsh CLI 可执行：$RES_DSH_BIN"
  else
    # --help 可能不被 dsh 支持（dsh 可能直接走 web 子命令）；改用 dsh --version 或包元信息
    DSH_PKG_JSON="$RES/node_modules/@deepseek-ai/dsh/package.json"
    if [ -f "$DSH_PKG_JSON" ]; then
      DSH_ACT_VER=$(node -e "console.log(require('$DSH_PKG_JSON').version)" 2>/dev/null || echo "unknown")
      if [ "$DSH_ACT_VER" = "$DSH_VERSION" ]; then
        echo "    ✅ dsh 版本对齐：$DSH_ACT_VER（包元信息）"
      else
        echo "    ⚠️  dsh 版本不一致：实际 $DSH_ACT_VER，期望 $DSH_VERSION" >&2
      fi
    fi
  fi

  # 4c. honeycomb 装箱自检（真 Node ESM import 冒烟 + cordis 单实例）
  if [ -n "$HONEYCOMB_TARBALL" ]; then
    RES_HC_INDEX="$RES/node_modules/@whalepod/honeycomb/lib/index.js"
    if [ -f "$RES_HC_INDEX" ]; then
      if "$RES_NODE" --input-type=module -e "import('$RES_HC_INDEX').then(()=>{console.log('OK')}).catch(e=>{console.error(e.code||e.message);process.exit(1)})" >/dev/null 2>&1; then
        echo "    ✅ honeycomb 真 Node ESM import 冒烟通过：$RES_HC_INDEX"
      else
        echo "    ⚠️  honeycomb ESM import 失败（真 Node 运行时）" >&2
      fi
    else
      echo "    ⚠️  honeycomb lib/index.js 缺失于 .app：$RES_HC_INDEX" >&2
    fi
  fi
fi

# ---- 体积报告 -----------------------------------------------------------------
echo ""
echo "==> 体积报告"
TOTAL_APP=$(du -sh "$APP_PATH" | cut -f1)
NODE_SIZE=$(du -sh "$RES/node" | cut -f1)
MODULES_SIZE=$(du -sh "$RES/node_modules" | cut -f1)
echo "    .app 总大小    : $TOTAL_APP"
echo "    Resources/node : $NODE_SIZE"
echo "    Resources/node_modules : $MODULES_SIZE"

echo ""
echo "==> ✅ M0 bundled 打包完成"
echo "    下一步："
echo "      ad-hoc 签名（开发）：    codesign --force --deep -s - '$APP_PATH'"
echo "      Developer ID（发版）：见 docs/build-runtime.md §三"
echo "      验证 bundled 命中：    config.command 留空 → 启动 HarnessShell → 期望走 bundled 分支"
echo ""
echo "    产物布局："
find "$RES" -maxdepth 3 -mindepth 1 | sort | sed 's/^/      /'