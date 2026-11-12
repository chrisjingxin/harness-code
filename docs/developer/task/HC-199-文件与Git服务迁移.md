---
id: HC-199
title: 文件与Git服务迁移
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 进行中
owner: Codex
branch: harness_lody
scope: 将旧文件读取和 Git 策略提取到 project-service，接入新项目/平台端口、目录占用与独立验证。
acceptance: 文件只读预览和 Git 选择提交/非 force 推送保留原行为；操作落到原设备项目，任何 ACP 后端可用且不回引旧 CLI。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/research/199-文件与Git服务迁移.md；docs/developer/spec/HC-199-文件与Git服务迁移.md；docs/developer/plan/HC-199-文件与Git服务迁移.md；docs/developer/todo/HC-199-文件与Git服务迁移.md
test_evidence: 本机与原设备只读路由停点已通过统筹复核，受影响构建、类型、双端共同契约、依赖边界及隔离 Java/真实 Runner 五项读取冒烟通过
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-199 文件与Git服务迁移

## 当前可做与等待范围（2026-11-11）

本机项目服务已完成首个停点。第二停点已接入原设备项目只读路由，隔离实例的正常读取冒烟和统筹复核已通过。纯本地项目演示使用精确项目和共享版本的服务端受信来源配置；真实内网仓库绑定和当前用户 Git 读权仍待对应接入。

