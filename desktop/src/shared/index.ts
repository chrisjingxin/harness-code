/**
 * 【功能定义】桌面工程内部前后端共享窄接口与纯数据类型统一出口。
 * 【协作边界】零 Node/Electron 运行时依赖，供 `desktop/src/main`、`preload` 与 `renderer` 安全导入。
 */
export type * from "./desktop-host.js"
export type * from "./project-read.js"
export * from "./desktop-hosts.js"
export type * from "./session.js"
export * from "./personal.js"
export * from "./collaboration-reference.js"
export * from "./local-execution-host.js"
export * from "./local-conversations-host.js"
