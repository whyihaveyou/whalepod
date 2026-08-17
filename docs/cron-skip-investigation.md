# Cron 跳触发调查（8/16 20:00 无记录根因）

> 任务: #01a00db2-7298-7ef2-b57e-695c8727c9bd（【开箱版 OOB-3】Part A 主）
> 调查时间: 2026-08-17（事件次日，Asia/Shanghai）
> 调查人: Flash-1
> 关联: alpha.6 守门预备 — Part B（装机实例 honeycomb 可 import）见 §5

---

## 1. 现象（Leader 简报）

- cron job `cron_01a0049e-3772-7440-8415-894d459df53a`（"鲸群每日发版检查（一天一更新·双档）"）
- schedule: `0 20 * * *` Asia/Shanghai（每天 20:00）
- 8/15 20:00 触发 → 最终成功于 8/15 20:29:29（用了 29 min retry/buffer）
- **8/16 20:00 触发 → 完全无触发记录**，`next_run_at` 直接跳到 8/17 20:00
- 8/17 20:00 是否会正常触发未知（调查时未到时间）

Leader 派的三条调查方向：
1. AionUi cron scheduler 的 `next_run` 计算逻辑（`last_status=skipped` 是否导致跳过下一天？8/15 的 skipped 是发版后拦的还是调度器自判？）
2. scheduler 日志（AionUi app 日志路径）
3. 是否存在「job 已在别处执行」互斥逻辑误判

---

## 2. 数据收集

### 2.1 AionUi 日志路径

| 路径 | 用途 |
|---|---|
| `/Users/qzp/Library/Logs/AionUi/2026/08/<日期>/<日期>.aioncore.log` | aioncore cron 调度器日志（Rust `aionui_cron::executor` target） |

### 2.2 8/16 log 关键时序（行号 43539-43707）

```
12:00:02.103Z = 8/16 20:00:02 +0800   target="aionui_cron::executor"
  "Cron target conversation already has an active turn; scheduling retry"
  job_id=cron_01a0049e-...  conversation_id=ec5ae463
  attempt:1, max_retries:3, last_error:"Conversation already has an active turn"

12:00:32.112Z = 8/16 20:00:32   target="aionui_cron::executor"
  "Cron target conversation already has an active turn; scheduling retry"
  attempt:1, max_retries:3
  然后紧接 attempt:2, max_retries:3

12:01:02.120Z = 8/16 20:01:02   target="aionui_cron::executor"
  "Cron target conversation already has an active turn; scheduling retry"
  attempt:2, max_retries:3
  然后紧接 attempt:3, max_retries:3

12:01:32.128Z = 8/16 20:01:32   target="aionui_cron::executor"
  [MAX_RETRIES_EXCEEDED] skipping
  job_id=cron_01a0049e-...  conversation_id=ec5ae463
  attempt:3, max_retries:3
```

### 2.3 8/15 log 关键时序（行号 902600-902666）

```
12:29:29.005Z = 8/15 20:29:29   target="aionui_team::runtime"
  "team conversation turn claim released" turn_id=turn_a72278c4
  elapsed_ms=1768601  (= 29 min 28 s)

12:29:29.010Z = 8/15 20:29:29
  "team conversation turn retrying after active conversation turn released"
  team_run_id=01a0054e-...

12:29:29.010Z = 8/15 20:29:29
  "conversation runtime turn claimed" turn_id=turn_bccb7dfc

12:29:29.011Z = 8/15 20:29:29   target="aionui_cron::executor"
  "Cron job message sent successfully"
  job_id=cron_01a0049e-...  conversation_id=ec5ae463
```

> 注: 8/15 20:00 触发时刻 ~12:00 UTC 与 20:29:29 成功时刻之间**没有** "Cron target conversation already has an active turn" 的 retry chain log。

### 2.4 aioncore CLI 当前状态（通过 `config cron jobs list`）

