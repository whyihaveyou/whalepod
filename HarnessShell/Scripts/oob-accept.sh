#!/usr/bin/env bash
# =============================================================================
# oob-accept.sh — OOB-4 开箱版全链真机验收（架构-Pro-2 / 验收官）
#
# 流程：全新沙盒 HOME → DMG 挂载拷贝安装 → env -i 首启 → /health（或 / 回退）
#       → 六断言 a–f（逐项独立配色）→ 验收报告（Markdown）
#
# 六断言（exit code 位掩码，0=全绿；bit0=a … bit5=f；SKIP 不置位）：
#   a. 内置 runtime 里 @whalepod/honeycomb 存在，且真 Node ESM import 暴露 63 exports
#   b. cordis / schemastery 存在且全树单实例（复用 build-runtime 断言逻辑）
#   c. profile patch 合成含 honeycomb 条目（bundled dsh web --dump-config）
#   d. transport :4800 起服，REST hive/tasks 写入 + 读回「真数据」
#   e. dsh web 面板插件 bundle 200 + 面板挂载真数据（Playwright 探针）
#   f. 全程零 console.error / pageerror（Playwright 探针 console tap）
#
# 用法：
#   oob-accept.sh [--dmg PATH] [--keep] [--only a,c] [--skip e,f]
#                 [--stop-existing] [--panel-paths x,y] [--ui-timeout-ms N]
#
# 沙盒边界声明（验收官发现 OOB-F1）：
#   app 的 DataRoot 硬编到真实 ~/Library/Application Support/WhalePod（flock
#   singleton.lock 全局互斥），env HOME 沙盒对 app 层**不生效**——DMG 拷贝/日志/
#   报告/拷出的 app 本体在沙盒，但运行期数据仍写真实 home。因此：
#   - 运行期判定（c/d）按真实数据根对账（read-only dump-config + :4800 REST 写读回，
#     写入的 oob-accept-* hive 属可识别一次性种子）。
#   - 运行前必须独占单实例锁：默认检测在跑实例则 BLOCK（exit 129）；--stop-existing
#     会先 SIGTERM 再验尸后继续（会打断本机正在用的 HarnessShell/WhalePod 实例！）。
#   - 真·全沙盒验收待 app 提供数据根环保 override（已向 OOB-1 提，见报告 OOB-F1）。
# 环境：
#   OOB_DSH_REPO       deepseek-harness workspace 根（playwright 复用来源）
#   OOB_EXPECT_RED     逗号分隔字母，仅作报告标注（不影响判定），alpha.5 为 a,c,d,e
#
# 已知事实（验收官注记）：
#   - alpha.5 DMG 内 app 仍为 HarnessShell.app（branding 未落位），脚本按挂载根
#     首个 *.app 自动识别，无需改名假设。
#   - 真实 dsh web 无 /health 路由（deepseek-harness 源内 grep 零命中）：探针先
#     试 /health，404 则回退 / 期望 200 并在报告注明走回退路径。
#   - playwright 复用 deepseek-harness node_modules/.pnpm/playwright@1.61.1；
#     注册浏览器（ms-playwright 缓存）起不来时回退系统 Chrome。
# =============================================================================

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROBE_MJS="$SCRIPT_DIR/oob-accept-ui.mjs"
DSH_REPO="${OOB_DSH_REPO:-$REPO_ROOT/deepseek-harness}"

# ---------------------------------------------------------------- 参数解析
DMG=""
KEEP=0
ONLY=""
SKIP=""
STOP_EXISTING=0
PANEL_PATHS_ARG=""
UI_TIMEOUT_MS=15000

while [ $# -gt 0 ]; do
  case "$1" in
    --dmg) DMG="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --stop-existing) STOP_EXISTING=1; shift ;;
    --panel-paths) PANEL_PATHS_ARG="$2"; shift 2 ;;
    --ui-timeout-ms) UI_TIMEOUT_MS="$2"; shift 2 ;;
    -h|--help) sed -n '1,36p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; sed -n '1,36p' "$0" >&2; exit 64 ;;
  esac
done

if [ -z "$DMG" ]; then
  DMG="$(ls -t "$REPO_ROOT"/HarnessShell/dist/WhalePod-*-macos-arm64.dmg 2>/dev/null | head -1)"
