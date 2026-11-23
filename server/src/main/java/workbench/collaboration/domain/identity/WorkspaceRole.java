package workbench.collaboration.domain.identity;

/** 团队管理角色，与 Project 的 owner/member 完全独立。 */
public enum WorkspaceRole {
    ADMIN(1, "admin"), DEVELOPER(2, "developer");
    public final int db;
    public final String wire;
    WorkspaceRole(int db, String wire) { this.db=db; this.wire=wire; }
    public static WorkspaceRole fromDb(int value) {
        for (var role : values()) if (role.db==value) return role;
        throw new IllegalStateException("团队角色未初始化");
    }
}