```json
"state": {
  "next_run_at_ms": 1786968000000,   // = 2026-08-17 20:00:00 +0800
  "last_run_at_ms": 1786796969011,   // = 2026-08-15 20:29:29 +0800（不是 8/16！）
  "last_status": "skipped",
  "run_count": 1,
  "retry_count": 0,
  "max_retries": 3,
  "queue_enabled": false
}
"metadata": {
  "conversation_id": "ec5ae463",
  "conversation_title": "Aion CLI",
  ...
  "created_at": 1786783872881,    // = 2026-08-15 16:51:12 +0800
  "updated_at": 1786881692128     // = 2026-08-16 20:01:32 +0800  ← 精确对应 [MAX_RETRIES_EXCEEDED] 行
}
```

---

## 3. 时间线（关键事件）

| 时间 (UTC+8) | 事件 | 证据 |
|---|---|---|
| 2026-08-15 16:51:12 | cron job 创建（Flash-1 当天早上设） | `created_at` |
| 2026-08-15 ~19:59:30 | Leader 端 turn_a72278c4 开始（用户/Leader 之前的对话持续到 20:29:29） | elapsed_ms 反推 |
| 2026-08-15 20:00:00 | cron 应触发 — 当时 conversation busy | schedule expr |
| 2026-08-15 20:29:29 | turn_a72278c4 释放（29 min runtime） | log 902661 |
| 2026-08-15 20:29:29 | "team conversation turn retrying after active conversation turn released" | log 902664 |
| 2026-08-15 20:29:29 | cron message 最终发出（成功） | log 902666 |
| 2026-08-16 ~19:59:?? | Leader 端某个长 turn 进行中（具体 turn 未在 8/16 log 体现） | 推断 |
| 2026-08-16 20:00:02 | cron 触发，attempt:1，被 active-turn 互斥拒绝 | log 43539 |
| 2026-08-16 20:00:32 | attempt:2，仍 busy | log 43568 |
| 2026-08-16 20:01:02 | attempt:3，仍 busy | log 43641 |
| **2026-08-16 20:01:32** | **max_retries exceeded → skipping** | **log 43707** |
| 2026-08-16 20:01:32 | DB 写回: last_status=skipped, next_run=8/17 20:00 | `updated_at` 字段 |
| 2026-08-16 20:12:40 | Flash-1 调查（cron get API 调用，本身无副作用） | log 44406 |
| 2026-08-17 20:00:00 | next_run 预期触发（待验证） | `next_run_at_ms` |

---

## 4. 根因分析

### 4.1 最可能根因（高置信度）

**调度器在 max_retries=3 全部失败后，将 `last_status` 置为 `skipped` 并把 `next_run_at_ms` 重算为下一个符合 cron 表达式的时刻（`0 20 * * *` → 8/17 20:00:00），完全跳过 8/16 当天后续时间窗口。**

证据链:
1. log 43539 / 43568 / 43641 完整 retry 链（3 次 × 30s = 90s 全部 busy）
2. log 43707 `updated_at=2026-08-16T12:01:32.128Z` 写入 `last_status=skipped`
3. DB 读 `state.next_run_at_ms=1786968000000` = 8/17 20:00:00（不是 8/16 20:01:32 + 30s 的下一个 retry slot，而是 24h 后）
4. `retry_count=0` 表示下一次触发会重新计数（不是从第 4 次开始）

**Leader 假设 ① 完全成立**: `last_status=skipped` 直接把 next_run 推到下一个 cron fire 窗口（24h 后），不补发当天跳过的触发。

### 4.2 「8/15 vs 8/16」差异之谜（中置信度）

8/15 与 8/16 的触发场景几乎相同（Leader conversation busy），但 8/15 在 29 min 后成功，8/16 完全 skip。最可能的解释：

**8/15 走的是「conversation 释放后补发」路径**（log 902664 "team conversation turn retrying after active conversation turn released" 紧跟着 cron success），而 **8/16 调度器在 max_retries 用尽后没有触发同样的补发 watcher**。