fi
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "❌ 找不到 DMG（--dmg 未给且 dist/ 无 WhalePod-*-macos-arm64.dmg）" >&2
  exit 65
fi

TS="$(date +%Y%m%d-%H%M%S)"
SB="$(mktemp -d "/tmp/oob-accept-${TS}-XXXX")"
MNT="$SB/mnt"
APP_DST_DIR="$SB/app"
LOG_APP="$SB/logs/app.log"
OUT_DIR="$SB/out"
mkdir -p "$MNT" "$APP_DST_DIR" "$SB/logs" "$OUT_DIR" "$SB/home"

APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ]; then kill "$APP_PID" 2>/dev/null; fi
  # 兜底：被验 app 及其 bundled node 子进程（路径均在沙盒内）
  pkill -f "$SB/" 2>/dev/null
  hdiutil detach "$MNT" -quiet 2>/dev/null
  if [ "$KEEP" -eq 0 ]; then :; fi  # 沙盒默认保留（证据），--keep 仅显式强调
}
trap cleanup EXIT INT TERM

wanted() {  # wanted a → 0=要做 1=跳过
  local k="$1"
  if [ -n "$ONLY" ] && [ "${ONLY#*"$k"}" = "$ONLY" ]; then return 1; fi
  if [ -n "$SKIP" ] && [ "${SKIP#*"$k"}" != "$SKIP" ]; then return 1; fi
  return 0
}

# ---------------------------------------------------------------- 头部展示
DMG_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
HOST_SW="$(sw_vers 2>/dev/null | tr '\t' ' ' | tr '\n' ' ' | tr -s ' ')"
echo "==================================================================="
echo " OOB-4 开箱版全链验收  ·  $(date '+%Y-%m-%d %H:%M:%S %z')"
echo " DMG    : $DMG"
echo " SHA256 : $DMG_SHA"
echo " 沙盒   : $SB"
echo "==================================================================="

# ---------------------------------------------------------------- §1 沙盒安装
echo "▶ §1 DMG 挂载 + 拷贝安装到沙盒"
if ! hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null 2>&1; then
  echo "❌ DMG 挂载失败"; exit 66
fi
APP_SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP_SRC" ]; then
  echo "❌ 挂载卷内无 *.app"; exit 66
fi
APP_NAME="$(basename "$APP_SRC")"
echo "  发现 app：$APP_NAME（alpha.5 预期 HarnessShell.app——branding 未落位已知）"
ditto "$APP_SRC" "$APP_DST_DIR/$APP_NAME"
hdiutil detach "$MNT" -quiet 2>/dev/null
APP="$APP_DST_DIR/$APP_NAME"
EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
APP_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo '?')"
EXE="$APP/Contents/MacOS/$EXE_NAME"
RES="$APP/Contents/Resources"
NODE="$RES/node/bin/node"
echo "  版本 $APP_VER · 可执行 $EXE_NAME"

# ---------------------------------------------------------------- §2 首启
echo "▶ §2 首启（env -i 精简环境直启；数据根=真实 home，见头部 OOB-F1）"
# 单实例冲突预审：app 数据根全局 flock，实弹验收必须独占
CONFLICT="$(pgrep -f '/Contents/MacOS/(HarnessShell|WhalePod)$' 2>/dev/null || true)"
if [ -n "$CONFLICT" ]; then
  if [ "$STOP_EXISTING" -eq 1 ]; then
    echo "  ⚠ 在跑实例（--stop-existing 已声明，先 SIGTERM）：$CONFLICT"
    echo "$CONFLICT" | while read -r p; do
      ps -p "$p" -o command= 2>/dev/null | sed 's/^/    杀 /'
    done
    echo "$CONFLICT" | xargs kill 2>/dev/null
    sleep 2
    LEFT="$(pgrep -f '/Contents/MacOS/(HarnessShell|WhalePod)$' 2>/dev/null | grep -v "$$" || true)"
    [ -n "$LEFT" ] && { echo "$LEFT" | xargs kill -9 2>/dev/null; sleep 1; }
    # 它们的 dsh web 子进程（孤儿 node）一并清，避免端口/过程混淆
    pkill -f '/Contents/Resources/node/bin/node .*/bin\.js web' 2>/dev/null
    sleep 1
  else
    echo "❌ 单实例冲突：下列 HarnessShell/WhalePod 实例持锁在跑："
    echo "$CONFLICT" | while read -r p; do
      echo "    pid $p  $(ps -p "$p" -o command= 2>/dev/null)"
    done
    echo "  关闭后重试，或加 --stop-existing 由脚本清场（exit 129=前置冲突）"
    exit 129
  fi
