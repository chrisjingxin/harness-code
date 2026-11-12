package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：会话涉及仓库关联持久化对象 (ConversationRepoRefPO)
 *
 * <p>【功能定义】
 * 对应 TDSQL 表 wb_conversation_repository：登记会话时写入的快照关联，
 * 取值必须是当时项目引用集合的子集；项目后续取消引用不影响此历史事实。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationRepoRefMapper、ConversationRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_conversation_repository")
public class ConversationRepoRefPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 会话标识 */
    @TableField("conversation_id")
    private String conversationId;

    /** 团队仓库目录条目标识 */
    @TableField("repository_id")
    private String repositoryId;

    /** 关联写入时间戳（毫秒） */
    @TableField("created_at")
    private LocalDateTime createdAt;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
    }

    public String getConversationId() {
        return conversationId;
    }

    public void setConversationId(String conversationId) {
        this.conversationId = conversationId;
    }

    public String getRepositoryId() {
        return repositoryId;
    }

    public void setRepositoryId(String repositoryId) {
        this.repositoryId = repositoryId;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
