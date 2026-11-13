-- 演示数据（可选执行）：与 Application init-demo 互补——init-demo 只保证用户/团队/成员，
-- 本文件预置演示项目、团队仓库、项目引用与本机登记，便于冒烟直接走通组织层。
-- 幂等：按业务唯一键 INSERT IGNORE，可重复执行。
-- 时间列一律写当前时区 DATETIME(3)（NOW(3)）；状态列写 TINYINT 数值码（1=active，2=archived/removed）。

INSERT IGNORE INTO wb_user (user_id, username, display_name, enabled, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'user01', '用户 01', 1, NOW(3)),
  ('00000000-0000-4000-8000-0000000000d2', 'user02', '用户 02', 1, NOW(3)),
  ('00000000-0000-4000-8000-0000000000d3', 'user03', '用户 03', 1, NOW(3));

INSERT IGNORE INTO wb_workspace (workspace_id, slug, name, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'demo', '演示工作区', NOW(3));

INSERT IGNORE INTO wb_workspace_member (workspace_id, user_id, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', NOW(3)),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d2', NOW(3)),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d3', NOW(3));

-- remote_url_sha256 由应用侧 SHA-256(remote_url) 写入；本文件用内置 SHA2() 保持同等语义。
INSERT IGNORE INTO wb_repository (repository_id, workspace_id, name, remote_url, remote_url_sha256, default_branch, status, created_by_user_id, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'harness-code', 'git@github.com:example/harness-code.git', SHA2('git@github.com:example/harness-code.git', 256), 'main', 1, '00000000-0000-4000-8000-0000000000d1', NOW(3), NOW(3)),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c1', 'workbench-ui', 'git@github.com:example/workbench-ui.git', SHA2('git@github.com:example/workbench-ui.git', 256), 'main', 1, '00000000-0000-4000-8000-0000000000d1', NOW(3), NOW(3));

INSERT IGNORE INTO wb_project (project_id, workspace_id, name, description, owner_user_id, status, version, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '演示项目', 'HC-211 冒烟演示项目', '00000000-0000-4000-8000-0000000000d1', 1, 1, NOW(3), NOW(3));

INSERT IGNORE INTO wb_project_member (project_id, user_id, status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d1', 1, NOW(3), NOW(3)),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d2', 1, NOW(3), NOW(3));

INSERT IGNORE INTO wb_project_repository (project_id, repository_id, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', NOW(3)),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2', NOW(3));
