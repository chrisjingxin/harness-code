-- 演示数据（可选执行）：与 Application init-demo 互补——init-demo 只保证用户/团队/成员，
-- 本文件预置演示项目、团队仓库、项目引用与本机登记，便于冒烟直接走通组织层。
-- 幂等：按业务唯一键 INSERT IGNORE，可重复执行。

INSERT IGNORE INTO wb_user (id, username, display_name, enabled, created_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'user01', '用户 01', 1, UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000d2', 'user02', '用户 02', 1, UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000d3', 'user03', '用户 03', 1, UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_workspace (id, slug, name, created_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000w1', 'demo', '演示工作区', UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_workspace_member (workspace_id, user_id, created_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000w1', '00000000-0000-4000-8000-0000000000d1', UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000w1', '00000000-0000-4000-8000-0000000000d2', UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000w1', '00000000-0000-4000-8000-0000000000d3', UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_repository (id, workspace_id, name, remote_url, default_branch, status, created_by_user_id, created_at_ms, updated_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000r1', '00000000-0000-4000-8000-0000000000w1', 'harness-code', 'git@github.com:example/harness-code.git', 'main', 'active', '00000000-0000-4000-8000-0000000000d1', UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000r2', '00000000-0000-4000-8000-0000000000w1', 'workbench-ui', 'git@github.com:example/workbench-ui.git', 'main', 'active', '00000000-0000-4000-8000-0000000000d1', UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_project (id, workspace_id, name, description, owner_user_id, status, version, created_at_ms, updated_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000p1', '00000000-0000-4000-8000-0000000000w1', '演示项目', 'HC-211 冒烟演示项目', '00000000-0000-4000-8000-0000000000d1', 'active', 1, UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_project_member (project_id, user_id, status, created_at_ms, updated_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000p1', '00000000-0000-4000-8000-0000000000d1', 'active', UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000p1', '00000000-0000-4000-8000-0000000000d2', 'active', UNIX_TIMESTAMP() * 1000, UNIX_TIMESTAMP() * 1000);

INSERT IGNORE INTO wb_project_repository (project_id, repository_id, created_at_ms) VALUES
  ('00000000-0000-4000-8000-0000000000p1', '00000000-0000-4000-8000-0000000000r1', UNIX_TIMESTAMP() * 1000),
  ('00000000-0000-4000-8000-0000000000p1', '00000000-0000-4000-8000-0000000000r2', UNIX_TIMESTAMP() * 1000);
