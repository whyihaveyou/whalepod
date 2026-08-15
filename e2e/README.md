# @whalepod/e2e

E2E 视觉回归脚手架。完整文档：[`docs/e2e.md`](../docs/e2e.md)。

## 30 秒上手

```bash
pnpm install
npx playwright install chromium

# 另起终端：
cd ../prototypes/team-panel && pnpm dev

# 跑视觉回归
pnpm test            # 对比基线
pnpm test:update     # 重生基线（视觉确认后）
pnpm test:ui         # UI 模式
pnpm report          # HTML 报告
```

## 目录

```
e2e/
├── playwright.config.ts           # chromium 单项目 + 视觉阈值
├── skin-center/                   # 皮肤中心基线
│   ├── team-panel.spec.ts         # 示例：暗 / 亮 / hover
│   └── __screenshots__/           # 基线 PNG（git 跟踪）
├── test-results/                  # 失败制品（gitignore）
└── playwright-report/             # HTML 报告（gitignore）
```

## 铁律

- 基线图入库前必须看 diff
- 视觉确认「意图内」改动后才 `pnpm test:update`
- 不要在 mock 数据不稳定时拍 baseline（每次都飘）
- CI 跑通 ≠ 视觉正确——人眼最后把关