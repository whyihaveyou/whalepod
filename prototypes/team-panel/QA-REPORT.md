# 团队面板视觉 QA 报告

> 日期：2026-08-14 · QA：视觉-K3-2 · 任务：#01a000cd
> 对象：`prototypes/team-panel/`（React + TS + Vite）
> 基准：`design/components/`（8 份组件规范）+ `design/tokens/tokens.css`
> 结论：**50 项偏差，47 项已修复并验证 build 绿**；3 项留作规范侧跟进（见 §4）。

## 1. Token 核对（全部通过）

- 旧 `--dfh-*` 命名残留：**0**。
- 硬编码色值：修复后**为 0**（`#fff` → `var(--text-on-accent)`；派生透明色统一 `color-mix(in srgb, var(--status-x) 15%, transparent)`；mockData 中的 `#019ffff4` 等是任务 ID，非色值）。
- `src/styles/tokens.css` 与权威源 `design/tokens/tokens.css` **逐字节一致**（diff 验证）。
- 低于字阶下限的 9/10px 字号全部提升至 `--text-xs`（11px）。

## 2. 修复摘要（按严重度）

### P0（4 项，全修）

| 项 | 修复 |
|---|---|
| 全局无焦点环 | global.css 加 `:focus-visible` 规则（2px accent + 1px offset） |
| RosterList 非法嵌套 button | 条目改 `div[role=button]` + 键盘 Enter/Space；重启改真 IconButton（danger 变体 + aria-label） |
| 断连态整体缺失 | 全链路实现：状态栏红点+文案、顶部 danger 内联条[立即重试]、内容区 60% 透明只读、Composer 禁用、断连 assertive / 恢复 polite 各播报一次；StatusBar 连接钮可点击模拟断连（演示入口） |
| Toast 系统缺失 | 新建 `common/Toast.tsx`（pushToast + ToastHost）：状态色条、叠 3 条、danger 手动关+Esc、role=alert/status；接入 spawn 失败[重试]与 shutdown 被拒[查看对话] |

### P1（19 项，全修）

- **状态色**：working 从绿色（done）改回 `--status-active` 青色；呼吸动画改为规范版（opacity 1↔0.45，1.6s，无写死颜色）；列头按列语义着色。
- **Composer**：@提及补 listbox 语义 + Esc 关闭 + Backspace 整删 chip；广播四修正（二次确认按钮变形 / Esc 退出 / 开广播即时清 chip / 容器整体描边）；placeholder "全队 N 人" 插值 bug 修复；textarea aria-label + 1–6 行自动增高 + 边框收到容器。
- **ShutdownModal**：L2（等待确认，primary 普通点击）与 L3（强制：首词输入 + 长按 1s + danger + dismissable=false）正确分层；补状态摘要行与进行中任务警告；等待态按规范落回 roster 条目[取消] + 详情顶部等待条（非模态内联）。
- **Modal 壳**：L3 初始焦点落取消钮；统一 ⌘↵ 主操作；aria-labelledby；背景 inert。
- **AgentDetail**：补 `<dl>` 字段区（角色/模型/状态+时长/slot 截断+复制）、时长 >2h 变 warn、failed 内联重启条、可点击当前任务、[分配任务] 迷你表单、头部[对话]。
- **TaskDetail**：补描述/创建于区块、依赖 chip 可点跳卡、动态区 aria-live + 稳定 key。
- **TaskCard/Board**：⌘↑/⌘↓ 键盘跨列移动 + aria-grabbed/dropeffect；aria-label 按规范模板；空列 [+ 添加] 虚线按钮；列表 ↑/↓ + ↵ 键盘导航。
- **控件**：Button sm 28px / pressed scale(.97) / aria-busy；IconButton 28×28 + danger 变体；SegmentedControl 改 radiogroup + roving tabindex；TextInput errorText（role=alert + aria-invalid）+ SearchInput aria-label。
- **其他**：NavRail 数字角标改未读点 + 折叠按钮接上；ChatPane 头部复用 StatusBadge、失败气泡 [重发]、offline warn 内联条；SpawnModal 乐观提交 + 重名内联校验 + 失败回填；ActivityView 骨架屏；全局 `prefers-reduced-motion` 归零兜底。

