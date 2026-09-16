"""代码索引目录与持久状态的安全契约。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from harness_agent.code_index.models import DurableCodeIndexState
from harness_agent.code_index.path_policy import CodeIndexPathError, CodeIndexPathPolicy
from harness_agent.code_index.state_store import CodeIndexStateError, CodeIndexStateStore


def _state(*, revision: int = 1, generation: int = 0, lifecycle: str = "running") -> DurableCodeIndexState:
    return DurableCodeIndexState(
        revision=revision,
        generation=generation,
        lifecycle=lifecycle,
        last_job={"id": "job-1", "action": "initialize", "started_at": "2026-09-15T00:00:00Z"},
    )


def test_prepare_creates_only_managed_directory_and_git_ignores(tmp_path: Path) -> None:
    """初始化只写直属目录、目录内 ignore 与 Git local exclude。"""
    workspace = tmp_path / "仓库 空格"
    workspace.mkdir()
    git_dir = workspace / ".git"
    (git_dir / "info").mkdir(parents=True)
    root_gitignore = workspace / ".gitignore"
    root_gitignore.write_text("dist/\n", encoding="utf-8")

    policy = CodeIndexPathPolicy(workspace)
    policy.prepare()

    assert policy.data_directory == workspace / ".harness-index"
    assert (policy.data_directory / ".gitignore").read_text(encoding="utf-8") == "*\n"
    assert root_gitignore.read_text(encoding="utf-8") == "dist/\n"
    exclude = (git_dir / "info" / "exclude").read_text(encoding="utf-8")
    assert exclude.count("# BEGIN HARNESS CODE INDEX") == 1
    assert "/.harness-index/" in exclude
    assert not (workspace / ".codegraph").exists()

    policy.prepare()
    assert (git_dir / "info" / "exclude").read_text(encoding="utf-8") == exclude


def test_prepare_non_git_workspace_does_not_create_git_metadata(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    CodeIndexPathPolicy(workspace).prepare()
    assert not (workspace / ".git").exists()


def test_prepare_rejects_index_symlink_and_non_directory(tmp_path: Path) -> None:
    """既有路径不是受管真实目录时失败关闭。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (workspace / ".harness-index").symlink_to(outside, target_is_directory=True)
    with pytest.raises(CodeIndexPathError, match="CODE_INDEX_PATH_UNSAFE"):
        CodeIndexPathPolicy(workspace).prepare()

    (workspace / ".harness-index").unlink()
    (workspace / ".harness-index").write_text("not a directory", encoding="utf-8")
    with pytest.raises(CodeIndexPathError, match="CODE_INDEX_PATH_UNSAFE"):
        CodeIndexPathPolicy(workspace).prepare()


def test_state_round_trip_uses_fingerprint_without_absolute_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.prepare()
    store.write(_state(revision=7, generation=3, lifecycle="ready"))

    loaded = store.load()
    assert loaded == _state(revision=7, generation=3, lifecycle="ready")
    raw = store.state_path.read_text(encoding="utf-8")
    assert str(workspace) not in raw
    assert json.loads(raw)["engine_version"] == "1.1.6"
    assert json.loads(raw)["schema_version"] == 1


@pytest.mark.parametrize(
    "patch",
    [
        {"workspace_fingerprint": "wrong"},
        {"engine_version": "1.6.0"},
        {"schema_version": 2},
        {"lifecycle": "mystery"},
    ],
)
def test_state_load_rejects_mismatched_or_invalid_marker(tmp_path: Path, patch: dict[str, object]) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.prepare()
    store.write(_state())
    payload = json.loads(store.state_path.read_text(encoding="utf-8"))
    payload.update(patch)
    store.state_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(CodeIndexStateError, match="CODE_INDEX_INCOMPLETE"):
        store.load()


def test_state_load_rejects_symlink_marker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    policy = CodeIndexPathPolicy(workspace)
    policy.prepare()
    outside = tmp_path / "state.json"
    outside.write_text("{}", encoding="utf-8")
    (policy.data_directory / "state.json").symlink_to(outside)
    with pytest.raises(CodeIndexStateError, match="CODE_INDEX_PATH_UNSAFE"):
        CodeIndexStateStore(policy).load()


def test_atomic_write_failure_preserves_last_valid_marker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.prepare()
    store.write(_state(revision=1))
    before = store.state_path.read_bytes()

    def fail_replace(_source: object, _target: object) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(CodeIndexStateError, match="CODE_INDEX_INCOMPLETE"):
        store.write(_state(revision=2))
    assert store.state_path.read_bytes() == before
    assert list(store.state_path.parent.glob(".state.json.*.tmp")) == []


def test_remove_preserves_adjacent_data_and_other_git_excludes(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".harness").mkdir()
    (workspace / ".harness" / "keep").write_text("user", encoding="utf-8")
    exclude = workspace / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True)
    exclude.write_text("dist/\n", encoding="utf-8")
    policy = CodeIndexPathPolicy(workspace)
    store = CodeIndexStateStore(policy)
    store.write(_state(lifecycle="ready"))
    (policy.data_directory / "codegraph.db").write_bytes(b"db")

    store.remove()

    assert not policy.data_directory.exists()
    assert (workspace / ".harness" / "keep").read_text(encoding="utf-8") == "user"
    assert exclude.read_text(encoding="utf-8") == "dist/\n"


def test_remove_rejects_unknown_directory_marker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.write(_state(lifecycle="ready"))
    (workspace / ".harness-index" / ".gitignore").write_text("not-owned\n", encoding="utf-8")
    with pytest.raises(CodeIndexStateError, match="CODE_INDEX_PATH_UNSAFE"):
        store.remove()
    assert (workspace / ".harness-index").exists()


def test_load_rejects_unknown_directory_marker(tmp_path: Path) -> None:
    """重启读取也必须验证目录所有权，不能到自动恢复阶段才抛异常。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.write(_state(lifecycle="ready"))
    (workspace / ".harness-index" / ".gitignore").write_text("not-owned\n", encoding="utf-8")
    with pytest.raises(CodeIndexStateError, match="CODE_INDEX_PATH_UNSAFE"):
        store.load()
