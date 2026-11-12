-- 一个会话一行。消息正文、执行流水和请求回执不进 TDSQL。
CREATE TABLE wb_conversation (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_sequence BIGINT NOT NULL,
  native_session_id VARCHAR(512) NULL,
  active_execution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_conversation_id (id),
  KEY idx_conversation_workspace (workspace_id, created_at_ms, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
