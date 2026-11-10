---
id: HC-201
title: Harness轨迹与设置扩展
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: 建立 harness-provider 的 runtime/ui 扩展，提取 Trace 采集/历史/视图和专有设置，通过通用接口注册并保存共享扩展记录。
acceptance: HC-191 全功能矩阵和现有 Harness 专有设置按能力保留；通用 UI/Runner/Java 无 marker/Span/内核类型，移除集成仍能启动。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；后续按本 Task 同名文件补 Spec、Plan、Todo
test_evidence: -
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-201 Harness轨迹与设置扩展

## 当前可做与等待范围（2026-11-10）

可先迁出已有 Trace 离线解析、历史/视图和纯设置展示，用既有样例验证解析与呈现；不改变内网 SDK 产出逻辑或增减功能。ACP stderr、扩展注册/专有方法/能力映射，以及真实 Agent 采集的开发、接线和调试，均等同事完成 ACP 交付后再安排，不能仅凭接口讨论启动这些工作。见[当前并行约定](../project/协作任务并行开发约定.md#0-当前调度等待同事交付-acp2026-11-10)。

## 需求与交付

把 Harness 专有轨迹与设置完整保留下来，同时放进独立可选集成包。通用平台可不安装该包；选用 Harness 时仍看到原有 Trace 和设置能力。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本文是待审阅的子 Task，不是已确认 Spec 或实施计划，尚未认领或实现。

## 范围与目标归属

- packages/harness-provider/runtime：专有方法、marker 解码/归属/合并、日志/索引、可中止历史与事件补传。
- packages/harness-provider/ui：Trace 树、三轨图、详情、简化模式与专有设置视图。
- 通用扩展注册/资源归属与装配接线；acp-runtime 只提供受控 stderr 端口。
- Java 对扩展事件/附件做通用存取与授权，不解析 SDK marker，不把 Span 类型加入公共 DTO。

## 依赖与范围边界

公共渲染使用 HC-205 已交付出口，离线解析器与既有视图可独立迁出；涉及 [HC-197](./HC-197-通用ACP运行时.md)、[HC-200](./HC-200-Harness独立ACP接入.md) 的 stderr/扩展接入必须等同事 ACP 完成交付后再共同核对接口并开发。完整真实采集仍需 HC-197/200 接通，内网 SDK 产出单独验收。

不新增或减少内网 Trace 功能，不把合成 Span 注入产品，不要求其他 ACP Agent 支持相同 Trace。内网 SDK 产出逻辑原样保留，外部无法安装的私有 SDK 仍留内网验收；完整工作台装配归 HC-202。

## 并行认领与接口交付

本任务主责 harness-provider/runtime 与 ui；原 trace/trace-store/trace-log 源码迁出清单归本任务，不与 HC-206/207 同时修改它们的区域。HC-205 提供公共渲染/扩展槽，HC-206 保留通用消息/工具，HC-202 组合 Trace 页签，不静态导入专有类型到通用包。

可与 HC-200、中央/右侧复用和新导航并行，使用既有合成数据只证明解析/呈现，真实内网产出不被替代。公共注册/制品出口由统筹顺序集成，见[并行开发约定](../project/协作任务并行开发约定.md)。

## 验收结果

- [ ] 移除 harness-provider 后基础桌面、协作、文件/Git 与第二 ACP 后端仍可构建启动；基础入口无必需静态导入。
- [ ] 选用并注册 Harness 扩展后，HC-191 全字段/交互逐项保持，包括树、三轨、详情、简化规则、折叠和失败识别。
- [ ] 浅/深色、缩放、分隔条、选中定位与对话/文件/Git 个人状态按已确认表现保留。
- [ ] marker 跨 chunk、UTF-8、乱序 start/end、归属冲突、历史/实时合并和读取中止沿用既有行为。
- [ ] 单一采集者处理 stderr，通用 ACP/Runner/Java 不包含 marker/Span 解码或直接读取内核数据库的分支。
- [ ] 已同步轨迹历史可在原设备离线时查看，未同步部分明确依赖原设备；外部没有 SDK 产出时显示真实空态/不可用。
- [ ] 专有设置通过能力与扩展视图接入居中设置，凭据留原设备，不按 Agent 名称在通用组件硬编码。

## 验证与后续流程

复用 HC-191 合成数据、真实展示组件和采集解析用例，再验证扩展注册/移除与云端存取；合成验证、真实 Harness 及内网 SDK 验收分别记录。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