ACP Agent 与 Git 写占用的生命周期接合、Agent 在途写入及相关 ACP 联调，均等同事完成 ACP 交付后再进行；独立 Git 冒烟不证明 Agent/Git 并发协调已完成，不先造一套临时 ACP 端口。见[当前并行约定](../project/协作任务并行开发约定.md#0-当前调度等待同事交付-acp2026-11-10)。

## 需求与交付

从独立桌面查看会话原机器的文件，并按勾选范围提交或推送。文件/Git 是通用项目能力，不要求安装 Harness，也不通过模型代操作。

本卡属于 HC-192。预研已记录旧代码的可迁策略、原设备路由和共享权限的待定事项。2026-11-11 本机停点通过复核，用户确认跨用户读取与线上推送授权规则。[规格](../spec/HC-199-文件与Git服务迁移.md) · [实施计划](../plan/HC-199-文件与Git服务迁移.md) · [HC-192 总任务](./HC-192-协作工作台与会话交接.md) · [预研](../research/199-文件与Git服务迁移.md) · [总体设计](../architecture/多人协作工作台顶层设计.md)

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
- [ ] 本机操作沿用执行机器的 Git author/committer 与认证配置。线上记录发起人，推送使用操作者的 Git 平台身份。

## 验证与后续流程

复用 HC-190 临时仓库/bare remote 场景及文件边界用例，验证真实 Git 结果、未选文件和 hooks/签名失败；网络远端与真实项目不作为自动化依赖。

先编写同名 Spec，经复核后写 Plan/Todo 并按可演示停点实施。单卡冒烟走一次核心路径，完整组合归 HC-204。[并行开发约定](../project/协作任务并行开发约定.md)

### 本机停点实施证据（2026-11-11）

从 `@workbench/project-service` 根出口调用 `createProjectService(projectRoot)`。宿主注入真实项目根后可列目录、查候选、读预览、取 Git 状态与 Diff、按选择提交及向既有 upstream 推送。分开返回提交和推送结果。组合操作确认提交后重读状态，用实际 SHA、提交后快照与原 upstream 发起推送。当前本机占用在宿主进程内按真实项目及 Git 公共目录协调，提交额外使用 Git 索引锁。线上写请求账本与设备接线仍按 Spec 的前置安排。[包公开入口](../../../packages/project-service/src/index.ts) · [本机 Todo](../todo/HC-199-文件与Git服务迁移.md)

macOS 15.4 x86_64、Node 22.23.2、Apple Git 2.39.5。运行 `npm run build --workspace @workbench/project-service`、`npm run typecheck --workspace @workbench/project-service`、`npm run check:boundaries -- --self-check`，均通过。边界检查覆盖七个 workspace、公开入口和拒绝旧依赖的夹具。

通过仓库根的 `node --input-type=module` 加载已构建公开入口。在隔离临时目录初始化 `main`、初始提交及 bare remote，配置测试身份和现有 `origin/main`，按 Plan 准备两个同时有暂存和工作区修改的文件。依次调用 `listDirectory`、`searchCandidates`、`readPreview`、`gitStatus`、`gitDiff`、`commit({snapshot, paths, message, alsoPush: true})`，并重读状态。观察如下：

- 文件树和候选返回 `税率 rate.ts`，预览及 Diff 中出现 `export const rate = 0.2`，提交包含整文件工作区内容。
- 提交返回 `f890c714b3e11ba424ae64f40c5050773da1d974`，与本地 HEAD 和 bare remote 的 `refs/heads/main` 一致。推送结果为 `succeeded`，提交树只改变了所选文件。
- `log.txt` 的索引和工作区分别仍为 `staged log` 和 `working log`，原 Git 测试身份用于提交，临时 `pre-commit`、`pre-push` hooks 均留下记录。

该本机停点仅对临时仓库执行写操作，验证后清理临时数据。签名、Windows、完整异常、独立重试推送、线上权限及设备派发、桌面装配和 ACP/Git 并发当时未验。OpenWiki 命令不可用，生成 Wiki 未刷新。

### 原设备只读路由实施证据（2026-11-11，复核通过）

新增会话项目只读 HTTP 入口及五种具名动作，Java 按当前登录、会话绑定、设备与共享版本授权，经声明 `project.read` 的当前 ready WSS 连接派发。Runner 复核原项目登记和目录后调用本机项目服务；Java 匹配原连接与请求，并在返回前复核会话和授权。受信服务端演示来源以 `WORKBENCH_PROJECT_READ_DEMO_LOCAL_BINDING` 显式指定唯一工作区、设备、项目及共享版本。未配置或不匹配返回来源未知。内网仓库权限入口定义了允许、来源未知、身份未绑定、无读权和检查不可用的结果，当前实现只提供上述纯本地演示绑定。`项目服务` · [Runner 端口](../../../apps/runner/src/project-read.ts)

macOS 15.4 x86_64，Node 22.23.2、JBR 21.0.6、MySQL 8.4.11、Git 2.39.5。执行 `npm run contracts:smoke`、`npm run server:build`、`npm run server:contracts`，Node 和 Java 共用的 79 项契约夹具通过。contracts、runner-core、project-service、runner 构建及类型检查通过，desktop 类型检查和 `npm run check:boundaries -- --self-check` 通过。根 `dev` 的 workspace 构建顺序核对为 contracts → runner-core → project-service → runner → UI。Java 使用既有 JBR 和 Maven 3.9.11。

通过临时 Node 冒烟脚本在独立 MySQL `127.0.0.1:50629` 和 Java `127.0.0.1:56524` 上显式迁移、初始化演示数据并启动真实 Runner。设备所有者登记并共享纯本地临时 Git 项目，服务端按实际共享版本 `1` 配置受信来源；另一启用成员登录，选择已绑定该项目的会话，从真实 HTTP 依次完成：

- 文件树和候选返回 `税率.txt`，预览正文为 `原设备税率 new 😀`。
- Git 状态返回 `main` 分支及该文件变更，按返回快照读取的 Diff 包含 `+原设备税率 new 😀`。
- 该次会话、设备、项目分别为 `4f75d619-4603-4aa2-a3b9-0cae61ee436d`、`1bbdd59f-63c8-4ead-85b5-7380af525172`、`c1de4c3f-52dd-47a6-9592-b026cbcd396c`。Java 按这些固定绑定和共享版本关联本次读取，响应含 `no-store` 与请求编号。

能力兼容做了受控检查：旧式设备模拟器在新 Java 恢复 ready，读取返回 `PROJECT_READ_UNAVAILABLE`，连接保持打开；新 Runner 对只发送旧控制帧的受控服务完成 welcome/resume/ready 和已有项目变更确认。握手能力解析另检查存在、缺失、重复、非法及超长头。以上检查不代表完整跨版本矩阵。

本轮 Java、Runner 和 MySQL 进程均已退出，隔离数据库与临时文件已清理；未操作 HC-202 的实例。设备帧的内部 messageId 未单独采集，关联依据是 Java 的消息匹配代码、固定项目标识及真实读取结果。真实内网身份和仓库读权、256 KiB 截断/并发/撤权异常矩阵、桌面项目消费、跨设备实机、Windows、目标 TDSQL、线上提交推送与 ACP 占用仍待后续阶段。最终尝试执行 `openwiki code --update --print`，因命令不可用未能刷新生成文档。
