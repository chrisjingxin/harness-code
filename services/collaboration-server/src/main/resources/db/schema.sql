-- 协作中继服务单文件 DDL（HC-211，方案 D7）
-- 唯一建表依据：应用从不执行 DDL，启动时只读核对本文件声明的全部表与关键列。
--
-- 团队数据库规范落实说明：
-- 1. 全表 utf8mb4 + utf8mb4_unicode_ci；id 类关联列统一覆写 ascii_bin（规则 15 跨表一致）。
-- 2. 物理主键 pk_id BIGINT UNSIGNED AUTO_INCREMENT（规则 2/3）；UUID 仅作唯一业务索引。
-- 3. 时间列统一 DATETIME(3) UTC 毫秒精度（规则 10）；写入一律 UTC 墙钟，与应用层 epoch-ms 互转。
-- 4. 低基数状态列统一 TINYINT UNSIGNED 数值码（规则 9），枚举词见列注释。
-- 5. 全部列 NOT NULL（规则 6）：可空语义以 '' 空串哨兵表达"未绑定/未生成"。
-- 6. 索引命名 uk_字段名 / idx_字段名（规则 5）；无外键/触发器/过程/视图（规则 18/19）。
-- 7. remote_url 唯一约束落到 SHA-256 摘要列：前缀索引会产生 >255 字符误冲突。
-- 8. DATETIME(3) 由应用写入；禁止依赖 CURRENT_TIMESTAMP 隐式默认值。
--
-- 状态数值码约定：TINYINT 从 1 起编，0 保留给"未知/哨兵"含义，不使用。

-- ============ 身份与团队 ============

