# OOBE-M2 数据放置迁移：Application Support/WhalePod + 旧路径兼容

> 状态：**只读准备阶段**（方案细稿）。等集成测试 T1-T7 绿后实施。
> 依据：docs/shell-oobe-proposal.md M2（③ 升级安全的数据放置）。
> 约束：只碰 HarnessShell/ 源码；swift build 通过；config.json 语义（port 0=自动等）不变；
>       测试期间树要稳定，T1-T7 未绿不动 HarnessShell/。

## 现状数据触点（只读调研确认）

| 数据 | 现位置 | 现状 |
| --- | --- | --- |
| 配置文件 config.json | `~/.harness-shell/config.json`（`ServiceConfig.swift` 约 L71-77，home/.harness-shell/） | 需迁移 |
| 单实例锁 singleton.lock | `~/Library/Application Support/<bundleId>/singleton.lock`（`SingleInstance.swift` L69-78） | 已在 App Support，复核归位到新根 |
| DSH_HOME（harness 数据根） | 无注入（`HarnessServiceManager.mergedEnvironment()` L430-439 仅继承进程 env + config.environment） | 待加，与 M0 对齐 |

Swift Sources 内除上述 config 路径外，无其他 `.harness-shell` / DSH_HOME 直接引用（grep 确认）。

## 目标目录结构

```
~/Library/Application Support/WhalePod/
├── config.json            # 迁移后的壳配置（port 0=自动 等语义不变）
├── migration.log          # 旧路径迁移日志（时间戳 + 迁移了哪些文件）
├── migration-marker       # 一次性迁移标记文件（存在即表示已迁移过）
├── singleton.lock         # 单实例锁（归位到此根，替代原 <bundleId> 目录）
└── harness/               # DSH_HOME：harness 侧数据根（对齐 M0 bundled runtime）
```

> 命名：产品定名「鲸群」WhalePod，英文目录名避免中文路径在 node/壳层脚本里的兼容问题。
> bundle id / 显示名改名归【品牌收束】，本任务不碰，只用新根目录名 WhalePod。

## 实施项

### 1) 新数据根解析（新增 DataRoot.swift）
- `FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)`
  → `appendingPathComponent("WhalePod")`。
- 提供 `configURL` / `migrationLogURL` / `migrationMarkerURL` / `harnessDataRoot(=`DSH_HOME`=`WhalePod/harness`)`。

### 2) 一次性迁移 + 旧路径兼容（新增 Migration.swift，首启调一次）
- 首启逻辑：
  - 若 `WhalePod/config.json` 已存在 → 新路径优先，直接使用（不覆盖，不重复迁移）。
  - 否则若 `~/.harness-shell/config.json` 存在 → 拷贝到 `WhalePod/config.json`，写 `migration.log`
    （含源/目标/时间/结果），落 `migration-marker` 标记文件。config.json 语义原样保留（port 0=自动等）。
  - 若新旧都无 → 按新根初始化空配置。
- `migration-marker` 存在时不再尝试迁移（幂等，防止多实例并发迁移）。
- 迁移失败不阻断启动：回退读旧路径，写失败日志，下次启动重试。
- 单实例锁目录也调整到 `WhalePod/singleton.lock`（复用既有 flock 机制，仅换目录）。

### 3) ServiceConfig 读取切换（改 ServiceConfig.swift L71-77）
- `load()` 改从 `WhalePod/config.json` 读取，旧路径作为 fallback（迁移尚未完成时兼容）。
- 路径解析收口到 DataRoot，删掉硬编码 `home/.harness-shell`。

### 4) DSH_HOME 结论（改 HarnessServiceManager.mergedEnvironment() L430-439）
- 注入 `DSH_HOME = ~/Library/Application Support/WhalePod/harness` 到 spawn 子进程环境
  （在继承进程 env + config.environment 之后设置，成为默认值；config.environment 可覆盖）。
- 与 M0 bundled runtime 方案对齐：harness 数据根固定为 WhalePod/harness，可随 bundle 移动/删除，回收干净。
- 不破坏现有 command 组装（只加 env 键，不动 `--port 0` 等 flag 语义）。

## 验证
1. `swift build` Build complete 0 error。
2. 首启迁移：预置一个旧 `~/.harness-shell/config.json`（含有效配置，如 port 0 + 自定义命令）→ 启动壳
   → 断言 `WhalePod/config.json` 生成、`migration.log` 有记录、`migration-marker` 存在、旧配置被完整迁移。
3. 幂等：二次启动不再重复迁移（marker 存在即跳过）。
4. 语义保持：迁移前后 `config.json` 的 port 0=自动 语义一致。
5. DSH_HOME：spawn 子进程能读到 `DSH_HOME=...WhalePod/harness`（可在测试命令里 echo 校验）。
6. 旧路径 fallback：删除新 config、保留旧 config → 壳仍能读到旧配置（兼容路径）。

## 风险
- 迁移与多实例/单实例锁的时序：migration-marker 幂等防并发，锁文件迁移在拿到单例锁后做。
- 旧 config 损坏或不可读：不硬崩，走 fallback + 失败日志。
- DSH_HOME 覆盖优先级：config.environment 显式设置则优先（文档注明）。

## 交付
迁移实现（DataRoot.swift + Migration.swift + ServiceConfig/HarnessServiceManager 改动）+ 旧路径兼容 +
简短说明（含 DSH_HOME 结论）。
