# 鲸群 WhalePod — 多智能体团队管理面板 · UI/UX 设计

> 版本：v0.2（已与 [../visual-identity.md](../visual-identity.md) 对齐，token 统一收敛至 [../tokens/](../tokens/)）
> 作者：视觉-K3-1
> 范围：成员 roster 视图 / 任务板视图 / 与 teammate 对话界面 / spawn & shutdown 操作

## 设计目标

鲸群 WhalePod 是一个**桌面端多智能体团队管理面板**。用户（人类 Lead）在这里：

1. 看清团队里都有谁、各自在干什么（**Roster**）
2. 看清工作分解与流转状态（**任务板**）
3. 直接和任意 teammate 对话、下指令（**对话界面**）
4. 扩编 / 缩编团队（**Spawn / Shutdown**）

设计关键词：**密集但不拥挤、状态一眼可读、键盘可达、操作有回弹力（可逆/需确认分级）**。

## 设计语言

- **桌面应用审美**：参考 VS Code 的信息密度、Linear 的排版克制、Raycast 的命令优先。不做营销页式的大留白和圆角卡片堆砌。
- **暗色优先（Dark-first）**：Agent 工作站是长时间盯屏工具，暗色为默认主题——此结论已与视觉识别系统统一（visual-identity §5），浅色通过 `data-theme="light"` 切换。
- **状态即颜色**：agent 状态（working / idle / failed / offline）和任务状态（pending / in_progress / completed / blocked）是全局语义色，跨三个视图保持一致。
- **三栏骨架**：导航栏（视图切换）→ 列表栏（roster / 任务列）→ 详情栏（对话 / 任务详情 / agent 详情）。三栏均可折叠，宽度可拖拽。

## 文档索引

| 文档 | 内容 |
|---|---|
| [wireframes.md](./wireframes.md) | 总体布局 + 各视图 ASCII wireframe + spawn/shutdown 流程 |
| [design-tokens.md](./design-tokens.md) | 面板 token 消费规范（旧占位 → 正式 token 映射、组件速查） |
| [interaction-spec.md](./interaction-spec.md) | 交互规范：导航、状态流转、快捷键、空/加载/错误态、确认分级、无障碍 |
| [../visual-identity.md](../visual-identity.md) | 品牌视觉识别：标志、配色、字体、主题系统（视觉-K3-2 定稿） |
| [../tokens/](../tokens/) | **唯一 token 源**：`tokens.css` + `tokens.json`，桌面壳与面板共用 |

## 核心页面一览

```
┌────────────────────────────────────────────────────────────────┐
│  鲸群 WhalePod — 团队管理面板                                  │
│                                                                │
│  ┌─────────┬──────────────────┬─────────────────────────────┐  │
│  │ 导航栏   │  列表栏           │  详情栏                      │  │
│  │         │                  │                             │  │
│  │ ▸ 团队   │  agent 列表       │  与选中 agent 的对话          │  │
│  │ ▸ 任务板 │  或任务列         │  或任务详情 / agent 详情       │  │
│  │ ▸ 活动   │                  │                             │  │
│  │         │                  │                             │  │
│  │ [+ 扩编] │                  │  [输入框 ⌘↵ 发送]            │  │
│  └─────────┴──────────────────┴─────────────────────────────┘  │
│  状态栏：团队 11 人 · 9 working · 1 idle · 任务 6 (5 active)      │
└────────────────────────────────────────────────────────────────┘
```

详见各分文档。
