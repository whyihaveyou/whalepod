# OOBE-M1 首启向导视觉规范（Provider Picker + API key）

> 版本：v1.1（K3-2 复核修订：输入框高度对齐 --input-h、S1 单选语义 radiogroup 化、强制 dark 加护栏） · 作者：视觉-K3-1 · 任务：#01a00113 · 复核：视觉-K3-2
> 依据：`docs/shell-oobe-proposal.md`（Flash-1 定稿，M1 = R1 WKUserScript 注入 Provider Picker + Credentials 写入）；Provider Picker 形态参考 `refs/dsh-desktop` 的 `patches/@deepseek-ai+dsh-client-ui-settings-models+0.1.0-rc.6.patch`。
> token 源：`../tokens/tokens.css`（暗色优先）。本规范**未新增 token**，全部元素绑定现有 token；无硬编码色值。
> 一致性：与 `shell-visual-spec.md`（壳 chrome）、`../team-panel/`（组件规范）同源。

---

## 1. 流程总览

```
首启
  │
  ▼
S0 启动与运行时检测（原生覆盖层，R2 兜底）
  │  检测运行时 →（缺运行时且走 fallback C）→ 安装进度 →（失败）→ 错误+重试
  ▼  harness Web UI ready
S1 供应商选择 Provider Picker（R1：注入 harness 设置-模型页）
  │  检测到无已配置模型时自动展开引导态
  ▼
S2 填写 API key（R1 注入表单）
  │  校验 → 写 harness Credentials（loopback）→ 自动建 provider route
  ▼
S3 完成 → 进入 harness 主界面（注入层自清理）
```

原则：**无落地页、就绪即进 harness**（proposal §②）。S0 复用现有壳三态覆盖层；S1/S2 是注入进 harness 页面 DOM 的引导组件，视觉上必须读起来像"产品的一部分"，不是外挂弹窗。

## 2. S0 — 启动与运行时检测（原生覆盖层）

完全沿用 `shell-visual-spec.md` §5/§6 的三态覆盖层，OOBE 仅增加**进度变体**：

```
│                ┌────────┐                       │
│                │ 图标    │  icon-dark-tile 96px   │
│                └────────┘                       │
│                  ⣿ spinner（starting 语义 violet）│
│            正在准备运行环境…           13px secondary │
│     ━━━━━━━━━━░░░░░░░░░░  42%      进度条（见下）  │
│        下载 dsh 运行时（12.3 / 28.9 MB） mono 12 tertiary│
```

| 状态 | 视觉 |
|---|---|
| 检测中 | 现有 starting 态不变（spinner + "正在启动服务…"） |
| 安装中（fallback C） | spinner 换**进度条**：轨道 4px 高、宽 240px、bg `--bg-elevated`、圆角 `--radius-full`；填充 `--accent-spark`、圆角同轨道；下方 mono 12px `--text-tertiary` 显示量值 |
| 安装失败 | 现有错误页结构：标题 "⚠ 运行环境准备失败" + 说明 + primary「重试」+ bordered「手动配置…」（点开后显示 `ServiceConfig` 手动命令指引文案，仅文案不新增界面） |
| 无网/无 node | 同上错误页，说明文案给出手动准备链接占位 |

进度不确定时（下载无法取总量）退化为 spinner，不要假进度。

## 3. S1 — 供应商选择（Provider Picker，注入层）

形态以 dsh-desktop patch 为蓝本，token 换绑到我们的体系：

```
┌── harness 设置·模型页（空模型态自动展开） ──────────────┐
│  添加 API key 开始使用                     17.5px/600 primary │ ← --text-md
│  选择一个模型供应商并填入它的 API key。      13px secondary    │ ← --text-base
│  DSH 会自动启用该供应商的内置模型目录。                          │
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │ 🔍 搜索供应商…                       │  搜索框 h32         │
│  └──────────────────────────────────────────┘               │
│  ┌───────────────────┐ ┌───────────────────┐                │
│  │ DeepSeek 官方      │ │ OpenAI            │  卡片网格 2 列   │
│  │ deepseek-official  │ │ openai            │                │
│  └───────────────────┘ └───────────────────┘                │
│  ┌───────────────────┐ ┌───────────────────┐                │
│  │ Anthropic         │ │ Google            │                │
│  │ anthropic         │ │ google            │                │
│  └───────────────────┘ └───────────────────┘                │
│  …（按优先级排序：deepseek-official/deepseek/openai/          │
│     anthropic/google/openrouter/xai/moonshot…）              │
└──────────────────────────────────────────────────────────────┘
```

### 组件与 token 绑定

