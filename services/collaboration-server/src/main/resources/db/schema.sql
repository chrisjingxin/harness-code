-- 协作中继服务单文件 DDL（HC-211，方案 D7）
-- 唯一建表依据：应用从不执行 DDL，启动时只读核对本文件声明的全部表与关键列。
-- 规范：无外键、无触发器；物理自增主键 pk_id + 业务 CHAR(36) id 唯一索引；utf8mb4。

-- ============ 身份与团队（沿用原 V001） ============

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

-- ============ 设备（D11：属人不属团队，无 workspace_id） ============

CREATE TABLE wb_device (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

-- ============ 团队仓库目录（D3：团队级资产） ============

CREATE TABLE wb_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  remote_url VARCHAR(512) NOT NULL,
  default_branch VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL COMMENT 'active|archived',
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_repository_id (id),
  UNIQUE KEY uk_repository_remote (workspace_id, remote_url(255)),
  KEY idx_repository_workspace (workspace_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============ 业务项目与成员 ============

CREATE TABLE wb_project (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(2000) NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL COMMENT 'active|archived',
  version BIGINT NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_project_id (id),
  KEY idx_project_workspace (workspace_id, status),
  KEY idx_project_owner (owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_project_member (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL COMMENT 'active|removed',
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_project_member (project_id, user_id),
  KEY idx_project_member_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wb_project_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_project_repository (project_id, repository_id),
  KEY idx_project_repository_repo (repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============ 本机仓库登记（设备×仓库；本地绝对路径只存本机，不上云） ============

CREATE TABLE wb_local_repo_binding (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_local_binding (device_id, repository_id),
  KEY idx_local_binding_repo (repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============ 会话（新形态：owner 固定 + 项目归属 + 简报 + 已同步序号） ============

CREATE TABLE wb_conversation (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'idle' COMMENT 'idle|running|waiting_approval|error',
  title VARCHAR(120) NOT NULL,
  brief_text VARCHAR(2000) NULL,
  brief_source VARCHAR(8) NOT NULL DEFAULT 'rule' COMMENT 'rule|agent（agent 为 B1 预留）',
  brief_updated_at_ms BIGINT NULL,
  synced_sequence BIGINT NOT NULL DEFAULT 0,
  native_session_id VARCHAR(512) NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_conversation_id (id),
  KEY idx_conversation_project (project_id, updated_at_ms),
  KEY idx_conversation_owner (owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 会话涉及仓库（D3：必须是项目引用集合的子集，登记时写入后不再变更）
CREATE TABLE wb_conversation_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_conversation_repository (conversation_id, repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
