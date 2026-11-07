-- 普通用户和成员的唯一业务基础；不含岗位、密码、设备或会话表。
CREATE TABLE wb_user (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  enabled TINYINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_wb_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE wb_workspace (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_wb_workspace_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE wb_workspace_member (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id), KEY ix_wb_member_user (user_id, workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