| 元素 | 规格 | token |
|---|---|---|
| 引导标题 | 17.5px/26 / 600 | `--text-md` + `--text-primary` |
| 引导说明 | 14px/22 | `--text-base` + `--text-secondary`（两行内） |
| 搜索框 | h32（`--input-h`，与全局输入框同档——不引入第三档密度），bg `--bg-sunken`，border `--border-default`，radius `--radius-md`，14px；placeholder `--text-disabled`；focus border `--accent` + 外发光 `0 0 0 2px --accent-subtle` | 同 team-panel inputs |
| 供应商卡片 | 2 列网格 gap 8px；min-h 58px；bg `--bg-surface`，border 1px `--border-default`，radius `--radius-lg`（10px），padding 10px 12px | — |
| 卡片-名称 | 14px/20 / 500 `--text-primary` | — |
| 卡片-route | 11px/16 `--text-tertiary`，等宽 `--font-mono` | — |
| 卡片-hover | bg `--bg-elevated` | — |
| 卡片-选中（单选） | border `--accent` + bg `--accent-subtle`；左侧不再加指示条（与 team-panel 列表选中区分——卡片是单选不是列表） | — |
| 卡片-focus-visible | `outline: 2px solid --accent; outline-offset: 1px` | 共享约定 |
| 空搜索结果 | "没有匹配的供应商" 13px `--text-tertiary`，居中，padding 24px 0 | — |

排序沿用 patch 的 `SETTINGS_PROVIDER_PRIORITY`，DeepSeek 系置首。卡片无 logo 图形（M1 不引入供应商图标资产）——用文字卡，避免第三方商标资产风险。

**单选语义（a11y）**：卡片网格是单选，不用 `aria-pressed`（那是切换按钮语义）。容器 `role="radiogroup"`（aria-label="选择模型供应商"），卡片 `role="radio"` + `aria-checked`；方向键在卡片间移动即移动选中（roving tabindex），Enter/Space 确认。选中即进 S2 的交互不变，仅语义层修正。

### 状态

- **默认**：网格全量展示。
- **筛选中**：输入即过滤（前端行为），无 loading。
- **选中**：单选，选中即进入 S2（不需要"下一步"按钮——减少一次点击；S2 有明确的返回路径）。

## 4. S2 — 填写 API key（注入层）

选中供应商后，Picker 区域切换为 key 表单（同一容器内替换，不弹模态）：

```
┌──────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────┐  │
│ │ DeepSeek 官方                  [ 更换 ]         │  │ ← 摘要条
│ │ deepseek-official                                │  │
│ └────────────────────────────────────────────────┘  │
│                                                      │
│  API key                                             │
│  ┌──────────────────────────────────────────────┐   │
│  │ sk-••••••••••••••••                          │   │ ← mono, type=password
│  └──────────────────────────────────────────────┘   │
│  🔒 key 只写入本机 harness Credentials，不上传、       │   ← 安全提示
│     不在界面明文保存。                    12px tertiary │
│                                                      │
│  [ 保存并继续 ]                          primary     │
│  ⓘ 校验失败：无效的 API key（401）       12px danger  │ ← 错误态时显示
└──────────────────────────────────────────────────────┘
```

| 元素 | 规格 | token |
|---|---|---|
| 摘要条 | h52，bg `--bg-surface`，border `--border-default`，radius `--radius-lg`，padding 8px 10px 8px 12px；名称 14px/500 primary + route 11px mono tertiary | — |
| 「更换」按钮 | borderless，12px/500 `--text-secondary`，hover 升 `--text-primary`；最小点击区 28×28px（padding 补足）；点击回到 S1（保留搜索词） | — |
| key 输入框 | h32（`--input-h`），bg `--bg-sunken`，border `--border-default`，radius `--radius-md`，`--font-mono` 14px，`type=password`；focus 同搜索框 | — |
| 安全提示 | 12px/18 `--text-tertiary`，前置锁形 glyph（`--text-tertiary` 着色，1.5px 描边风格与 icon-mono 一致）；**必须展示，不可省略** | — |
| 保存按钮 | primary：bg `--accent-fill`、文字 `--text-on-accent`、hover `--accent-fill-hover`、h32、radius `--radius-md` | team-panel buttons |
| 错误文案 | 12px `--status-danger`，输入框下方 4px；输入框 border 同转 `--status-danger` | team-panel inputs error |

### 状态机

| 状态 | 视觉 |
|---|---|
| 空 | 保存按钮 disabled（文字/边框 `--text-disabled`） |
| 输入中 | 按钮转可用；错误文案清除 |
| 校验/保存中（loading） | 按钮 loading 态：前置 12px spinner（`--status-progress` 色）+ 文字保持、宽度锁定（team-panel buttons loading） |
| 校验失败 | 错误文案 + 输入框 danger 描边；按钮恢复可用（文案区分 401=无效 key / 网络错误=连接失败，可重试） |
| 写入 Credentials 失败 | 同错误态，文案"保存失败，请重试"；**key 不清空**（用户已输入的敏感值不因失败丢弃重打） |
| 成功 | 进入 S3 |