fi

env -i \
  HOME="$HOME" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$EXE" >"$LOG_APP" 2>&1 &
APP_PID=$!
echo "  pid=$APP_PID · 日志 $LOG_APP"

BASE_URL=""
i=0
while [ $i -lt 240 ]; do
  BASE_URL="$(grep -oE 'https?://[^[:space:]]*127\.0\.0\.1:[0-9]{2,5}[^[:space:]]*' "$LOG_APP" 2>/dev/null | head -1 | sed 's:/*$::')"
  [ -n "$BASE_URL" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
  sleep 0.5
  i=$((i+1))
done
if [ -z "$BASE_URL" ]; then
  echo "❌ 120s 内日志无 127.0.0.1:port（app 未起服）。日志尾部："
  tail -20 "$LOG_APP" | sed 's/^/    /'
  echo ""
  echo "▶ 报告骨架写入 $OUT_DIR/REPORT.md（全部断言 BLOCKED）"
  {
    echo "# OOB-4 验收报告（BLOCKED：首启失败）"
    echo "- DMG: $DMG（sha256 $DMG_SHA）"
    echo "- 沙盒: $SB · app日志: $LOG_APP"
    echo "### 日志尾部"
    echo '```'
    tail -40 "$LOG_APP"
    echo '```'
  } > "$OUT_DIR/REPORT.md"
  exit 127  # 前置失败：全链断，非单断言位
fi
PORT="${BASE_URL##*:}"
echo "  起服 $BASE_URL（随机端口 $PORT）"

# /health 优先，回退 /；并截取 body 头部判定真路由还是 SPA index.html 回退
curl -fsS --max-time 5 -o "$OUT_DIR/health-body.txt" "$BASE_URL/health" 2>/dev/null
CODE_HEALTH="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/health" 2>/dev/null || echo 000)"
HEALTH_PATH="/health"
HEALTH_BODY_SNIP="$(head -c 96 "$OUT_DIR/health-body.txt" 2>/dev/null | tr '\n' ' ')"
if [ "$CODE_HEALTH" != "200" ]; then
  CODE_ROOT="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL" 2>/dev/null || echo 000)"
  if [ "$CODE_ROOT" = "200" ]; then
    HEALTH_PATH="/"
    HEALTH_NOTE="/health=$CODE_HEALTH → 回退 / =200（dsh web 无 /health 路由，源内 grep 零命中）"
  else
    echo "❌ 起服但 HTTP 不通（/health=$CODE_HEALTH /=$CODE_ROOT）"
    exit 127
  fi
else
  case "$HEALTH_BODY_SNIP" in
    *ok* | *health* | *status* ) HEALTH_NOTE="/health=200，body 似健康帧：$HEALTH_BODY_SNIP" ;;
    *doctype* | *HTML* | *html* ) HEALTH_NOTE="/health=200 但 body 为 HTML（SPA 回退嫌疑，非真路由）：$HEALTH_BODY_SNIP" ;;
    * ) HEALTH_NOTE="/health=200，body：$HEALTH_BODY_SNIP" ;;

  esac
fi
echo "  健康探针：$HEALTH_NOTE"

# ---------------------------------------------------------------- 断言框架
declare STATUS_a=SKIP STATUS_b=SKIP STATUS_c=SKIP STATUS_d=SKIP STATUS_e=SKIP STATUS_f=SKIP
declare NOTE_a="" NOTE_b="" NOTE_c="" NOTE_d="" NOTE_e="" NOTE_f=""
EXIT_MASK=0

