# 空 / 加载 / 错误 / 断连态

四类兜底状态。原则（承 interaction-spec §4）：**不用空洞的 "No data"，每个空态给下一步动作；加载用骨架不用整页 spinner；错误就近内联，不打断用 toast 层级区分。**

## EmptyState（空态）

### 解剖

```
        ┌────────┐
        │ 插图位  │   ← 96×96px，icon-mono 风格线性插画，--text-disabled 色
        └────────┘
       一句话标题          ← --text-base, text-secondary
       [主按钮]（可选）     ← primary md
```

垂直水平居中于所在面板；元素间距 12px。

### 场景绑定

| 场景 | 标题 | CTA |
|---|---|---|
| 团队为空 | "团队还没有成员" | `[+ Spawn 第一个成员]` primary → Spawn 模态 |
| 任务板为空 | 三列骨架保留，PENDING 列内嵌本组件："拖入或新建任务" | `[+ 新建任务]` secondary（`⌘N`） |
| 对话为空 | 消息区顶部系统条："这是与 {name} 的对话起点"（非居中插图，用系统条，输入框自动聚焦） | — |
| 筛选无结果 | "没有匹配「{关键词}」的成员" | `[清除筛选]` ghost |
| 活动流为空 | "还没有任何活动" | — |

### 可访问性

- 插图 `aria-hidden`；标题用普通文本即可（空态不抢焦点）。

---

## LoadingState（加载）

| 场景 | 形式 |
|---|---|
| 列表加载（roster/任务/活动） | 骨架屏 3 条：条目形状灰块（bg `--bg-elevated`，radius-md），明暗呼吸（opacity .6↔1，1.2s）；尺寸与真实条目一致（48px 高）防跳动 |
| 详情面板加载 | 字段行骨架（label 72px 灰条 + 值灰条），3–4 行 |
| spawning（agent 上线中） | 三点弹跳动画（`--status-progress` 色），复用 StatusBadge 的 spawning 变体 |
| typing（agent 生成中） | 三点渐隐渐显，内联在消息流底部，不打断滚动 |
| 模态提交中 | 主按钮 loading 态（见 buttons.md），禁止整模态 spinner |

骨架屏 `aria-hidden="true"` + 容器 `aria-busy="true"`、`aria-label="加载中"`。

---

## ErrorState（错误）

按影响面分级：

| 级别 | 形式 | 用于 |
|---|---|---|
| 字段级 | TextInput error 态 + 下方 12px danger 文案 | 表单校验（重名、必填） |
| 区块级 | 内联警告条：h 36px，bg `{status}-subtle`，左侧 3px 状态色条 + 图标 + 文字 + 操作按钮（ghost sm） | spawn 失败回填、对方 offline 提示、shutdown 等待条 |
| 全局级 | toast：右上滑入，bg `--bg-elevated` + border-strong + `--shadow-popover`，左侧 3px 状态色条，max-w 360px，5s 自动消失（danger 不自动消失，需手动关） | spawn 失败、shutdown 被拒、任务操作失败 |

- toast 叠放最多 3 条，新条顶入旧条下移；hover 暂停计时；
- 所有错误给**下一步**：重试按钮 / 跳转链接 / 错误码（mono，可复制）。

可访问性：toast `role="alert"`（danger）/ `role="status"`（其余）；不自动消失的 toast 必须可键盘关闭（`Esc` 或关闭按钮）。

---

## DisconnectedState（断连态）

触发：与团队运行时的连接断开（轮询/推送失败持续 3s 以上）。

- **状态栏**：连接点变 `--status-danger` + 文字"连接已断开，重连中…"；重连成功恢复 `● 已连接`（active 色）并短暂显示 2s；
- **全面板**：内容区透明度降至 60% + `pointer-events: none`（只读浏览保留滚动），顶部出现全宽内联条（danger）："连接已断开，正在每 5s 重试 · [立即重试]"；
- **Composer**：禁用，placeholder 变"连接已断开"；
- **恢复**：内容透明度 160ms 回 1，内联条收起；断连期间积压的状态变更一次性应用（单条目过渡，不整列表重渲染）。

可访问性：断连与恢复各播报一次（`aria-live="assertive"` / `polite`），不重复播报每次重试。