可能的子原因:
- 8/15 时刻的 Leader turn_a72278c4 是"自然完成"（用户最终发消息或 turn 自然结束），释放事件被 team runtime 监听到
- 8/16 时刻的 busy 来源是 cron retry 自身反复 send-message 试图占用 conversation（attempt:1/2/3 每次失败也占据 runtime 的「busy」状态），导致 conversation **从未真正空闲过** —— retry 在 attempt 1-2 失败的窗口内 conversation 一直被标 busy，attempt 3 失败后调度器立刻跳到 skip，而 team runtime 没有监听到"真正空闲"
- 8/15 重试期间没有"自身持续占位"的副作用，所以 conversation 在 20:29 turn 释放时能干净进入「released」事件

**此为次要观察**，对根因结论无影响 —— 根因仍是 `skipped → next_run = next cron fire`。

### 4.3 Leader 假设 ③（"job 已在别处执行"互斥误判）

**部分成立，但不是主因。**

实际互斥逻辑是「conversation 已有 active turn」（不是"job 已在别处执行"）:
- log 信息: `last_error:"Conversation already has an active turn"`
- 拒绝条件: `conversation_id=ec5ae463` 存在未关闭的 turn
- 不是"同 job_id 在另一进程跑"的互斥

### 4.4 Leader 假设 ②（8/15 的 skipped 是发版后拦的还是调度器自判）

**是调度器自判，不是发版后拦的。**

证据:
- 8/15 20:29:29 的 cron message 是 **sent successfully**（不是 skipped）
- 8/15 的 `last_status` 在当前 DB 里也是 `skipped`（但 `last_run_at_ms` 指向 8/15 20:29:29，不是 8/16）
- 也就是说，8/15 的成功被后续 8/16 的 skip **覆盖** 写入 — `last_status` 字段反映的是**最近一次**的 trigger 结果
- `last_run_at_ms` 是 cron 实际投递时间（8/15 20:29:29），不会被 skip 更新

> 字段语义表:
> | 字段 | 含义 |
> |---|---|
> | `last_run_at_ms` | 上次**实际投递**时间（成功/失败都更新）|
> | `last_status` | 上次 trigger 终态（success/skipped/error）|
> | `next_run_at_ms` | 下次按 cron expr 算的 fire 时刻 |
> | `updated_at` | DB row 最后修改时间（任何字段写都更新）|

---

## 5. 规避方案

### 5.1 短期（立即可执行）— 错峰 + 手动 touch 重置

把 cron 触发时刻往后挪 1 小时到 21:00，避开 20:00-20:30 的"发版时段高 active turn 概率"窗口：

```bash
AIONCORE="/Applications/AionUi.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore"
"$AIONCORE" config cron jobs update cron_01a0049e-3772-7440-8415-894d459df53a <<'JSON'
{
  "job_id": "cron_01a0049e-3772-7440-8415-894d459df53a",
  "schedule": "0 21 * * *",
  "schedule_description": "每天 21:00（Asia/Shanghai）"
}
JSON
```

**副作用评估**:
- 21:00 时 Leader 通常已结束当日 work conversation，conversation busy 概率显著下降
- 21:00 触发后若仍 busy，至少 retry 90s 后 conversation 自然空闲的概率高（user/Leader 不太可能 21:00 还在密集对话）
- 下次 8/17 21:00 即可验证

### 5.2 中期（监控 + 应急通道）— daily-touch 防 skip

每天 19:55 由 Leader 或 cron 自身触发一次 `touch`（update 一个无害字段如 `schedule_description` 文本），强制 scheduler 重算 `next_run_at_ms`，让 8/16 20:00 的 skipped 状态在 19:55 被新一次 update 覆盖之前不会出现：

> **不建议**: 19:55 的 touch 本身如果触发 update → DB 写 → next_run 重算，但 20:00 触发的 skip 仍会覆盖。需要的是 19:55:00 重算后，20:00:00 触发时直接成功不 skip，而不是事后 touch。

