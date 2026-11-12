# HC-199 文件与 Git 服务迁移实施计划

2026-11-11，本机停点已实施并通过统筹复核。原设备只读路由的规格和首轮演示范围已通过评审，第二停点的本计划与 Todo 等待统筹复核及实施派发。[Task](../task/HC-199-文件与Git服务迁移.md) · [Spec](../spec/HC-199-文件与Git服务迁移.md) · [Todo](../todo/HC-199-文件与Git服务迁移.md)

## 1. 本机停点：读文件、审阅并提交推送

**演示结果。** 从构建产物的 `@workbench/project-service` 公开入口注入临时仓库根，在终端依次看到文件树/候选、选中文件的预览正文和 Diff、实际提交 SHA、独立推送结果。该 SHA 同时是本地 HEAD 和本地 bare remote 已存在目标分支的头。未选文件在工作区和原索引里各自保留原内容。

按以下顺序实施。前两步提供同一公开入口的输入和校验，最后用一次完整路径验证。

| 顺序 | 源码来源 → 实施内容 → 最小交付 |
| --- | --- |
| 1. 固定本机根并迁读服务 | 从旧 `workspace/path-policy.ts`、`workspace-index.ts`、`file-preview.ts`、`text-file-policy.ts` 与候选排序提取可复用逻辑。用受信宿主注入的真实根约束路径、链接及实际读取对象。实现目录、候选和有界 UTF-8 预览，保留相对路径、元数据、限额、截断和错误。旧 `WorkspaceExplorer` 的视图订阅、预览槽和个人缓存由各自消费者负责。 |
| 2. 提供 Git 状态和审阅 | 迁旧 Git 工作树定位、porcelain 状态、真实索引和指纹、Diff 等策略。只在登记根为完整 Git 工作树根时提供 Git；子目录仍可读取。输出逐文件版本、整体快照和阻塞原因；Diff 在同快照下有界生成，文件或索引变化则报告过期。 |
| 3. 迁选择提交和普通推送 | 以本机项目占用和真实索引锁保护独立索引，只加入所选整文件，保留原配置、hooks/签名和身份。核对实际提交并只同步所选索引项。提交与推送结果分开；组合操作用提交确认后重新读取的状态和实际 SHA，核对分支及实际 upstream 与原目标一致再推送。向既有目标用固定 SHA 普通推送，失败或待确认仍保留已确认 SHA。 |
| 4. 构建并走一次正常路径 | 构建及检查受影响包，通过已构建公开入口执行下节的一次本机冒烟，核对 Git 的实际本地和远端状态后交付。 |

按 [预研来源表](../research/199-文件与Git服务迁移.md) 和 [旧 Git 策略](../../../packages/cli/src/infrastructure/workspace-git.ts) 逐项迁移。项目服务的公开入口和必要内部模块归 `packages/project-service/`。本机停点可以使用新平台已有类型，公开本机入口通过该包现有根出口提供。保留旧迁移来源；本停点不改变根锁、共享契约、Runner、Java、Electron 或 UI 代码。共享文件如有真实前置，交统筹协调。实施按当前共享工作树的约定进行，阶段通过由统筹处理。[项目包入口](../../../packages/project-service/src/index.ts) · [并行开发约定](../project/协作任务并行开发约定.md)

### 一次冒烟的查看方式

准备独立临时工作树与本地 bare remote（只接收 Git 引用的仓库），建立初始提交和已存在 upstream。使用测试 Git 身份。在两个已跟踪文件中，分别准备要提交的变更和要保留的变更；未选文件的暂存文本与工作区文本故意不同。准备过程只用本次临时目录。

1. 通过公开入口注入临时仓库根，列目录、查到目标候选、打开文本并核对正文。读取 Git 状态和目标文件相对 HEAD 的 Diff。
2. 只选目标文件并提交。核对服务确认的 SHA 与本地 HEAD 相等，且提交树只改变该文件。直接读 Git 索引及工作区，确认未选文件各自的文本仍在。
3. 以提交后状态和确认的 SHA 向已存在的 upstream 普通推送，核对独立的推送结果和 bare remote 的目标 ref。记录可复现命令、实际 SHA、观察值及检查结果，收尾只清理本次临时数据。

