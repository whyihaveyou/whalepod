# Team Panel — Token 使用规范

> **唯一 token 源已收敛至 [`../tokens/tokens.css`](../tokens/tokens.css) + [`../tokens/tokens.json`](../tokens/tokens.json)**（桌面壳与团队面板共用，暗色默认）。
> 本文档不再定义独立色值，只说明团队面板如何消费统一 token。历史 `--dfh-*` 占位值已全部替换。

---

## 1. 旧占位 → 正式 token 映射

| 旧占位（v0.1 草稿） | 正式 token | 说明 |
|---|---|---|
| `--dfh-accent` `#4C8DFF` | `--accent` → `--brand-primary`（dark `#8FA4FF` / light `#4D6BFE`） | 品牌蓝替换占位蓝 |
| `--dfh-bg-app / pane / elevated` | `--bg-app / --bg-surface / --bg-elevated` | 对齐 visual-identity 主题表面；`bg-elevated` 为面板扩展项，已并入统一源 |
| `--dfh-text-*` | `--text-primary / secondary / disabled` | 直接对应 |
| `--dfh-border-*` | `--border-default / strong` | 直接对应 |
| `--dfh-status-active` 绿 `#34C77B` | `--status-active` = `--accent-spark` `#22D3EE` | **语义变更**：活跃 agent 用火花青，呼应标志"中央菱形=活跃 agent" |
| `--dfh-status-done` 蓝 | `--status-done` = `--success`（dark `#4ADE80`） | **语义变更**：完成改用语义绿 |
| `--dfh-status-progress` 紫 `#B48CF2` | `--status-progress` = `--brand-violet` `#7A4DFF` | 用品牌紫，不再自造色 |
| `--dfh-status-warn / danger` | `--status-warn` = `--warning`；`--status-danger` = `--danger` | 值换成 visual-identity 语义色（dark `#FBBF24` / `#F87171`） |
| `--dfh-font-ui / mono` | `--font-ui / --font-mono` | Inter + PingFang SC；JetBrains Mono 优先 |
| `--dfh-text-*` 字阶（基准 13px） | `--text-xs…xl`（基准 **14px**，1.25 比例） | **基准上调 1px**；密集列表副行用 `--text-sm`(12px)，正文/主行用 `--text-base`(14px) |
| `--dfh-radius-sm/md/lg` | `--radius-sm/md/lg/xl` | 增加 `--radius-xl` 14px（模态） |
| `--dfh-shadow-*` | `--shadow-1 / popover / modal` | 暗色不投影分层，浮层靠 `border-strong` |
| `--dfh-space-* / --dfh-duration-* / 结构尺寸` | `--space-* / --duration-* / --titlebar-h` 等 | 原样并入统一源，无值变化 |

## 2. 状态语义速查（团队面板全局一致）

| 场景 | Token | Dark 值 | 形态 |
|---|---|---|---|
| agent working / 任务 in_progress | `--status-active` | `#22D3EE` | 实心点 + 呼吸动画 |
| agent idle | `--status-idle` | `#6E7692` | 实心灰点 |
| agent offline | `--status-offline` | `#6E7692` | **空心**点（形状区分 idle） |
| agent failed / 错误 | `--status-danger` | `#F87171` | 实心点 + 吸顶排序 |
| agent spawning / typing | `--status-progress` | `#7A4DFF` | 三点 loading |
| 任务 pending | `--status-pending` | `#9AA0BE` | 空心点 / 虚线描边 |
| 任务 completed | `--status-done` | `#4ADE80` | ✓ |
| 任务 blocked / 等待审批 | `--status-warn` | `#FBBF24` | ⛔ + 卡片警告描边 |

徽章底色 = 对应状态色 15% 透明度（`color-mix(in srgb, var(--status-*) 15%, transparent)`）。

> **状态文字规则（QA 修订）**：状态点/图形用 `--status-*`；状态**文字**一律用 `--text-secondary` 或更亮，禁用 `--text-disabled` 做状态文字（#565C78 在 bg-surface 上仅 ~2.7:1，不达 4.5:1）。时间戳/系统条/id 等 meta 文字可用 `--text-tertiary`（卡 AA 4.5:1 下限，恢复三级层次）。

## 3. 组件级速查（已全部指向统一 token）

| 组件 | 关键 token 组合 |
|---|---|
| 主按钮 | bg=`--accent-fill`（两主题同 `#4D6BFE`，暗色不用亮版填充——白字对比度仅 ~2.3:1），text=`--text-on-accent`，hover=`--accent-fill-hover`，radius-md，h=`--input-h`，padding `0 --space-3` |
| 次按钮 | bg=transparent，border=`--border-default`，text=`--text-primary` |
| 危险按钮 | border/text=`--status-danger`；hover 填充 danger 15% 底 |
| 列表条目（选中） | bg=`--accent-subtle` + 左侧 2px `--accent` 指示条 |
| 任务卡 | bg=`--bg-elevated`，border=`--border-default`，radius-lg；阻塞卡 border=`--status-warn` |
| 消息气泡（用户） | bg=`--accent-subtle`，radius-lg，右对齐 |
| 消息气泡（agent） | bg=`--bg-elevated`，radius-lg，左对齐 |
| 系统条 | 全宽、`--text-xs`、`--text-secondary`、居中、上下 1px `--border-default` |
| 输入框 | bg=`--bg-sunken`，border=`--border-default` → focus: border=`--accent` + 2px `--accent-subtle` 外发光 |
| toast | bg=`--bg-elevated`，border=`--border-strong`，`--shadow-popover`，左侧 3px 状态色条 |
| 模态 | bg=`--bg-surface`，radius-xl，`--shadow-modal`，遮罩 `--bg-overlay` |

## 4. 主题行为

- 默认暗色（dark-first，与桌面壳一致）；`data-theme="light"` 切浅色，无需组件改码。
- working 呼吸动画、spawning/typing loading、拖拽弹性均受 `prefers-reduced-motion` 约束（统一源已内置时长归零）。
- 对比度沿用 visual-identity 的 WCAG AA 保证；面板内新增组合若超出既有配对，先回统一源加 token。

> 变更记录见 [`../CHANGELOG.md`](../CHANGELOG.md)。
