---
id: HC-199
title: 文件与Git服务迁移
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: 将旧文件读取和 Git 策略提取到 project-service，接入新项目/平台端口、目录占用与独立验证。
acceptance: 文件只读预览和 Git 选择提交/非 force 推送保留原行为；操作落到原设备项目，任何 ACP 后端可用且不回引旧 CLI。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；后续按本 Task 同名文件补 Spec、Plan、Todo
test_evidence: -
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-199 文件与Git服务迁移

## 需求与交付

从独立桌面查看会话原机器的文件，并按勾选范围提交或推送。文件/Git 是通用项目能力，不要求安装 Harness，也不通过模型代操作。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本文是待审阅的子 Task，不是已确认 Spec 或实施计划，尚未认领或实现。

## 范围与目标归属

- packages/project-service：项目根映射、目录/文件读取、截断与错误、Git 状态/Diff/选择提交/推送。
- 现 packages/cli/src/infrastructure/workspace-git.ts 等可复用策略迁出，替换旧 Controller/协议依赖。
- Runner 项目端口与 Java 授权/路由的接合；同一规范化目录的 Agent/Git 写占用。
- 通用文件/Git 数据与 UI 端口；HC-207 迁出已有文件树/阅读器/页签/Git 交互，HC-202 绑定真实操作，不在本任务重写 UI。

## 依赖与范围边界

本机项目服务代码前置为 [HC-193](./HC-193-独立桌面工程与分包.md) 工程；新公共契约与 [HC-194](./HC-194-协作契约与云端基础.md) 一致，并先和 HC-196/207 审查项目命令/结果及视图输入。文件/Git 策略可独立开发，不等 WSS 或 UI 完整实现；真实远端路由仍需 HC-196/202 接通。

不新增完整代码目录同步或任意编辑器，不通过 Harness 内核读文件。保留只读预览范围与原 Git 策略；不把远端操作人的模型/Git 凭据复制到执行机器。

## 并行认领与接口交付

本任务主责 project-service 与项目操作命名空间；HC-196 主责路由/账本，HC-207 主责文件/Git 视图，三者通过 Spec 固定项目目标、路径/快照/指纹、占用、Diff/提交/推送结果和错误语义。视图不会重新实现 Git 业务，项目服务不会直接编辑 React。

可与 HC-195/196/197 和 HC-206/207/208 同时开发，使用临时仓库/bare remote 验证本机策略；真实跨设备另验。公共 schema/OpenAPI/根锁由统筹顺序合入，见[并行开发约定](../project/协作任务并行开发约定.md)。

## 验收结果

- [ ] 没有 Harness/Python 时项目服务可独立运行并由通用 Runner 调用，无旧 CLI/InteractiveController import。
- [ ] 读取限定绑定项目根，穿越/符号链接等越界被拒绝；加载、错误、过大/截断与只读状态完整。
- [ ] 远端请求使用原设备项目 ID，不访问查看者电脑同名目录；文件状态清楚区分实时读取与缓存。
- [ ] 保留 Git 状态、Diff、勾选/全选和提交说明，只提交选中文件，未选内容和原暂存区按原规则处理。
- [ ] 保留 hooks、签名、实际提交 SHA 与提交/推送分离结果；推送仅使用既有 upstream、非 force，不退化为 git add .。
- [ ] 同一实际目录的 Agent 与人工 Git 写入按统一占用协调，项目别名不能绕过；离线不排队一笔隐式提交/推送。
- [ ] 保留执行机器的 Git author/committer 与凭据语义，平台操作用户另记录，不暗中换成查看者身份。

## 验证与后续流程

复用 HC-190 临时仓库/bare remote 场景及文件边界用例，验证真实 Git 结果、未选文件和 hooks/签名失败；网络远端与真实项目不作为自动化依赖。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