## 5. S3 — 完成

不做独立庆祝页（"无落地页"原则）：保存成功 → key 表单区域替换为单行确认（`--status-done` ✓ + "已配置 {provider}，正在进入…" 14px secondary），800ms 后注入层移除引导组件、恢复 harness 原生模型目录（此时已有模型）。若 route 建立失败，回退 S2 错误态并保留 key。

## 6. WKUserScript 注入约束（R1 落地边界）

### 注入层能控制的

- **DOM**：仅在 harness 设置·模型页的空模型态区域内**插入独立容器**（建议根节点 `dfh-oobe-root`，挂载 Shadow DOM 或全类名 `dfh-` 前缀——避免与 harness 样式互相污染；harness 升级后类名变动时只影响注入失败，不影响 harness 本体）。
- **样式**：注入 `<style>` 携带本规范的 token 子集——使用生成物 [`oobe-inject-tokens.css`](./oobe-inject-tokens.css)（由 `gen-oobe-tokens.py` 从 tokens.css 的 dark `:root` 生成，作用域 `:host, .dfh-oobe-root`，含 reduced-motion 降级；tokens.css 变更后重跑脚本，禁止手改生成物）。注入层读不到壳的 CSS 环境，这是**唯一允许的色值复制**。
- **行为**：筛选、选中、表单状态机、调 harness loopback Credentials API 写 key、建 route；检测"无已配置模型"决定是否展开引导。
- **文案**：全部中文文案随注入脚本携带；安全提示文案不可被配置关闭。

### 挂载前护栏（强制 dark 的前提）

注入容器只携带 dark token（M1 不注入 light 样式表）。挂载引导前必须检测 harness 页面主题（`document.documentElement` 的 class / `data-theme` / harness 主题标记）：**页面为 light 时不挂载引导**，直接落回 harness 原生设置路径（引导条提示"请在设置中配置供应商"）——light 页面上出现 dark 孤岛违反本规范"读起来像产品的一部分"原则。检测失败（标记不存在/不可识别）按保守策略同样不挂载，并 log 到 stderr 供排查。M2 由生成脚本补出 light 变体后此护栏解除。

### 必须原生覆盖层兜底的

| 场景 | 兜底方 |
|---|---|
| harness 未 ready（启动/安装/重启） | S0 原生覆盖层（现有三态） |
| 注入脚本自身失败（harness DOM 结构变动、JS 错误） | 原生错误页 + "打开设置手动配置"指引（落回 harness 原生设置路径），log 进 stderr |
| WebView 进程崩溃/页面加载失败 | 现有 didFailProvisionalNavigation + 错误页 |
| Credentials loopback 不可达 | 注入层显示 S2 错误态；连续失败时原生 toast 提示重启服务 |

### 双向契约

- 注入层**只写 Credentials，不读回 key**（harness Credentials API 的读取侧不用于回填明文；S2 重进时输入框永远为空 + 摘要条显示"已配置"态）。
- 原生侧通过 `evaluateJavaScript` 只调注入层暴露的两个钩子：`dfhOobe.mount()` / `dfhOobe.unmount()`，不直接操作注入层内部 DOM。
- `prefers-reduced-motion`：注入样式表内置同名 media query（与 tokens.css 一致，时长归零）。

## 7. token 缺口

**无。** 本规范全部元素已绑定 tokens.css 现有 token（含 §10–§12 修订后的 `--text-tertiary`、`--status-idle` 新灰）。进度条（S0）由 `--accent-spark` + `--bg-elevated` 组合而成，不需专用 token。

## 8. 一致性检查单（交付 K3-2 复核用）

- [ ] 所有颜色/字号/圆角/间距均可在 tokens.css 找到同名 token（输入框高度 = `--input-h` 32px，无第三档密度）
- [ ] 状态语义未新增颜色（loading=violet / 成功=success / 失败=danger / 进行中=spark）
- [ ] 按钮/输入框三档样式与 team-panel components 一致；点击区 ≥28px
- [ ] S1 单选语义为 radiogroup/radio + aria-checked + roving tabindex
- [ ] 安全提示在 S2 必须出现
- [ ] 注入层与原生兜底分工符合 proposal R1+R2
- [ ] 挂载前护栏：检测到 harness 页面为 light（或主题不可识别）时不挂载引导，落回原生设置路径（M1 注入容器仅 dark token；M2 由生成脚本补 light 变体后解除）

## 9. 待 M1 实施时确认（非设计缺口）

1. harness Credentials loopback 的确切 API 路径与写后 route 建立契约（proposal §② 标注的实现前提）。
2. 空模型态检测的可靠 DOM 锚点（harness 升级后的稳定性）。
3. fallback C 的安装进度事件来源（HarnessServiceManager 是否暴露下载进度；不暴露则 S0 全程 spinner）。
