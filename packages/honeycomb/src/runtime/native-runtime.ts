/**
 * 原生 agent 运行时后端（桩，§6.2）.
 *
 * 委托 `ctx.agents`（harness 装配的原生 agent runtime）孵化成员。本文件是
 * 桩：`ctx.agents` 未装配时抛错；装配后原样转发 {@link RuntimeHatchInput}。
 *
 * @module @whalepod/honeycomb/runtime/native-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemberRuntime, RuntimeHatchInput, RuntimeHandle } from './registry'

/** 原生 agent runtime 需满足的契约（由 harness 提供，见 `context.ts` 的 `agents`）。 */
export interface AgentsRuntime {
  spawn(input: RuntimeHatchInput): Promise<RuntimeHandle>
}

export const NATIVE_RUNTIME_ID = 'native'

/** 构造 `native` 后端：委托 `ctx.agents.spawn`。 */
export function createNativeRuntime(ctx: Context): MemberRuntime {
  return {
    id: NATIVE_RUNTIME_ID,
    async hatch(_ctx, input) {
      const agents = ctx.agents
      if (!agents) {
        throw new Error('native runtime requires ctx.agents to be wired by the harness')
      }
      return agents.spawn(input)
    },
  }
}
