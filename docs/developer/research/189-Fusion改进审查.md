# Fusion 改进建议审查与实施记录

对照用户提供的《187-Fusion对照Devin改进(1).md》及 dev_wdl 的 0e2c045 源码。原文不是命令清单，以下按当前架构判断。Devin 逆向文本只作为行为线索，不能据此断言谁更强或一定省钱。已通读用户补充的 FUSION_SPEC(1).md（2026-10-29），其来源为 Devin Desktop 3.10.48 的字符串、JS 和调用链逆向；本次没有独立验证原二进制或其服务端。

| 项目 | 判断与本次处理 | 原因和验收依据 |
| --- | --- | --- |
| A 角色用量与估算 | 采纳，已实现 | 当前共享账本只有诊断日志；需累计所有调用、保留未知状态，配置价格后才估算。缓存命中率不是性能保证。 |
| B 只读探索 | 调整后采纳，已实现 | 独立只读身份和 checkpoint；不改变实施阶段，但必须记录并显示活动。不移除 Lead 核实工具，不承诺未经测量的 token 降幅。 |
| C 提示词 | 部分采纳，已实现 | 委派策略与工具操作分开。拒绝隐藏 Sidekick，与用户已确认的过程可见要求冲突。不能一概禁止用户授权的查询和业务阈值修改；保护的是 Host 验收定义和证据真实性。 |
| D 直接注入插话 | 不按原方案实现 | before_model 只控制下一次请求，不能撤销已发出的工具或对新需求追认旧效果。还缺消息受理、在途操作停止、需求版本、任务单和票据一致提交；取消后再反馈仍是当前明确路径。 |
| E 重复失败/接管 | 采纳提示，不开放 Lead 写入 | 提示可以在两个独立轮次重复失败时触发。直接授予 Lead 写权限会让同一角色既实施又验收；通用确认和 allowed_paths 不足以重建独立验收及身份/恢复契约。保留强弱模型配置选择，不能靠提示词临时变更执行身份。 |
| F 跨任务复用 | 不复用原 checkpoint | 当前 checkpoint 绑定 task、worker session、轮次和完成记录，里面还有旧工具调用和范围。默认关闭不是正确性证明；有界知识摘要与原执行 checkpoint 复用是不同设计。 |
| G 结构/文档 | 按职责采纳，已实现 | 抽出独立计算、探索和检查职责；不为行数把一笔任务/租约/effect 事务拆散。历史修复与现行规则分开，增加压缩后任务单回归。原文 302 项是旧数量，按本次实际收集验证。 |
| H 缓存保活 | 采纳先测量，不发 ping | 先用 A 查看服务实际缓存数据。没有失效证据、服务 TTL 和成本对照时发付费 ping 可能更贵；240 秒不是已证实周期。 |
| I 配对/追加 | 调整后采纳，已实现 | 同名 default 可以是不同端点和实际模型，不能告警“没有节省”；大窗口也不必然出错。可按真实相同设置或明确同币种价格提示，可信追加纳入指纹、不泄露正文。 |

实施入口： [Task](../task/archive/HC-189-双模型探索与度量.md)、[Spec](../spec/HC-189-双模型探索与度量.md)。完成后在此补充真实文件、测试结果和配置方法。

## 已实现的代码入口

| 能力 | 代码入口 | 自动验证 |
| --- | --- | --- |
| 配置价格、私有追加、冻结与配对提示 | config/model_pricing.py、config/fusion.py、runtime/fusion/profile.py | test_fusion_pricing、test_fusion_config、test_fusion_profile |
| 多次模型调用累计、失败观测、幂等落库 | runtime/model_usage.py、managed_agent_executor.py、fusion/usage.py、FusionStateStore.record_usage | test_fusion_usage、test_managed_agent_executor、原生探索集成 |
| 独立只读探索与真实取消 | resolve_exploration_spec、FusionService.explore、FusionWorkerRunner.run、FusionWriteGuard | test_fusion_explore（Host 和 runtime） |
| 提示词与跨轮建议 | fusion/prompts.py、guidance.py、tools.py | test_fusion_roles、test_fusion_guidance |
| 同页过程与状态 | fusion-summary.ts、fusion-execution.ts、timeline-activity-groups.ts | fusion-metrics、fusion-execution、fusion-feature、fusion-timeline |
| 结构整理与压缩 | FusionAcceptance、FusionWorkerRunner；历史记录独立成文 | 原有 Fusion 全组、test_fusion_compaction 的连续两次真实摘要 |

表内 Python 路径相对 packages/agent/harness_agent，测试相对 packages/agent/tests。协议仍用 canonical v3.11 的同一内部构建，增加可选状态字段；schema 生成两端类型、校验器和共享 fixture，不手改生成产物。

## 仍未照搬及证据范围

- D：目标有价值，但原方案缺少在途工具、需求版本和票据一起提交的完整控制协议，本次没有加入可能把过期写入当成新要求结果的消息注入。
- E 第二步：未增加 takeover。保留 Lead 判断/验收、Sidekick 实施的隔离；更强执行模型可以由用户另设可信组合，不靠运行时临时放权。
- F：没有跨任务复用原 checkpoint。探索采用每次临时上下文，同一实施任务返工仍持续原上下文。
- G：没有把每笔 SQL 按文件行数分散。任务、写权限、派发和副作用的原子提交保留在 Store；拆的是可独立解释的验收、模型执行和用量计算职责。
- H：没有发付费 ping，也没有对用户真实服务做 1/10 分钟缓存实验。角色缓存字段及调用 evidence 是测量基础；实际 TTL、缓存写入计费和收益需在真实服务另测，不把 240 秒当事实。
- I：没有“同名模型一定没省钱”或“大窗口一定有问题”的警告；实际相同设置和明确价格提醒在任务状态中显示。
- 没有实现自动切模、能力分类器、后台双写并行或为了掩盖 Lead 直接编辑而注入纠偏文字；逆向规格也没有证明云端策略在本地已接线。

配置和操作见 [用户指南第 8–10 节](../../user/fusion-guide.md#8-让-sidekick-先调查代码)。最终测试结果记入 [Task](../task/archive/HC-189-双模型探索与度量.md)。本次自动测试使用假模型，不声称已测出商业模型的降本比例或任务成功率增幅。

## 本次验证结论

原有 Fusion 基线 416 通过。完整 Python 包 3428 通过，3 项既有 Qwen 失败已在改动前 HEAD 快照复现；最终专项 662 通过，详细命令以归档 Task 为准。Native 探索 5 项、CLI 相关 69 项通过；CLI 正式清单还有 2 项既有断言失败，均在 HEAD 快照复现。类型、构建、协议、依赖、任务检查通过；本次文档链接通过，项目级文档检查仍有既有 182 号研究文档失效链接。

另外验证并修复了原建议未展开的资源边界：最小池容量为 2 时可在探索、实施、再次探索和返工之间切换；每次借用前重新登记冻结执行规格。其他活跃执行占满池时，探索返回可操作提示，Lead 可读取关键文件或等待，不要求结束其他正常任务。
