/** 主进程确定的本机记忆范围；不允许通过模型参数覆盖身份。 */
export type MemoryScope = { origin: string; accountId: string; workspaceId: string }
/** 内容大小是整理目标，请求体上限是传输保护，两者不能混用。 */
export const MEMORY_TARGET_BYTES = 8 * 1024
export const CONTEXT_REQUEST_BYTES = 64 * 1024