**真正可用的方案**: 19:55 主动 ping Leader conversation 让其在 cron 触发前完成任何 active turn，确保 20:00 时 conversation idle。

### 5.3 长期（报上游）— AionUi cron 调度器改进

向 AionUi 上游（iBuilder/AionUi GitHub repo）报 issue:

> **Title**: `last_status=skipped` causes `next_run_at_ms` to jump to next cron fire (24h later), losing the entire day's trigger
>
> **Body**:
> When a cron job's target conversation is busy and max_retries=3 is exhausted within 90s, the scheduler marks `last_status=skipped` and recomputes `next_run_at_ms` as the next cron expression match (next day 20:00 for `0 20 * * *`). This effectively swallows the day's trigger.
>
> **Expected**: Either
> 1. Continue retrying on conversation-busy at exponentially increasing intervals (1m, 5m, 30m) up to the next cron fire, OR
> 2. Register a "conversation released" watcher that re-attempts the skipped trigger when the conversation becomes free, similar to the `team conversation turn retrying after active conversation turn released` event already in the team runtime.
>
> **Reproduction**: Set `0 20 * * *` Asia/Shanghai cron with target conversation. Hold a 30+ min turn in that conversation starting at 19:59. Observe 3 retry attempts at 20:00:02/20:00:32/20:01:02, then [MAX_RETRIES_EXCEEDED], then no more triggers for the day.

---

## 6. 立刻执行（本次决策） — 已落地

- ✅ **采纳方案 5.1（schedule → `0 21 * * *`）** 作为本次规避，**已执行**
- 执行时间: 2026-08-17 11:21:38 +0800
- 执行结果（aioncore CLI `config cron jobs list` 验证）:

| 字段 | 旧值 | 新值 |
|---|---|---|
| `schedule.expr` | `0 20 * * *` | `0 21 * * *` |
| `schedule.description` | `每天 20:00（Asia/Shanghai）` | `每天 21:00（Asia/Shanghai）` |
| `state.next_run_at_ms` | 2026-08-17 20:00:00 | **2026-08-17 21:00:00** |
| `metadata.updated_at` | 2026-08-16 20:01:32（skip 时刻）| **2026-08-17 11:21:38** |
| `state.last_status` | `skipped`（保留直到下次成功）| `skipped`（保留直到下次成功）|
| `state.retry_count` | 0 | 0 |

执行命令:

```bash
AIONCORE="/Applications/AionUi.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore"
"$AIONCORE" config cron jobs update <<'JSON'
{
  "job_id": "cron_01a0049e-3772-7440-8415-894d459df53a",
  "schedule": {
    "kind": "cron",
    "expr": "0 21 * * *",
    "tz": "Asia/Shanghai",
    "description": "每天 21:00（Asia/Shanghai）"
  }
}
JSON
```

> ⚠️ 字段结构坑: `update` payload 里 `schedule` 必须是嵌套结构 `{kind, expr, tz, description}`，**不是字符串 `"0 21 * * *"`**。后者会被 backend 返回 400。

后续:
- ⏳ 监控 **8/17 21:00** 是否正常触发（预期成功，Leader conversation 此时 idle 概率高）
- ⏳ 若 8/17 21:00 仍 busy + skipped，考虑写上游 issue（长期方案 5.3）

---

## 7. 关联

- **Part B（alpha.6 守门判据 10）**: 见 `docs/alpha6-guarding-criteria.md`（装机实例内 honeycomb 可 import/插件已注册）
- **alpha.4 守门 7/7 PASS**: 见 `project-alpha4-milestone.md`（memory）
- **alpha.5 守门 9 判据**: 见 `project-release-version-injection-appcast.md` §守门判据全表
- **任务跟踪**: Task #01a00db2-7298-7ef2-b57e-695c8727c9bd