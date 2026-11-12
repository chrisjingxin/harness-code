-- 身份与工作区。物理主键顺序追加；业务 UUID 只走唯一索引。
CREATE TABLE wb_user (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(32) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  enabled TINYINT(1) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_user_id (id),
  UNIQUE KEY uk_user_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_workspace (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(40) NOT NULL,
  name VARCHAR(80) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_workspace_id (id),
  UNIQUE KEY uk_workspace_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_workspace_member (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_workspace_member (workspace_id, user_id),
  KEY idx_member_user (user_id, workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