set_result() {  # set_result <letter> <PASS|FAIL|SKIP> <note>
  local k="$1" st="$2" note="$3"
  eval "STATUS_$k=\"$st\""
  eval "NOTE_$k=\"\$note\""
  if [ "$st" = "FAIL" ]; then
    case "$k" in
      a) EXIT_MASK=$((EXIT_MASK|1)) ;;
      b) EXIT_MASK=$((EXIT_MASK|2)) ;;
      c) EXIT_MASK=$((EXIT_MASK|4)) ;;
      d) EXIT_MASK=$((EXIT_MASK|8)) ;;
      e) EXIT_MASK=$((EXIT_MASK|16)) ;;
      f) EXIT_MASK=$((EXIT_MASK|32)) ;;
    esac
  fi
}

mark() {
  local st="$1"
  case "$st" in PASS) echo "✅ PASS" ;; FAIL) echo "❌ FAIL" ;; *) echo "⏭  SKIP" ;; esac
}

HC_DIR="$RES/node_modules/@whalepod/honeycomb"

# ---------------------------------------------------------------- 断言 a
echo ""
echo "▶ 断言 a：内置 runtime 含 @whalepod/honeycomb 且 ESM import 暴露 63 exports"
if wanted a; then
  if [ ! -d "$HC_DIR" ]; then
    set_result a FAIL "目录缺失：$HC_DIR（alpha.5 预期红——honeycomb 未装箱）"
  else
    IMPORT_OUT="$("$NODE" --input-type=module -e \
      'const m=await import(process.argv[1]);process.stdout.write(String(Object.keys(m).length))' \
      "$HC_DIR/lib/index.js" 2>&1)"
    IMPORT_RC=$?
    if [ $IMPORT_RC -ne 0 ]; then
      set_result a FAIL "ESM import 抛错（rc=$IMPORT_RC）：$(echo "$IMPORT_OUT" | tail -3 | tr '\n' ' ')"
    elif [ "$IMPORT_OUT" = "63" ]; then
      set_result a PASS "import 成功，exports=63"
    else
      set_result a FAIL "import 成功但 exports=$IMPORT_OUT ≠ 63"
    fi
  fi
fi
echo "  $(mark $STATUS_a)  $NOTE_a"

# ---------------------------------------------------------------- 断言 b
echo ""
echo "▶ 断言 b：cordis / schemastery 存在且全树单实例"
if wanted b; then
  if [ ! -d "$HC_DIR" ]; then
    # honeycomb 未装箱：单实例不变量的主体（honeycomb subtree）不存在 → 空真 SKIP。
    # alpha.5 runtime 用 vendored @deepseek-ai/cordis(+schemastery)，无 bare 包——正常。
    VENDOR_NOTE=""
    [ -d "$RES/node_modules/@deepseek-ai/cordis" ] && VENDOR_NOTE="vendored @deepseek-ai/cordis 在位"
    [ -d "$RES/node_modules/@deepseek-ai/schemastery" ] && VENDOR_NOTE="$VENDOR_NOTE / @deepseek-ai/schemastery 在位"
    set_result b SKIP "honeycomb 未装箱 → 单实例检查主体缺席（$VENDOR_NOTE）；随 alpha.6 装箱生效"
  else
    B_FAIL=""
    for pkg in cordis schemastery; do
      if [ ! -d "$RES/node_modules/$pkg" ]; then
        B_FAIL="$B_FAIL 顶层缺失:$pkg;"
      fi
      if [ -f "$HC_DIR/node_modules/$pkg/package.json" ]; then
        B_FAIL="$B_FAIL 嵌套重复:$pkg(@whalepod/honeycomb/node_modules);"
      fi
    done
    if [ -n "$B_FAIL" ]; then
      set_result b FAIL "$B_FAIL"
    else
      set_result b PASS "顶层 cordis+schemastery 在位且 honeycomb 子树无嵌套副本（单实例成立）"
    fi
  fi
fi
echo "  $(mark $STATUS_b)  $NOTE_b"

