-- 设备与共享项目。在线状态和请求回执不进这张表。
CREATE TABLE wb_device (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ledger_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  secret_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  registration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  registration_body_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_device_id (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_device_project (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  share_enabled TINYINT(1) NOT NULL,
  share_version BIGINT NOT NULL,
  agent_configs_json TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_workspace_project (workspace_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