CREATE TABLE wb_user (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '用户全局唯一业务标识(UUID)',
  username VARCHAR(32) NOT NULL COMMENT '登录用户名',
  display_name VARCHAR(80) NOT NULL COMMENT '对外展示名称',
  enabled TINYINT UNSIGNED NOT NULL COMMENT '账号是否启用：0=停用,1=启用',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户账号表';

CREATE TABLE wb_workspace (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '工作区全局唯一业务标识(UUID)',
  slug VARCHAR(40) NOT NULL COMMENT 'URL 友好短路径标识',
  name VARCHAR(80) NOT NULL COMMENT '工作区展示名称',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  UNIQUE KEY uk_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作区(团队)表';

CREATE TABLE wb_workspace_member (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属工作区标识',
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '成员用户标识',
  created_at DATETIME(3) NOT NULL COMMENT '加入时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_workspace_id_user_id (workspace_id, user_id),
  KEY idx_user_id_workspace_id (user_id, workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作区成员关联表';

-- ============ 设备（D11：属人不属团队，无 workspace_id） ============

CREATE TABLE wb_device (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '设备全局唯一业务标识(UUID)',
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '设备所属用户标识',
  installation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '本机客户端安装实例标识',
  ledger_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '本机客户端状态账本标识',
  name VARCHAR(80) NOT NULL COMMENT '设备展示别名',
  secret_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '设备凭据 SHA-256 摘要(不存明文)',
  registration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '首次注册请求标识(幂等)',
  registration_body_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '首次注册报文主体 SHA-256',
  revoked TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '是否已吊销：0=正常,1=已吊销(禁止上传与同步)',
  created_at DATETIME(3) NOT NULL COMMENT '注册时间(UTC)',
  updated_at DATETIME(3) NOT NULL COMMENT '最近修改时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  KEY idx_owner_user_id_created_at (owner_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='本机执行设备档案表';

-- ============ 团队仓库目录（D3：团队级资产） ============

CREATE TABLE wb_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '仓库全局唯一业务标识(UUID)',
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属团队标识',
  name VARCHAR(120) NOT NULL COMMENT '目录显示名',
  remote_url VARCHAR(512) NOT NULL COMMENT '远端仓库地址',
  remote_url_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'remote_url 的 SHA-256(团队内唯一，替代前缀索引)',
  default_branch VARCHAR(128) NOT NULL COMMENT '默认分支名',
  status TINYINT UNSIGNED NOT NULL COMMENT '目录状态：1=active,2=archived',
  created_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '登记者用户标识',
  created_at DATETIME(3) NOT NULL COMMENT '登记时间(UTC)',
  updated_at DATETIME(3) NOT NULL COMMENT '最近修改时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  UNIQUE KEY uk_workspace_id_remote_url_sha256 (workspace_id, remote_url_sha256),
  KEY idx_workspace_id_status (workspace_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='团队仓库目录表';

-- ============ 业务项目与成员 ============

CREATE TABLE wb_project (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '项目全局唯一业务标识(UUID)',
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属团队标识',
  name VARCHAR(80) NOT NULL COMMENT '项目显示名',
  description VARCHAR(2000) NOT NULL COMMENT '项目说明',
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '项目负责人用户标识',
  status TINYINT UNSIGNED NOT NULL COMMENT '项目状态：1=active,2=archived',
  version BIGINT NOT NULL DEFAULT 1 COMMENT '乐观并发版本号，创建为1，每次CAS写入+1',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间(UTC)',
  updated_at DATETIME(3) NOT NULL COMMENT '最近修改时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  KEY idx_workspace_id_status (workspace_id, status),
  KEY idx_owner_user_id (owner_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务项目表';

CREATE TABLE wb_project_member (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属项目标识',
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '成员用户标识',
  status TINYINT UNSIGNED NOT NULL COMMENT '成员状态：1=active,2=removed(移出保留不删,D9)',
  created_at DATETIME(3) NOT NULL COMMENT '首次加入时间(UTC，回active保留原值)',
  updated_at DATETIME(3) NOT NULL COMMENT '状态最近变更时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_project_id_user_id (project_id, user_id),
  KEY idx_user_id_status (user_id, status),
  KEY idx_project_id_created_at (project_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目成员关联表';

CREATE TABLE wb_project_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '引用方项目标识',
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '被引用的团队仓库标识',
  created_at DATETIME(3) NOT NULL COMMENT '引用建立时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_project_id_repository_id (project_id, repository_id),
  KEY idx_repository_id (repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目仓库引用表';

-- ============ 本机仓库登记（设备×仓库；本地绝对路径只存本机，不上云） ============

CREATE TABLE wb_local_repo_binding (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '登记设备标识',
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '团队仓库目录条目标识',
  created_at DATETIME(3) NOT NULL COMMENT '最近一次登记时间(UTC，重复upsert刷新)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_device_id_repository_id (device_id, repository_id),
  KEY idx_repository_id (repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='设备本机仓库登记表';

-- ============ 会话（新形态：owner 固定 + 项目归属 + 简报 + 已同步序号） ============

CREATE TABLE wb_conversation (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话全局唯一业务标识(UUID)',
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属工作区标识',
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属业务项目标识',
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话主人用户标识(创建者,固定不变)',
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '主人执行设备标识',
  agent_config_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '' COMMENT '绑定的Agent配置标识(''表示未绑定)',
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '' COMMENT '关联任务卡片标识(''表示无,HC-212写入)',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '会话状态：1=idle,2=running,3=waiting_approval,4=error',
  title VARCHAR(120) NOT NULL COMMENT '会话标题',
  brief_text VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '最近简报正文(''表示无简报)',
  brief_source TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '简报来源：1=rule,2=agent(agent为B1预留)',
  brief_updated_at DATETIME(3) NOT NULL COMMENT '简报最近更新时间(UTC，登记时取created_at基线)',
  synced_sequence BIGINT NOT NULL DEFAULT 0 COMMENT '已确认的最大已上传消息序号(单调水位)',
  native_session_id VARCHAR(512) NOT NULL DEFAULT '' COMMENT '绑定的底层Agent本地会话标识(''表示未绑定)',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间(UTC)',
  updated_at DATETIME(3) NOT NULL COMMENT '最近修改时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_id (id),
  KEY idx_project_id_updated_at_id (project_id, updated_at, id),
  KEY idx_owner_user_id_updated_at (owner_user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目内会话头表';

-- 会话涉及仓库（D3：必须是项目引用集合的子集，登记时写入后不再变更）
CREATE TABLE wb_conversation_repository (
  pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理聚簇自增主键',
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话标识',
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '团队仓库目录条目标识',
  created_at DATETIME(3) NOT NULL COMMENT '关联写入时间(UTC)',
  PRIMARY KEY (pk_id),
  UNIQUE KEY uk_conversation_id_repository_id (conversation_id, repository_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话涉及仓库关联表';
