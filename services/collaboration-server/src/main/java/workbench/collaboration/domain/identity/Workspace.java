package workbench.collaboration.domain.identity;

/**
 * 模块：工作区实体模型 (Workspace)
 *
 * <p>【功能定义】
 * 表示协作工作台的多租户隔离边界——工作区（Workspace）。
 * 团队仓库目录（Repository）、业务项目（Project）与其下的会话（Conversation）均挂载于工作区下。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、IdentityRepository、IdentityConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 工作区全局唯一业务标识 (UUID)
 * @param slug 工作区在 URL 路径与路由中的友好短路径标识（如 "team-alpha"）
 * @param name 工作区展示名称
 * @param createdAtMs 工作区创建时间戳（毫秒）
 */
public record Workspace(
        String id,
        String slug,
        String name,
        long createdAtMs
) {}
