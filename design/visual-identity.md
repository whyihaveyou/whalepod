# 鲸群 WhalePod 视觉识别规范 v0.2

适用范围：鲸群（WhalePod，DeepSeek Harness 桌面壳）MVP、团队面板（Team Panel）及衍生宣传物料。
本文档定义：品牌标志（app 图标）、配色系统、字体配对、深色/浅色主题 tokens。
图标源文件见 `assets/`（SVG 为主源文件，任何栅格导出均从 SVG 生成）。

> v0.2：产品定名「鲸群 WhalePod」，标志由 "W" 节点图更换为**三豚环逐**（用户以生成稿 `assets/whalepod-icon-user-ref.png` 定稿，矢量化重绘落地，源文件 `assets/whalepod-icon-final.svg`）。

---

## 1. 设计概念

WhalePod 是 DeepSeek Harness（dsh）的桌面壳：一个容纳多个 agent 协同工作的工作台（pod = 鲸群，亦呼应有壳动物的"壳"）。

标志图形是**三头鲸豚首尾相逐成环**（120° 旋转对称）：

- 三头 = 多智能体群体（pod），首尾相逐 = 消息传递与接力执行（agent loop / transport 推送）；
- 环 = 持续运转的团队工作流，弧间缺口 = 开放、可加入（spawn）；
- 白身 + 青沿（生物荧光）+ 深海蓝背三层错位叠印，亮蓝径向渐变底 = 深海。

设计原则：旋转对称、单色可还原、小尺寸不塌。标志在任何场景只用一套色（保真彩色/深底青系/纯黑模板），不做阴影、立体化。

## 2. 图标系统

### 2.1 文件清单

| 文件 | 用途 |
|---|---|
| `assets/icon-master.svg` | 主图标：macOS/iOS 风格圆角方块，蓝→紫渐变底 + 白色图形 |
| `assets/icon-dark-tile.svg` | 深底变体：深靛蓝方块 + 渐变图形，用于深色 Dock / 深色营销背景 |
| `assets/icon-mono.svg` | 单色模板：菜单栏（macOS template image）、favicon、印刷、水印 |

### 2.2 几何规范

- 画板 1024×1024；圆角方块 820×820，圆角半径 186（≈22.4%，对齐 macOS continuous corner 视觉）；
- 图形安全区：图标内容不超出方块内接的 60% 区域（当前图形宽 480、高 240，水平垂直居中）；
- 栅格导出尺寸：1024 / 512 / 256 / 128 / 64 / 32 / 16。**32px 及以下使用 mono 版**，渐变版在小尺寸会糊；
- 最小展示尺寸：16px（favicon）。低于 16px 不允许使用该标志，用文字 "DFH" 代替。

### 2.3 使用规则

- 允许：整图标等比缩放；mono 版在 UI 中绑定 `currentColor`；
- 禁止：旋转、拉伸、改圆角、改渐变角度、在图标内加文字、放置在对比度不足的杂色背景上；
- 深色背景下优先用 `icon-dark-tile`；浅色背景一律用 `icon-master`。

## 3. 配色系统

### 3.1 品牌色

| Token | 值 | 用途 |
|---|---|---|
| `brand-primary` | `#4D6BFE` | 主品牌色（DeepSeek 蓝同族）：主按钮、链接、选中态 |
| `brand-violet` | `#7A4DFF` | 渐变副色、AI/agent 相关强调 |
| `brand-gradient` | `135° #5B7CFF → #7A4DFF` | 图标底色、营销横幅，**UI 内不大面积使用** |
| `accent-spark` | `#22D3EE` | 点缀色：活跃 agent 指示、在线状态、焦点环辅助 |

中性色阶（深色/浅色共用一套灰阶基准，见主题节）。

### 3.2 语义色

| 语义 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `success` | `#16A34A` | `#4ADE80` | 任务完成、健康检查通过 |
| `warning` | `#D97706` | `#FBBF24` | 配额告警、降级状态 |
| `danger` | `#DC2626` | `#F87171` | 错误、审批拒绝 |
| `info` | `#4D6BFE` | `#8FA4FF` | 信息提示（复用品牌蓝） |

所有语义色在对应主题底色上达到 WCAG AA（正文 4.5:1，大字号/图形 3:1）。

## 4. 字体配对