# ---------------------------------------------------------------- 断言 c
echo ""
echo "▶ 断言 c：profile patch 合成含 honeycomb 条目（dsh web --dump-config）"
if wanted c; then
  # 数据根与 app 同址（真实 home；app 层不受沙盒 HOME 影响——OOB-F1）
  DSH_HOME_X="$HOME/Library/Application Support/WhalePod/harness"
  CLI="$RES/node_modules/@deepseek-ai/dsh/lib/bin.js"
  DUMP_OUT="$OUT_DIR/dump-config.txt"
  env -i HOME="$HOME" DSH_HOME="$DSH_HOME_X" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$NODE" "$CLI" web --dump-config > "$DUMP_OUT" 2>&1
  DUMP_RC=$?
  if [ $DUMP_RC -ne 0 ]; then
    set_result c FAIL "dump-config 非零退出 rc=$DUMP_RC（tail：$(tail -2 "$DUMP_OUT" | tr '\n' ' ')）"
  else
    HC_HITS="$(grep -ci 'honeycomb' "$DUMP_OUT" 2>/dev/null)"; HC_HITS="${HC_HITS:-0}"
    if [ "$HC_HITS" -gt 0 ]; then
      FIRST_HIT="$(grep -i 'honeycomb' "$DUMP_OUT" | head -1 | sed 's/^ *//')"
      set_result c PASS "dump 内 honeycomb 命中 $HC_HITS 处；首条：$FIRST_HIT"
    else
      set_result c FAIL "dump 内 0 处 honeycomb（patch 未合成 honeycomb 条目；alpha.5 预期红）"
    fi
  fi
fi
echo "  $(mark $STATUS_c)  $NOTE_c"

# ---------------------------------------------------------------- 断言 d
echo ""
echo "▶ 断言 d：transport :4800 起服 + REST hive/tasks 真数据写入读回"
HIVE_NAME="oob-accept-$TS"
HIVE_ID=""
if wanted d; then
  T="http://127.0.0.1:4800"
  # JSON 助手：bundled node 读 stdin 解 envelope
  jpick() {  # jpick <jsonfile> <path.js-expr-on-data>
    "$NODE" -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const d=o&&o.data;const v=eval(process.argv[2]);process.stdout.write(v==null?"":String(v))' "$1" "$2" 2>/dev/null
  }
  curl -fsS -o "$OUT_DIR/hives-1.json" -w '%{http_code}' --max-time 8 "$T/v1/hives" \
    > "$OUT_DIR/hives-1.code" 2>/dev/null
  CODE_D="$(cat "$OUT_DIR/hives-1.code" 2>/dev/null || echo 000)"
  if [ "$CODE_D" != "200" ]; then
    set_result d FAIL "GET /v1/hives → $CODE_D（:4800 未起服或非 transport；alpha.5 预期红）"
  else
    POST_OUT="$(curl -fsS -o "$OUT_DIR/hive-post.json" -w '%{http_code}' --max-time 8 \
      -X POST -H 'content-type: application/json' \
      -d "{\"name\":\"$HIVE_NAME\",\"workspace\":\"/tmp/oob-accept\"}" \
      "$T/v1/hives" 2>/dev/null)"
    if [ "$POST_OUT" != "200" ]; then
      set_result d FAIL "POST /v1/hives → $POST_OUT"
    else
      HIVE_ID="$(jpick "$OUT_DIR/hive-post.json" 'd.id')"
      TASK_OUT="$(curl -fsS -o "$OUT_DIR/task-post.json" -w '%{http_code}' --max-time 8 \
        -X POST -H 'content-type: application/json' \
        -d '{"subject":"oob-accept smoke","prompt":"acceptance evidence task"}' \
        "$T/v1/hives/$HIVE_ID/tasks" 2>/dev/null)"
      curl -fsS -o "$OUT_DIR/hives-2.json" --max-time 8 "$T/v1/hives" 2>/dev/null
      curl -fsS -o "$OUT_DIR/tasks.json" --max-time 8 "$T/v1/hives/$HIVE_ID/tasks" 2>/dev/null
      HIVE_BACK="$(grep -c "$HIVE_ID" "$OUT_DIR/hives-2.json" 2>/dev/null)"; HIVE_BACK="${HIVE_BACK:-0}"
      TASK_BACK="$(grep -c 'oob-accept smoke' "$OUT_DIR/tasks.json" 2>/dev/null)"; TASK_BACK="${TASK_BACK:-0}"
      if [ "$TASK_OUT" = "200" ] && [ "$HIVE_BACK" -ge 1 ] && [ "$TASK_BACK" -ge 1 ]; then
        set_result d PASS ":4800 up；hive $HIVE_ID 写入读回 ✓；task 写入读回 ✓（证据 $OUT_DIR/hives-2.json / tasks.json）"
      else
        set_result d FAIL "写读回不一致（POST task=$TASK_OUT hive回读命中=$HIVE_BACK task回读命中=$TASK_BACK）"
      fi
    fi
  fi
