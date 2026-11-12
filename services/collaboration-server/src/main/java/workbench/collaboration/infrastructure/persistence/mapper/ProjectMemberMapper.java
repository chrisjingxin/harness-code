package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.ProjectMemberPO;

/**
 * 模块：项目成员表数据访问映射接口 (ProjectMemberMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_project_member 表的持久化查询。
 * upsert 走数据库 ON DUPLICATE KEY 原子语义：行在则翻状态/时间，行不在则插入，
 * 避免"先查后写"在并发加人/踢人下的竞态窗口。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface ProjectMemberMapper extends BaseMapper<ProjectMemberPO> {

    /**
     * 幂等写入成员记录：唯一键冲突时更新 status 与 updated_at，保留原 created_at。
     */
    @Insert("INSERT INTO wb_project_member (project_id, user_id, status, created_at, updated_at)"
            + " VALUES (#{projectId}, #{userId}, #{status}, #{createdAt}, #{updatedAt})"
            + " ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = VALUES(updated_at)")
    int upsert(ProjectMemberPO po);
}
