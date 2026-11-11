-- HC-196 设备与项目共享元数据：三表；V001 身份基础不改。
-- 秘密只保存 SHA-256 摘要；共享版本为内部 epoch 毫秒/递增整数，线上转换为十进制字符串。
CREATE TABLE wb_device (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ledger_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  secret_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_installation (installation_id),
  UNIQUE KEY uk_device_ledger (ledger_id),
  KEY idx_device_workspace (workspace_id, created_at_ms, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_device_project (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  root_ref VARCHAR(128) NOT NULL,
  share_enabled TINYINT NOT NULL,
  share_version BIGINT NOT NULL,
  agent_configs_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_device_root (device_id, root_ref),
  KEY idx_project_device (device_id, created_at_ms, id),
  KEY idx_project_workspace (workspace_id, share_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 同一操作/范围内 requestId 只保存首次正文与回执；重试不产生第二份结果。
CREATE TABLE wb_device_request (
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) NOT NULL,
  scope VARCHAR(160) NOT NULL,
  body_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_json MEDIUMTEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (operation, scope, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
