/**
 * 【功能定义】`@workbench/collaboration-client/types` 纯前端安全子出口。
 * 【协作边界】严禁导入 Node 内置模块、Ajv、CookieJar 或 Electron，确保浏览器/UI/Preload 可直接安全引用。
 */
export type * from "./identity.js"
export type * from "./organization.js"
export type * from "./collaboration.js"
export * from "./scope.js"
