package workbench.collaboration.support;

import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.repository.LocalRepoBinding;
import workbench.collaboration.domain.repository.LocalRepoBindingRepository;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 组织层应用服务测试共用的内存仓储 fake。
 * 语义对齐真实持久层：CAS 版本校验、成员 upsert 保留历史、
 * 引用/绑定按唯一键幂等、目录按 workspace+status 过滤。
 */
public final class FakeStores {

    private FakeStores() {}

    public static final class FakeIdentity implements IdentityRepository {
        public final Map<String, User> users = new HashMap<>();
        public final List<String> members = new ArrayList<>();

        public void addMember(String workspaceId, String userId) {
            members.add(workspaceId + ":" + userId);
        }

        @Override public Optional<User> findUserById(String id) { return Optional.ofNullable(users.get(id)); }
        @Override public Optional<User> findUserByUsername(String username) { return Optional.empty(); }
        @Override public void insertUser(User user) { users.put(user.id(), user); }
        @Override public Optional<Workspace> findWorkspaceById(String id) { return Optional.empty(); }
        @Override public Optional<Workspace> findWorkspaceBySlug(String slug) { return Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return members.contains(workspaceId + ":" + userId); }
        @Override public void insertMember(WorkspaceMember member) { members.add(member.workspaceId() + ":" + member.userId()); }
        @Override public List<User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) { return List.of(); }
        @Override public List<User> listMembers(String workspaceId) { return List.of(); }
    }

    public static final class FakeProjects implements ProjectRepository {
        public final Map<String, Project> projects = new HashMap<>();
        public final Map<String, ProjectMember> members = new HashMap<>();
        public final Map<String, ProjectRepositoryRef> refs = new HashMap<>();

        @Override public Optional<Project> findById(String id) { return Optional.ofNullable(projects.get(id)); }
        @Override public void insert(Project project) { projects.put(project.id(), project); }
        @Override public boolean updateIfVersion(Project project, long expectedVersion) {
            Project stored = projects.get(project.id());
            if (stored == null || stored.version() != expectedVersion) {
                return false;
            }
            projects.put(project.id(), new Project(
                    project.id(), project.workspaceId(), project.name(), project.description(),
                    project.ownerUserId(), project.status(), project.version() + 1,
                    project.createdAtMs(), project.updatedAtMs()));
            return true;
        }
        @Override public List<Project> listForMember(String workspaceId, String userId) {
            return members.values().stream()
                    .filter(m -> m.userId().equals(userId) && m.status() == MemberStatus.ACTIVE)
                    .map(m -> projects.get(m.projectId()))
                    .filter(p -> p != null && p.workspaceId().equals(workspaceId))
                    .toList();
        }
        @Override public Optional<ProjectMember> findMember(String projectId, String userId) {
            return Optional.ofNullable(members.get(projectId + ":" + userId));
        }
        @Override public List<ProjectMember> listMembers(String projectId) {
            return members.values().stream().filter(m -> m.projectId().equals(projectId)).toList();
        }
        @Override public void upsertMember(ProjectMember member) { members.put(member.projectId() + ":" + member.userId(), member); }
        @Override public int countMembers(String projectId, MemberStatus status) {
            return (int) members.values().stream()
                    .filter(m -> m.projectId().equals(projectId) && m.status() == status).count();
        }
        @Override public boolean referenceExists(String projectId, String repositoryId) {
            return refs.containsKey(projectId + ":" + repositoryId);
        }
        @Override public void insertReference(ProjectRepositoryRef reference) {
            refs.put(reference.projectId() + ":" + reference.repositoryId(), reference);
        }
        @Override public int deleteReference(String projectId, String repositoryId) {
            return refs.remove(projectId + ":" + repositoryId) != null ? 1 : 0;
        }
        @Override public List<ProjectRepositoryRef> listReferences(String projectId) {
            return refs.values().stream().filter(r -> r.projectId().equals(projectId)).toList();
        }
        @Override public List<ProjectRepositoryRef> listReferencesByRepository(String repositoryId) {
            return refs.values().stream().filter(r -> r.repositoryId().equals(repositoryId)).toList();
        }
    }

    public static final class FakeRepositories implements RepositoryCatalog {
        public final Map<String, Repository> items = new HashMap<>();

        @Override public Optional<Repository> findById(String id) { return Optional.ofNullable(items.get(id)); }
        @Override public void insert(Repository repository) {
            if (items.values().stream().anyMatch(r -> r.remoteUrl().equals(repository.remoteUrl()))) {
                throw new org.springframework.dao.DuplicateKeyException("remote_url");
            }
            items.put(repository.id(), repository);
        }
        @Override public void update(Repository repository) { items.put(repository.id(), repository); }
        @Override public List<Repository> listByWorkspace(String workspaceId, RepositoryStatus status) {
            return items.values().stream()
                    .filter(r -> r.workspaceId().equals(workspaceId))
                    .filter(r -> status == null || r.status() == status)
                    .sorted(Comparator.comparing(Repository::name))
                    .toList();
        }
    }

    public static final class FakeBindings implements LocalRepoBindingRepository {
        public final Map<String, LocalRepoBinding> items = new HashMap<>();

        @Override public void upsert(LocalRepoBinding binding) {
            items.put(binding.deviceId() + ":" + binding.repositoryId(), binding);
        }
        @Override public int delete(String deviceId, String repositoryId) {
            return items.remove(deviceId + ":" + repositoryId) != null ? 1 : 0;
        }
        @Override public boolean exists(String deviceId, String repositoryId) {
            return items.containsKey(deviceId + ":" + repositoryId);
        }
        @Override public List<LocalRepoBinding> listByDevice(String deviceId) {
            return items.values().stream().filter(b -> b.deviceId().equals(deviceId)).toList();
        }
        @Override public List<LocalRepoBinding> listByRepository(String repositoryId) {
            return items.values().stream().filter(b -> b.repositoryId().equals(repositoryId)).toList();
        }
    }

    public static final class FakeDevices implements DeviceRepository {
        public final Map<String, Device> items = new HashMap<>();

        @Override public Optional<Device> findById(String id) { return Optional.ofNullable(items.get(id)); }
        @Override public void insert(Device device) { items.put(device.id(), device); }
        @Override public void update(Device device) { items.put(device.id(), device); }
        @Override public List<Device> listByOwner(String ownerUserId, Long beforeCreatedAtMs, String beforeId, int limit) {
            return items.values().stream()
                    .filter(d -> d.ownerUserId().equals(ownerUserId))
                    .limit(limit)
                    .toList();
        }
    }
}
