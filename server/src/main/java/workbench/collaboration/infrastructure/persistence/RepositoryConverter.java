package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.contract.Digests;

/**
 * 模块：团队仓库目录持久化对象与领域模型转换器 (RepositoryConverter)
 *
 * <p>【功能定义】
 * 提供 Repository 领域实体与对应 PO 之间的双向转换。
 * status 列与 RepositoryStatus 枚举互转；未知枚举值在读取侧直接抛错（数据完整性哨兵）。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryCatalogImpl。
 * - 下游依赖方：Repository、RepositoryPO。
 */
final class RepositoryConverter {

    private RepositoryConverter() {}

    static RepositoryPO toPo(Repository repository) {
        RepositoryPO po = new RepositoryPO();
        po.setRepositoryId(repository.id());
        po.setWorkspaceId(repository.workspaceId());
        po.setName(repository.name());
        po.setRemoteUrl(repository.remoteUrl());
        // 唯一约束落在摘要列：应用侧算摘要写入，DB 对 (workspace_id, remote_url_sha256) 兜底
        po.setRemoteUrlSha256(Digests.sha256Hex(repository.remoteUrl()));
        po.setDefaultBranch(repository.defaultBranch());
        po.setStatus(repository.status().db());
        po.setCreatedByUserId(repository.createdByUserId());
        po.setCreatedAt(Times.ofMs(repository.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(repository.updatedAtMs()));
        return po;
    }

    static Repository toRepository(RepositoryPO po) {
        return new Repository(
                po.getRepositoryId(),
                po.getWorkspaceId(),
                po.getName(),
                po.getRemoteUrl(),
                po.getDefaultBranch(),
                RepositoryStatus.fromDb(po.getStatus()),
                po.getCreatedByUserId(),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }
}