fi
echo "  $(mark $STATUS_d)  $NOTE_d"

# ---------------------------------------------------------------- 断言 e/f
echo ""
echo "▶ 断言 e/f：面板插件 bundle 200 + 挂载真数据 + 零 JS 错误（Playwright 探针）"
PROBE_JSON=""
PROBE_RC=99
if wanted e || wanted f; then
  # 面板候选路径：显式参数 > dump-config 推导 > 默认猜想
  CANDIDATES="$PANEL_PATHS_ARG"
  if [ -z "$CANDIDATES" ] && [ -f "$OUT_DIR/dump-config.txt" ]; then
    CANDIDATES="$(grep -oE '[a-z0-9@./-]*(team|panel)[a-z0-9@./-]*' "$OUT_DIR/dump-config.txt" \
      | grep -vi node_modules | sort -u \
      | while read -r w; do
          id="$(echo "$w" | sed 's:.*/dsh-client-::; s:@deepseek-ai/dsh-client-::; s:.*/::')"
          echo "/plugins/$id.js"
        done | sort -u | paste -sd, -)"
  fi
  if [ -z "$CANDIDATES" ]; then
    CANDIDATES="/plugins/ui-whalepod-team.js,/plugins/whalepod-team.js,/plugins/team-panel.js"
  fi
  echo "  面板候选：$CANDIDATES"
  "$NODE" "$PROBE_MJS" \
    --base-url "$BASE_URL" \
    --panel-paths "$CANDIDATES" \
    --data-text "$HIVE_NAME" \
    --screenshot "$OUT_DIR/panel.png" \
    --console-log "$OUT_DIR/console-errors.txt" \
    --timeout-ms "$UI_TIMEOUT_MS" \
    --dsh-repo "$DSH_REPO" \
    > "$OUT_DIR/probe.json" 2> "$OUT_DIR/probe.err.log"
  PROBE_RC=$?
  PROBE_JSON="$(cat "$OUT_DIR/probe.json" 2>/dev/null)"

  if [ $PROBE_RC -eq 2 ]; then
    wanted e && set_result e SKIP "playwright 不可用（$(echo "$PROBE_JSON" | "$NODE" -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(o.reason||"")' 2>/dev/null)→ 在 e2e/ 装 @playwright/test 或检查 .pnpm）"
    wanted f && set_result f SKIP "playwright 不可用，console tap 未执行"
  elif [ $PROBE_RC -ne 0 ]; then
    REASON="$(echo "$PROBE_JSON" | "$NODE" -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(o.reason||"?")' 2>/dev/null)"
    wanted e && set_result e FAIL "探针执行失败：$REASON"
    wanted f && set_result f FAIL "探针执行失败：$REASON"
  else
    # 探针完整执行 → 拆评 e / f
    PJ() { echo "$PROBE_JSON" | "$NODE" -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$1;process.stdout.write(v==null?'':String(v))"; }
    P_STATUS="$(PJ 'o.panelBundle&&o.panelBundle.status')"
    P_PATH="$(PJ 'o.panelBundle&&o.panelBundle.path')"
    P_TRIED="$(PJ 'JSON.stringify(o.panelBundle&&o.panelBundle.tried)')"
    P_DATA="$(PJ 'String(o.dataMounted)')"
    P_ERRS="$(PJ '(o.consoleErrors||[]).length')"
    P_BROWSER="$(PJ 'o.browser')"
    if wanted e; then
      if [ "$P_STATUS" = "200" ] && [ "$P_DATA" = "true" ]; then
        set_result e PASS "bundle $P_PATH 200；真数据「$HIVE_NAME」已挂载（browser=$P_BROWSER，截图 $OUT_DIR/panel.png）"
      elif [ "$P_STATUS" != "200" ]; then
        set_result e FAIL "面板 bundle 无 200（tried=$P_TRIED；alpha.5 预期红——面板尚未注册入发行包）"
      else
        set_result e FAIL "bundle $P_PATH 200 但 10s+ 未见数据文本「$HIVE_NAME」"
      fi
    fi
    if wanted f; then
      if [ "$P_ERRS" = "0" ]; then
        set_result f PASS "web UI 全程零 console.error/pageerror（browser=$P_BROWSER）"
      else
        set_result f FAIL "console/pageerror 共 $P_ERRS 条 → $OUT_DIR/console-errors.txt"
      fi
    fi
  fi
fi
echo "  $(mark $STATUS_e)  $NOTE_e"
echo "  $(mark $STATUS_f)  $NOTE_f"

# ---------------------------------------------------------------- 报告汇总
REPORT="$OUT_DIR/REPORT.md"
{
  echo "# OOB-4 开箱版全链验收报告"
  echo ""
  echo "| 项 | 值 |"
  echo "| --- | --- |"
  echo "| 时间 | $(date '+%Y-%m-%d %H:%M:%S %z') |"
  echo "| DMG | \`$DMG\` |"
  echo "| sha256 | \`$DMG_SHA\` |"
  echo "| app | $APP_NAME $APP_VER |"
  echo "| 沙盒 | \`$SB\` |"
  echo "| 主机 | $HOST_SW |"
  echo "| 起服 | $BASE_URL（健康探针：$HEALTH_NOTE） |"
  echo "| 预期红标注 | ${OOB_EXPECT_RED:-（未声明）} |"
  echo ""
  echo "## 断言判定（exit mask=$EXIT_MASK；bit0=a … bit5=f）"
  echo ""
  echo "| # | 断言 | 判定 | 证据 |"
  echo "| --- | --- | --- | --- |"
  echo "| a | honeycomb 在位 + ESM import 63 exports | $(mark "$STATUS_a") | $NOTE_a |"
  echo "| b | cordis/schemastery 单实例 | $(mark "$STATUS_b") | $NOTE_b |"
  echo "| c | profile patch 含 honeycomb 条目 | $(mark "$STATUS_c") | $NOTE_c |"
  echo "| d | :4800 transport + REST 真数据 | $(mark "$STATUS_d") | $NOTE_d |"
  echo "| e | 面板 bundle 200 + 挂载真数据 | $(mark "$STATUS_e") | $NOTE_e |"
  echo "| f | 零 JS 错误 | $(mark "$STATUS_f") | $NOTE_f |"
  echo ""
  echo "## 证据文件"
  echo "- app 启动日志：\`$LOG_APP\`"
  echo "- dump-config：\`$OUT_DIR/dump-config.txt\`"
  echo "- REST：\`$OUT_DIR/hives-*.json\` / \`$OUT_DIR/tasks.json\`"
  echo "- 探针：\`$OUT_DIR/probe.json\` / \`$OUT_DIR/probe.err.log\` / \`$OUT_DIR/panel.png\` / \`$OUT_DIR/console-errors.txt\`"
  echo ""
  echo "> 位掩码说明：exit code 为失败断言的位或（a=1,b=2,c=4,d=8,e=16,f=32）；SKIP 不置位；首启/健康前置失败以 127 返回，单实例冲突以 129 返回（均非位掩码）。"
  echo ""
  echo "## 验收官注记"
  echo "- **OOB-F1**：app DataRoot 硬编真实 home（flock singleton.lock 全局互斥），sandbox HOME 对 app 层不生效——本次运行期数据写真实 \`~/Library/Application Support/WhalePod/\`。真·全沙盒验收待 app 提供数据根环境变量 override（如 \`WHALEPOD_DATA_ROOT\`），已向 OOB-1 提请。"
  echo "- **OOB-F2**：dsh web 对任意未知路径回退 SPA \`index.html\`（本次 /health=200 但 body=<!doctype html>+__DSH_BOOT__ 注入帧，实证非真路由；源内 apps/web+packages/web grep health 零命中）——健康探针判定以上表「起服」行实测路径为准；若对外契约要宣称 /health，需 dsh web 侧补真路由（返回 JSON 健康帧）。"
} > "$REPORT"

echo ""
echo "==================================================================="
echo " 报告：$REPORT"
echo " exit mask=$EXIT_MASK（a=1 b=2 c=4 d=8 e=16 f=32；0=全绿）"
echo "==================================================================="
exit $EXIT_MASK