| 角色 | 字体栈 | 说明 |
|---|---|---|
| UI / 正文（西文） | `Inter, -apple-system, "Segoe UI", Roboto, sans-serif` | 中性、屏显优化；macOS 上回落 SF Pro |
| UI / 正文（中文） | `"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif` | 与 Inter 混排，字号同值 |
| 展示标题 | `"Space Grotesk", Inter, sans-serif` | 仅用于营销页/空状态大标题，界面内不用 |
| 等宽（代码/日志/ID） | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace` | 终端、diff、session id、任务编号 |

字阶（1.25 比例，基准 14px）：

| Token | px / 行高 | 用途 |
|---|---|---|
| `text-xs` | 11 / 16 | 徽章、时间戳 |
| `text-sm` | 12 / 18 | 辅助说明 |
| `text-base` | 14 / 22 | 正文、列表项 |
| `text-md` | 17.5 / 26 | 面板标题 |
| `text-lg` | 22 / 30 | 页面标题 |
| `text-xl` | 27.5 / 36 | 空状态/营销大标题 |

字重：正文 400，强调 500，标题 600；不使用 300 及以下（小尺寸发虚）。

## 5. 主题系统

**默认主题：深色（dark-first）。**DFH Workstation 是长时间盯屏的 agent 工作站，出厂默认深色；浅色为可选切换主题（`data-theme="light"`）。团队面板与桌面壳共用同一默认。

### 5.1 深色主题（默认）

| Token | 值 |
|---|---|
| `bg-app` | `#0D1020` |
| `bg-surface` | `#161A2E` |
| `bg-sunken` | `#0A0D1A` |
| `text-primary` | `#E8EAF6` |
| `text-secondary` | `#9AA0BE` |
| `text-disabled` | `#565C78` |
| `border-default` | `#262B45` |
| `border-strong` | `#3A4066` |

深色下 `brand-primary` 使用亮版 `#8FA4FF` 以保证对比度；`accent-spark` 不变。

### 5.2 浅色主题（`data-theme="light"`）

| Token | 值 |
|---|---|
| `bg-app` | `#F7F8FC` |
| `bg-surface` | `#FFFFFF` |
| `bg-sunken` | `#EFF1F8`（终端、日志区） |
| `text-primary` | `#1A1D2E` |
| `text-secondary` | `#5A6072` |
| `text-disabled` | `#9BA1B5` |
| `border-default` | `#E2E5F0` |
| `border-strong` | `#C9CEDF` |

### 5.3 层级与阴影

- 浅色：`shadow-1 = 0 1px 2px rgba(26,29,46,.06)`，`shadow-2 = 0 4px 16px rgba(26,29,46,.10)`；
- 深色：不用投影表达层级，改用 `bg-surface` 与 1px `border-default` 区分；浮层加 `border-strong`；
- 圆角：控件 6px、卡片/面板 10px、模态 14px。

### 5.4 工程落地

统一 token 源在 `tokens/tokens.css`（CSS variables）与 `tokens/tokens.json`（机器可读），桌面壳与团队面板共用。`:root` 承载深色默认值，`[data-theme="light"]` 覆盖为浅色。示意：

```css
:root {                /* 深色 = 默认 */
  --brand-primary: #8FA4FF;
  --bg-app: #0D1020;
  --bg-surface: #161A2E;
  --text-primary: #E8EAF6;
}
[data-theme="light"] {
  --brand-primary: #4D6BFE;
  --bg-app: #F7F8FC;
  --bg-surface: #FFFFFF;
  --text-primary: #1A1D2E;
}
```

主题切换只翻 `data-theme` 属性，组件内禁止写死色值；新颜色必须先加 token 再使用。完整 token 清单以 `tokens/tokens.css` 为准。

## 6. 复用指引

- 桌面壳 MVP：窗口 chrome 用 `bg-app` + `bg-surface`，标题栏放 mono 版图标（`currentColor` 绑定 `text-secondary`）；
- 团队面板：每个 agent 状态点用 `accent-spark`（活跃）/ `success`（完成）/ `warning`（等待审批）/ `text-disabled`（空闲），与标志中"中央菱形=活跃 agent"的语义一致；
- 文档/网站：标题字体 Space Grotesk，标志用 master 版；深色 landing 用 dark-tile 版。
