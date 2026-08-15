# E2E 视觉回归基线

> 团队面板 / 皮肤中心 / 未来 OOBE 的视觉回归脚手架。
> 依据：`e2e/` 目录 + Playwright 1.48+。
> 参照：zhu1090093659/dsh-web-ui 的 docs/e2e/skin-center 目录结构。

---

## 一、定位

| 维度 | 单元测试 | e2e 视觉回归 |
|---|---|---|
| 范围 | 纯函数 / 模块（honeycomb 内部） | UI 视觉、布局、跨页面交互 |
| 跑时 | 毫秒–秒 | 秒–分钟 |
| 跑在哪 | Node（任意 OS） | 真实浏览器（chromium） |
| 失败定位 | 栈 + diff | 基线图 vs 当前图（像素级 diff） |
| 触发 | push/PR | push/PR + 重大改动前手动 |

**为什么需要**：honeycomb 改一行 emit 顺序就可能让前端某行换色——单元测试看不见；视觉回归能看见。

---

## 二、目录结构

```
e2e/
├── package.json                       # @whalepod/e2e 私有包（playwright dep）
├── playwright.config.ts               # 单 chromium 项目 + 视觉回归阈值
├── README.md                          # 5 分钟上手
├── test-results/                      # 失败制品（gitignore）
├── playwright-report/                 # HTML 报告（gitignore）
└── skin-center/                       # 「皮肤中心」基线目录（与 dsh-web-ui 同名）
    ├── team-panel.spec.ts             # 示例用例：暗 / 亮 / hover
    └── __screenshots__/               # 基线 PNG（git 跟踪！）
        ├── team-panel-dark-chromium.png
        ├── team-panel-light-chromium.png
        └── task-card-hover-chromium.png
```

参照 `dsh-web-ui` 的目录约定：每个「皮肤/视图」一个子目录，spec + `__screenshots__` 同居。后续加 `oobe/`、`settings/` 等同理。

---

## 三、本地运行

```bash
# 前置：装好 playwright dep
cd e2e
pnpm install
npx playwright install chromium  # 首次装浏览器（≈ 200MB）

# 步骤 1：起团队面板原型（独立终端）
cd ../prototypes/team-panel
pnpm install && pnpm dev   # 默认 http://localhost:5173

# 步骤 2：跑视觉回归（e2e 目录）
cd ../../e2e
pnpm test                   # 对比基线，差异 > 阈值则失败
pnpm test:update            # 确认改动后，重生基线
pnpm test:ui                # Playwright UI 模式（debug 用）
pnpm report                 # 打开 HTML 报告
```

> 提示：不要在 `pnpm dev` 没起来时跑 `pnpm test`——会一连串 timeout。

---

## 四、基线更新流程

1. 改了设计 token / 组件 / 布局 → 跑 `pnpm test` 看哪些红
2. 打开 `playwright-report/` 或截图 diff 看具体像素差异
3. 视觉确认是「意图内」改动 → `pnpm test:update` 重生 baseline
4. `git diff e2e/skin-center/__screenshots__/` 检查 PNG 改动量（避免被 baseline 掩盖真 bug）
5. 把新 PNG 一起提交（PNG 入库是有意的——基线也是代码的一部分）

> **铁律**：基线图入库前必须看 diff。CI 跑通 ≠ 视觉正确。

---

## 五、CI 集成（roadmap）

当前 `release.yml` 没把 e2e 包进去（macos runner 分钟数金贵）。roadmap：

| 阶段 | 触发 | runner | 时长估算 |
|---|---|---|---|
| M1 | push/PR to main，单独 `e2e.yml` | ubuntu-latest + 浏览器缓存 | 1–2 分钟 |
| M2 | 重大改动前手动 `workflow_dispatch` | 同上 + visual diff 评论 | 2–3 分钟 |
| M3 | release 前必须过 e2e | 串入 release.yml | +1–2 分钟 |

`e2e.yml` 骨架（待补）：
```yaml
name: e2e
on:
  pull_request: { branches: [main] }
  workflow_dispatch:
jobs:
  visual:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - checkout
      - setup-node (22)
      - install-playwright (npx playwright install --with-deps chromium)
      - install-e2e (cd e2e && pnpm install)
      - start-team-panel (cd prototypes/team-panel && pnpm dev &)
      - run (cd e2e && pnpm test)
      - upload-report (if: failure())
```

---

## 六、与已有测试体系的关系

| 层 | 命令 | 文件 |
|---|---|---|
| L1 单元 + 集成 | `cd packages/honeycomb && pnpm test` | `test/*.test.ts`（Node test runner + tsx） |
| L2 视觉回归 | `cd e2e && pnpm test` | `e2e/**/*.spec.ts`（Playwright） |
| L3 真机冒烟 | 本地 `HarnessShell.app` 双击启动 | 手动 |

L1 跑在 CI（ubuntu，免费档）。
L2 跑在 CI（ubuntu + 浏览器缓存；M1 启用）。
L3 不进 CI——用户 / QA 手动。

---

## 七、变更记录

| 日期 | 变更 | 责任人 |
|---|---|---|
| 2026-08-15 | 首次脚手架（playwright + 示例 spec + docs） | 工程-Flash-1 |