必要工程检查按影响运行 `npm run build --workspace @workbench/project-service`、`npm run typecheck --workspace @workbench/project-service` 和 `npm run check:boundaries -- --self-check`。已有且未受影响的依赖构建结果可沿用；若新引用需要其产物，先构建对应依赖。冒烟通过项目服务公开入口运行，不另起产品服务或使用真实仓库、外部远端和凭据。完整异常、跨设备和平台组合归 HC-204。完成本停点后回调统筹，记录实际本机证据并等待后续派发。[旧 Git 夹具](../../../packages/cli/tests/infrastructure/workspace-git.test.ts) · [HC-204 Task](../task/HC-204-双平台交付与内网演示.md)

## 2. 第二停点：原设备项目只读路由

**可演示结果。** 另一工作区成员登录隔离的 Java 服务，选定绑定了设备所有者明确共享项目的会话，依次请求文件树、候选、文件预览、Git 状态和 Diff。HTTP 响应中的内容与原设备 Runner 所在的临时项目一致。该项目由受信服务端演示准备明确绑定为纯本地来源；设备连接 ready 且声明支持项目读取。演示不需要真实 Agent。

第 8 节的业务规格、现有 HC-196 设备通道和本机项目服务是实施依据。先与统筹安排共用文件及构建时隙，再按以下依赖顺序实施。共享文件可由统筹串行集成，各端以同源契约对齐。[HC-199 Spec 第 8 节](../spec/HC-199-文件与Git服务迁移.md#8-原设备只读项目路由下一停点) · [HC-196 Spec](../spec/HC-196-设备接入与本机执行.md)

| 顺序 | 实施及交付 |
| --- | --- |
| 1. 共同契约和握手 | 在 `packages/workbench-contracts` 定义五项具名读取、HTTP 请求/响应、`project.read` / `project.read.result` 的闭合数据、错误及夹具，同步 schema、OpenAPI、聚合出口与资源清单。设备升级增加可选 `X-Workbench-Device-Capabilities: project.read`，`DeviceHandshakeInterceptor.java` 在认证后保存本次声明，`DeviceChannel.java` 把它绑定到当前连接。旧连接缺能力时读取提示未接入，现有执行继续。Runner 在安装端口时声明；旧服务继续使用既有握手。 |
| 2. Java 授权和只读派发 | 复用 `WorkspaceAccess`、会话固定原项目、`DeviceService.java` 设备/共享版本和 ready 状态。为读取提供不依赖 Agent 配置的共享事实入口。新增会话级读取控制器、服务及受信项目来源授权入口，在 `RouteCatalog.java` 和必要的服务装配处登记。首次和返回前核验用户会话、成员、原绑定及共享版本。纯本地演示来源由受信服务端准备绑定现有项目及版本。托管来源交内网身份/仓库读权适配，未能确认时返回不可用。 |
| 3. 连接关联和资源限额 | 在 `DeviceChannel.java` 登记当前连接上的等待请求并检查能力，发送只读帧，按原设备/连接/项目/版本/消息 ID/动作匹配回包。单次读取以 8 秒覆盖授权、等待和返回前复核；每设备 4 个、全服务 128 个等待记录。取消、断连、替换或超时释放等待记录，迟到帧按规格处理。完整设备消息按编码后的 256 KiB 限额截断或返回有界错误。 |
| 4. Runner 本机接入 | `packages/runner-core/src/device-connection.ts` 接受受控五项只读端口，检查本连接 ready、项目与共享版本，调用前后通过 `project-registry.ts` 复核根。限制在途读取，按请求及原连接关联回包。`apps/runner/src/runtime.ts` 从 `@workbench/project-service` 创建实际端口并注入，Runner Core 继续只定义和消费窄端口。 |
| 5. 安装图和正常启动 | `apps/runner/package.json` 增加 `@workbench/project-service` 的 workspace 依赖，同步唯一 `package-lock.json` 和 `scripts/workbench/check-boundaries.mjs`。根 `package.json` 的 `npm run dev` 当前显式构建 contracts、runner-core、runner 和 UI，须加入 project-service，保证 contracts、runner-core 和 project-service 先于 runner 构建。沿用唯一 npm 安装链并在获派时隙同步 `node_modules`。 |
| 6. 构建和真实读取 | 运行受影响的契约、Java、Runner 和项目包构建/类型/边界检查，核对根 `dev` 的构建顺序。然后按下节执行一次隔离 Java + 真实 Runner 的正常读取。证据写回本卡 Task/Todo，交统筹复核。 |

来源准备只由受信服务端的隔离演示过程设置项目/共享版本绑定。配置可预先写入候选元组，服务只在真实项目登记、所有者共享和版本匹配后认定该绑定。它仅覆盖指定演示项目和版本，不通过用户 HTTP 或桌面读请求修改。正式内网项目的可信仓库绑定和访问者本人 Git 平台读权，以 Spec 第 8.1 节为接入边界。

握手字段和新消息由 HC-196/199 与统筹在共享契约及设备源码时隙内顺序集成；`package.json`、根锁、边界脚本、Java 安全/资源聚合也按该时隙协调。与 HC-202 的正式桌面冒烟错开 Java/MySQL 生命周期，或使用独立实例、数据库及监听端口。只管理本次启动的进程和临时数据。[并行开发约定](../project/协作任务并行开发约定.md)

### 一次真实冒烟的查看方式

在独立实例或已协调的独占时隙准备 Java、数据库、两个启用工作区成员、真实 Runner 账本和一个临时 Git 项目。项目由设备所有者登记并明确共享，受信服务端演示准备按实际项目 ID 和共享版本绑定纯本地来源。会话按现有链路绑定该设备和项目，所需登记字段沿用 HC-196。Runner 通过现有 WSS 恢复至 ready 并在升级时声明 `project.read`。

另一成员登录后，通过真实 Java HTTP 连续请求 `listDirectory`、`searchCandidates`、`readPreview`、`gitStatus` 和 `gitDiff`。从设备端临时文件取得已知正文和修改内容，对照 HTTP 返回的路径、正文、状态、快照与 Diff；记录响应来自原设备的关联结果。冒烟完成后退出本次 Java/Runner 进程并按实际范围清理隔离数据，回调统筹一次。

必要检查使用 `npm run contracts:smoke`、`npm run server:build`、`npm run server:contracts`、受影响 workspace 的 build/typecheck 与 `npm run check:boundaries -- --self-check`。能力头存在/缺失及新旧消息的契约和判定做必要的轻量检查，确保旧连接不会收到新帧。一次真实冒烟覆盖新连接的正常读取。完整跨版本组合、异常矩阵、双平台与目标 TDSQL 归 HC-204。

## 3. 后续接线接口与前置

| 交界 | 后续需要满足的前置 |
| --- | --- |
| 内网项目及线上写入 | 托管仓库可信绑定、访问者本人 Git 身份与仓库读权按 Spec 接入。跨用户在原设备创建提交的权限待产品确认；线上推送使用操作者身份。对应写请求关联/占用/回执和原请求核对另行派发。 |
| HC-207 / HC-202 桌面装配 | 只读路由与实际状态就绪后，映射既有受控文件与 Git 视图、HC-206 文件候选及当次会话内存缓存。写入结果按后续已交付端口接入。持有原 scope 与请求关联，按实际授权和非实时状态显示。 |
| ACP 及 Agent/Git 写占用 | 同事完成 ACP 交付后再评审实际生命周期、协议接线、统一占用和真实在途写入。 |

共享历史与引用的 Git 权限、内网仓库真实授权、线上写入、桌面消费及 ACP 各按对应阶段安排。[HC-196 Spec](../spec/HC-196-设备接入与本机执行.md) · [HC-207 Spec](../spec/HC-207-文件与变更视图复用.md) · [HC-202 Task](../task/HC-202-桌面工作台视图迁移.md)