### P2（24 项，全修）

任务 id 统一截断前 8 位、阻塞卡整卡 warn 描边、dragging 阴影+虚线占位、pending outline 虚线描边、offline "（已断连）"后缀、logo 去 filter 硬翻转（新增白色版 icon-mono-light.svg）、图标归 16px、chip 规格、空态回显关键词+[清除筛选]、CommandPalette 遮罩可关+listbox 语义+状态中文文案等。

## 3. 验证

- `npm run build`（tsc + vite）：**通过**。
- 抽查复核：焦点环 / reduced-motion / 呼吸动画规格 / tone 映射 / aria-busy / radiogroup / tokens.css 一致性，均确认到位。

## 4. 规范侧跟进项（不属实现问题）

1. **模态圆角矛盾**：modals.md 原写 `--radius-lg`，token 统一时 K3-1 新增模态专用 `--radius-xl`（14px）。已修订 modals.md（视觉-K3-2），实现用 xl 为正确。
2. ~~**`--status-idle` 对比度**~~ **已闭环**（见 §6）：K3-1 裁决 idle/offline 点改专用灰（dark #6E7692 / light #8A90A6），状态文字一律 text-secondary。
3. **TaskEvent 无 id 字段**：动态区 key 用 `ts-actor-action` 复合键过渡；接真实数据层时应给事件加 id。

## 5. 遗留说明（原型边界，非缺陷）

- 断连为前端演示态（useRoster 内 state），接真实 API 时应由 websocket 状态驱动。
- Toast 与模态 Esc 并发时同关最顶 toast，原型可接受。
- ⌘↵ 在 ShutdownModal 强制模式点的是长按按钮，plain click 不触发长按逻辑（安全行为）。

## 6. 复核记录（2026-08-14 第二轮，idle token 封版后）

**结论：K3-1 的 idle 裁决全部达标，prototype 已同步并扩展修复了一轮系统性对比度问题。build 绿。**

- token 同步：`src/styles/tokens.css` 已拉最新（diff 逐字节一致）。
- 新值验证（WCAG 计算）：idle/offline 点 dark #6E7692 在三档表面上 3.72–4.2:1（图形 ≥3:1 ✓），light #8A90A6 3.17:1 ✓。
- **新发现并已修**：
  1. `text-disabled`（dark 2.5–2.9:1）被 ~28 处用作**正文级** meta 文字（时间戳、事件时间、系统条、任务 id、空态文案、提及角色等）。已全部改 `text-secondary`（dark 6.5–7.3:1 ✓ / light 6.3:1 ✓）；保留豁免：4 处 `::placeholder`、2 处装饰图标、1 处分隔符"·"。
  2. `.sub-spawning` 用 `--status-progress`（#7A4DFF，dark 仅 3.5:1）做文字，不达 AA。文字改 secondary，violet 语义由弹跳点图形承担（图形 3.5:1 ≥ 3:1 ✓）。
  3. `.sub-idle` / `.sub-offline` / `.sub-duration` 同步改为 secondary（K3-1 "状态文字不用 disabled 色"规则落地）。
- **给 token owner 的建议**：若希望恢复三级文字层次，建议新增 `--text-tertiary`（dark 约 #7E86A0，卡 4.5:1 线）替代现在混用 disabled 的场景；当前一律 secondary 是安全但层次较平的方案。
- **已落地（第三轮）**：`--text-tertiary` 封版（dark #7E86A0 ~4.9:1 / light #6B7280 ~4.8:1）后，prototype 已同步 token 并把 18 处弱层级 meta 文字（时间戳、系统条、任务 id、时长、提及角色、各类 hint）从 secondary 换到 tertiary，层次恢复且全部 ≥4.5:1。空态正文、区块标签、可交互控件保持 secondary。build 绿。
