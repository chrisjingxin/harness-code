# HC-197 通用 ACP 运行时规格

关联 [Task](../task/HC-197-通用ACP运行时.md)。2026-11-16 授权优先打通本机文本首轮。

## 首轮使用流程

1. Electron 主进程验证当前账号与设备拥有本机执行权限，再把完整账号、团队、项目、设备、会话标识，以及用户选定的本机目录交给宿主绑定。进程命令和参数来自可信宿主配置。Renderer 只消费后续 HC-218 装配的具名入口。
2. `createDesktopLocalAcpHost` 按 `WORKBENCH_ACP_EXECUTABLE` 配置可选 Agent，可通过 `WORKBENCH_ACP_ARGS_JSON` 提供固定字符串数组。命令使用绝对路径。受信任调用方也可直接用 `@workbench/acp-runtime` 的 `LocalAcpHost` 注入同等配置。
3. `bind(scope, cwd)` 返回会话句柄。目录规范化后绑定到文件系统对象，同一标识使用同一绑定；改选目录须先显式释放旧绑定。普通目录与 Git 目录均可使用。不同绑定各用自己的 ACP 会话和进程。
4. 消费方先调用句柄的 `subscribe`，再检查 `getAvailability` 或提交 `send(text)`。`send` 同步返回受理和宿主生成的 `turnId`，或拒绝原因。每会话同时受理一轮，首轮可以在冷启动前受理。受理表示宿主已接管本轮，后续启动或协议失败以事件交付。
5. 首次受理后，宿主在所选 cwd 以参数数组启动进程，通过标准 ACP SDK 走 stdio 握手、建会话和发 prompt。收到的正文通知按会话和当前轮识别，依次发出 `text-delta`，完成时发 `completed`，失败时发 `failed`。每轮从 1 开始编号，终态唯一。已连接且空闲时同一原生会话可继续发送。连接丢失结束当前轮，后续显式发送按下方恢复规则重新连接。
6. `subscribe` 返回取消订阅函数。关闭句柄释放目录绑定及 Agent 进程。注销、切换账号和应用退出由接线方关闭对应句柄或宿主。受理中的关闭先交付失败终态，再确认子进程退出。标准权限请求按下方停点二处理。

## 范围与可观察结果

- 使用与既有 ACP 客户端一致的 `@agentclientprotocol/sdk@0.25.1`。SDK 处理标准编解码，宿主只管理本地进程、会话和事件。
- 用隔离目录和会话经真实 Harness 进程提交文本，观察受理和两个不同的 turnId、每轮分段文本按序到达、终态后再次发送，并独立确认子进程退出。模型回环结果单独标记，外部模型联通单独记证。
- 线上同步沿 HC-218 既有授权和上传路径。

## 主进程接线与本机复现

从 `apps/desktop/src/main/local-acp-host.ts` 导入 `createDesktopLocalAcpHost`。主进程持有一个应用级实例。由 HC-218 在可执行的本人本机会话上解析现有目录授权，再以可信 scope 和 cwd 调用 `bind`。Renderer 消息提供文本和原有会话标识，执行命令、目录和账号设备授权由主进程确定。终态事件上没有重新判断权限的入口，接线方要按同一 scope 转发，身份变化时先取消订阅并关闭句柄。

可用状态为可提交或带原因的不可用，原因包括 Agent 未配置、正执行一轮、会话关闭和原生连接已断开。正在执行时重复提交直接拒绝。冷启动后的失败分为目录不可用、启动失败、连接断开、prompt 失败、Agent 停止和主动关闭句柄。SDK 的原生消息标识按不透明值透传。宿主为每次受理独立生成 turnId，消费者按 turnId 和 sequence 合并正文与终态。

在仓库根目录安装根锁并构建 `npm run build --workspace @workbench/acp-runtime`。已有安装可将 `WORKBENCH_ACP_EXECUTABLE` 指向绝对路径的 harness 命令，`WORKBENCH_ACP_ARGS_JSON='["acp"]'`。使用 HC-200 源码时，在独立环境按 `packages/agent/uv.lock` 安装并应用 `scripts/dependencies/apply_deepagents_patch.py`，设置 `PYTHONSAFEPATH=1`、`PYTHONPATH` 为 `packages/agent` 绝对路径、`WORKBENCH_ACP_EXECUTABLE` 为该环境 Python，参数为 `["-m","harness_agent","acp"]`。Harness 在自己的环境读取用户级模型配置。验证时用独立 HOME 和已授权的模型配置，测试禁止注入真实模型密钥。

```sh
node --disable-warning=ExperimentalWarning --experimental-loader ./scripts/typescript_loader.mjs scripts/workbench/smoke-local-acp.mjs --first
```

全路径冒烟可省略 `--first`，将验证同一会话再次发送、不同账号和目录绑定的事件隔离。普通的桌面构建与启动无需配置 Agent；HC-218 完成正式接线后再从聊天输入区复验。

## 停点二 停止与人工审批

本人本机的已受理轮次可停止。主进程重用执行授权，校验绑定和轮次后发标准 `session/cancel`。若 prompt 尚未派发，终止本机排队。已派发时由 prompt 实际结果结束，协议超时则关停并报告失败。每轮至多一个终态。权限请求绑定该轮，使用宿主生成的请求 ID 和 Agent 提供的选项。只有当前拥有权限的用户能回答，停止、关闭和连接丢失会解除挂起。复用现有停止按钮和审批卡。取消、工具拒绝及未成功的轮次不上传。

## 停点三 原生会话恢复与通用性

主进程在本机应用数据中保存原生会话 ID，键覆盖服务来源、账号、团队、项目、设备、会话、Agent 启动标识及已验证目录身份。重启后先按 ACP 握手确认 `loadSession`，再尝试恢复。恢复失败或 Agent 不支持时明确反馈，不自动新建替换原生会话。恢复回放由 Agent 用于重建上下文，桌面已有历史沿正式历史入口读取，回放不计入当前正文与上传。原生 ID 对桌面保持不透明。运行中的标准工具状态映射到本机会话，stderr 仅向受信任诊断订阅者交付。关闭以实际进程退出为准。

macOS 检查直接 Agent 进程和同一 POSIX 进程组均已退出。Windows 路径只等待直接 Agent 进程退出，实机和子进程树行为与主动脱离进程组的外部工具留 HC-204 验证。恢复时的旧正文继续由原有历史入口展示，Agent 回放不进入当前轮事件。未建立过本机绑定的旧会话会在新版本首个成功启动时创建绑定。
