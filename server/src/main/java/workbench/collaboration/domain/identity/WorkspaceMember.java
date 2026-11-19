package workbench.collaboration.domain.identity;

/**
 * 模块：工作区成员关联模型 (WorkspaceMember)
 *
 * <p>【功能定义】
 * 描述用户（User）与工作区（Workspace）之间的多对多归属成员关系。
 * 作为租户越权拦截、数据隔离与会话准入的第一道权限基石。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、IdentityRepository、BoundaryFilter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param workspaceId 所属工作区业务标识
 * @param userId 归属用户的业务标识
 * @param createdAtMs 加入工作区的时间戳（毫秒）
 */
public record WorkspaceMember(
        String workspaceId,
        String userId,
        long createdAtMs
) {}
