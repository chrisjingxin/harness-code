-- HC-195 共享会话六表：会话、消息、执行、事件、来源回执、请求回执。
-- 消息/执行/事件/回执与初始 queued 由同一短事务提交；决定字段内联在执行行，不另建决定表。
CREATE TABLE wb_conversation (
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
  PRIMARY KEY (id),
  KEY idx_conversation_workspace (workspace_id, created_at_ms, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_message (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_kind VARCHAR(16) NOT NULL,
  author_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  author_username VARCHAR(32) NULL,
  author_display_name VARCHAR(80) NULL,
  agent_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_sequence BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  text MEDIUMTEXT NOT NULL,
  state VARCHAR(16) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_message_sequence (conversation_id, created_sequence),
  KEY idx_message_execution (execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_execution (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_sequence BIGINT NOT NULL,
  initiated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  share_version BIGINT NOT NULL,
  state VARCHAR(24) NOT NULL,
  last_confirmed_state VARCHAR(24) NOT NULL,
  cancel_state VARCHAR(16) NOT NULL,
  reason_code VARCHAR(40) NULL,
  start_command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  start_body_sha256 CHAR(64) NULL,
  start_json MEDIUMTEXT NULL,
  decision_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  decision_json MEDIUMTEXT NULL,
  native_session_id VARCHAR(512) NULL,
  cancel_command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  cancel_json MEDIUMTEXT NULL,
  cancel_requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  runner_sequence BIGINT NOT NULL,
  last_committed_runner_sequence BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_input (input_id),
  UNIQUE KEY uk_execution_sequence (conversation_id, input_sequence),
  UNIQUE KEY uk_execution_start (start_command_id),
  KEY idx_execution_state (state, created_at_ms, id),
  KEY idx_execution_conversation (conversation_id, created_at_ms, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_execution_event (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence BIGINT NOT NULL,
  event_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  payload_json MEDIUMTEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_event_sequence (conversation_id, sequence),
  KEY idx_event_conversation (conversation_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_execution_receipt (
  source_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  runner_sequence BIGINT NOT NULL,
  canonical_body MEDIUMTEXT NOT NULL,
  PRIMARY KEY (source_event_id),
  UNIQUE KEY uk_source_sequence (execution_id, runner_sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_request_receipt (
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) NOT NULL,
  canonical_body MEDIUMTEXT NOT NULL,
  response_json MEDIUMTEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id, operation, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
