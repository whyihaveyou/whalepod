# SessionEvent → WorkState 映射表

胶水层 `runtime/agent-runtime.ts` 把 connectors 侧的 `SessionEvent` 归一化为
框架的 `RuntimeEvent`，并同步驱动成员状态。

## 事件归一化（SessionEvent → RuntimeEvent）

| SessionEvent | RuntimeEvent | payload |
| --- | --- | --- |
| `{ type: 'stream'; chunk }` | `{ type: 'stream' }` | `{ chunk }` |
| `{ type: 'tool-call'; id; name; arguments }` | `{ type: 'tool-call' }` | `{ id, name, arguments }` |
| `{ type: 'tool-result'; id; content }` | `{ type: 'tool-result' }` | `{ id, content }` |
| `{ type: 'approval-request'; id; prompt }` | `{ type: 'approval-request' }` | `{ id, prompt }` |
| `{ type: 'done'; exitCode }` | `{ type: 'done' }` | `{ exitCode }` |
| `{ type: 'error'; message }` | `{ type: 'error' }` | `{ message }` |

## 状态转移（SessionEvent → 派生状态 → 名册/工作队列）

`deriveWorkState(event)` 返回派生状态，再通过两个映射分别驱动两类状态事件：

### 派生状态

| SessionEvent | DerivedWorkState |
| --- | --- |
| `stream` | `working` |
| `tool-call` | `working` |
| `tool-result` | `working` |
| `approval-request` | `working` |
| `done` (exitCode === 0) | `finished` |
| `done` (exitCode !== 0) | `failed` |
| `error` | `failed` |

### member/status（MemberStatus 视角）

| DerivedWorkState | MemberStatus | 触发事件 |
| --- | --- | --- |
| `working` | `working` | stream / tool-call / tool-result / approval-request |
| `finished` | `finished` | done (exit 0) |
| `failed` | `failed` | done (exit≠0) / error |
| `idle` | `idle` | 初始 |

### member/work-state（框架 WorkState 视角）

| DerivedWorkState | WorkState |
| --- | --- |
| `working` | `running` |
| `finished` | `idle` |
| `failed` | `blocked` |
| `idle` | `idle` |

## 数据流

```
编排循环 ──(courier 派工)──> handle.send(RuntimeMessage{role, content})
                                │ ↓
                           session.send({ content })   [stdin]
                                │
外部 CLI 进程 ──(stdout)──> session.events  ──> deriveWorkState / normalizeSessionEvent
                                │
                                ├─> handle.events()  (RuntimeEvent 流，供路由回声)
                                └─> ctx.emit('member/status') / 'member/work-state'
```
