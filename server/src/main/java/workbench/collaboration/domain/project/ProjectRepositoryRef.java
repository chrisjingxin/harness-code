package workbench.collaboration.domain.project;

/**
 * 模块：项目仓库引用实体 (ProjectRepositoryRef)
 *
 * <p>【功能定义】
 * 表示项目对团队仓库目录中某个仓库的引用（wb_project_repository）。
 * 会话登记时涉及仓库必须属于本引用集合（D3 子集约束）；
 * 取消引用不影响既有会话的历史仓库关联。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAppService、ConversationSyncAppService、ProjectConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param projectId 引用方项目标识
 * @param repositoryId 被引用的团队仓库标识
 * @param createdAtMs 引用建立时间戳（毫秒）
 */
public record ProjectRepositoryRef(
        String projectId,
        String repositoryId,
        long createdAtMs
) {}
