/**
 * Harness Code 的 ACP 扩展常量：桥与浏览器两侧从同一份常量取值，避免拼写漂移。
 *
 * 【这是做什么的？】
 * `_harnessCode/…` 是不属于标准 ACP 的扩展方法命名空间：桥自己产生的
 * `_harnessCode/bridge/exit` 崩溃通知、以及 initialize 握手里的扩展能力声明。
 * 值必须与 `packages/agent/harness_agent/host/acp/ext.py` 同名同值（有跨语言
 * 常量漂移测试锁定）。
 *
 * 【上下游】
 * 上游：`host/acp/ext.py` 是源头（Python 侧常量）。
 * 下游：`bridge/`（桥发崩溃通知）与 `client/`（ws-stream 拦截崩溃通知、
 * 网关拼扩展声明）都可引用——它刻意放在 `acp-web/` 根层而不是 `bridge/` 或
 * `client/` 里，因为边界规则禁止这两个子目录互相 import。
 */

export const EXT_KEY = "harnessCode"
export const EXT_METHOD_PREFIX = `_${EXT_KEY}/`
export const EXT_VERSION = 1
export const CAP_APPROVAL = "approval"
export const CAP_RUN_SUMMARY = "runSummary"
/** 桥产生的唯一帧类型：子进程退出通知（不经过 Python）。 */
export const BRIDGE_EXIT_METHOD = `${EXT_METHOD_PREFIX}bridge/exit`
export const CLIENT_EXTENSION_DECLARATION = { version: EXT_VERSION, capabilities: [CAP_APPROVAL, CAP_RUN_SUMMARY] } as const
