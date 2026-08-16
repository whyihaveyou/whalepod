/** dsh client 包名（登记面 ③ deps / ② dsh.client 行 / ① tsconfig references 三者须一致）。
 * 参考 harness 约定 ui-user-questions 的 invariant 只断言 pack name。 */
export const PACK_NAME = "@deepseek-ai/dsh-client-ui-whalepod-team";

export function assertPackName(name: string): void {
  if (name !== PACK_NAME) {
    throw new Error(`[ui-whalepod-team] 包名不一致: 期望 ${PACK_NAME}, 实际 ${name}`);
  }
}
