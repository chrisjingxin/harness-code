# 更新日志

## [0.2.0] - 2026-09-24

### 新增
- 内网依赖源码化：在 `third_party/npm/` 完整内嵌 `@opentui/core`、`@opentui/react`、`@opentui/core-win32-x64`、`bun-ffi-structs` 与 `react-devtools-core` 5 个核心包，建立 workspace 本地链接与严格的来源/防篡改门禁
- npm 工程体系迁移：全面迁移至纯 npm/Node 工作流（`packageManager: npm@11.11.0`），以 `package-lock.json` 替代 `bun.lock`，支持离线与内网安装
- 依赖同步与验证工具链：新增 `npm run deps:sync`、`npm run deps:check` 及 `npm run deps:test`，支持 macOS、Windows、Linux（glibc/musl）跨平台架构门禁
- 运行时安全性与清理机制：新增 `npm run clean` 深度清理脚本；为安全分类器（`SafetyClassifier`）引入事件流隔离，杜绝判定 JSON 泄露至 TUI
- DeepAgents 离线补丁：消除模块导入时对 Anthropic 相关包的强依赖，约束并排除非受信外部依赖

### 修复
- 修复 Windows CRLF 换行符导致协议合约摘要（Protocol SHA-256）校验失败的问题
- 修复 64 位 Windows 下 Win32 伪句柄截断导致无法读取用户 SID、Agent 启动报 `SETTINGS_BACKEND_UNAVAILABLE` 的致命缺陷
- 修复源码包 workspace 归一化来源与安装后 realpath 校验

### 文档
- 补充 HC-179 内网依赖源码化与离线安装规范文档（`docs/developer/project/内网依赖安装.md`）
- 更新 HC-179 完整性验收证据与测试记录

## [0.1.0] - 2026-09-14

### 新增
- 终端 TUI 交互：基于 OpenTUI 的终端全屏界面，支持侧边栏会话管理、状态栏、代码高亮、交互审批卡片及长内容平滑滚动
- 跨进程 IPC 架构：TypeScript CLI 与 Python Sidecar 通过 stdio 上的 JSON-RPC v3 双向通信，支持流式文本、事件通知与中断取消
- Agent 执行引擎：基于 LangGraph 与 LangChain 的状态机运行时，支持 OpenAI 兼容协议模型配置与 Profile 切换
- 内置子代理分工：支持只读探索（explore）与通用执行（general-purpose）子代理，具备独立执行上下文与超时隔离机制
- 审批与安全策略：提供 default / auto / plan / yolo 审批档位，支持运行中实时切换、目录信任卡片与会话级安全防护
- 会话与状态持久化：基于 SQLite 与 Git Checkpoint 实现会话记录持久化、多 Thread 恢复与会话撤销回滚
- 目标闭环执行：引入 `/goal` 自主闭环运行模式，支持自动化多轮迭代与 Grader 自主验收
- 本地诊断日志：异步结构化 Diagnostic Log v1 系统，支持调用链追踪、敏感信息脱敏与文件轮转
- 快捷操作与扩展：支持 `@` 工作区文件提及、运行时命令输入以及 MCP（Model Context Protocol）协议客户端扩展
- 内网迁移支持：完备的直接/间接依赖盘点与内网环境准备材料，支持企业级离线部署

### 优化
- 侧边栏与命令菜单交互逻辑重构
- 线程标题管理与多端展示优化
- 运行时模型调用异常的边界恢复能力
- 诊断日志按本地时区展示并优化列宽
- 清理死代码并收敛重复实现

### 修复
- 修复 TUI 长审批预览滚动与子代理时间线点击交互
- 修复批量审批恢复时的状态不稳定性
- 修复任务复核过期与编号冲突检查
