"""Fusion 路径边界和独立快照。"""

import subprocess

import pytest


def api():
    from harness_agent.runtime.fusion.snapshot import (
        capture_snapshot,
        changed_paths,
        normalize_paths,
    )

    return normalize_paths, capture_snapshot, changed_paths


@pytest.mark.parametrize(
    "path",
    [
        "../secret",
        "/absolute",
        "a/../../b",
        "*.py",
        ".git/config",
        ".harness-index/data",
        "a\\b",
    ],
)
def test_rejects_unsafe_paths(tmp_path, path):
    normalize, _, _ = api()
    with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
        normalize(tmp_path, [path])


def test_symlink_escape_rejected(tmp_path):
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    (tmp_path / "link").symlink_to(outside, target_is_directory=True)
    normalize, _, _ = api()
    with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
        normalize(tmp_path, ["link/file"])


def test_non_git_changes_track_deletes_and_ignore_internal(tmp_path):
    normalize, capture, changed = api()
    (tmp_path / "src").mkdir()
    (tmp_path / "src/a").write_text("one")
    before = capture(tmp_path, normalize(tmp_path, ["src/"]))
    (tmp_path / "src/a").unlink()
    (tmp_path / "src/b").write_text("two")
    internal = tmp_path / ".harness-index"
    internal.mkdir()
    (internal / "db").write_text("index")
    after = capture(tmp_path, ["src/"])
    assert changed(before, after) == ("src/a", "src/b")


def test_git_snapshot_keeps_user_index_and_tracks_ignored_allowed_file(tmp_path):
    _, capture, changed = api()
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text("ignored.txt\n")
    (tmp_path / "a").write_text("before")
    subprocess.run(["git", "-C", str(tmp_path), "add", "a", ".gitignore"], check=True)
    index = (tmp_path / ".git/index").read_bytes()
    (tmp_path / "ignored.txt").write_text("one")
    before = capture(tmp_path, ["ignored.txt", "a"])
    (tmp_path / "ignored.txt").write_text("two")
    after = capture(tmp_path, ["ignored.txt", "a"])
    assert changed(before, after) == ("ignored.txt",)
    assert (tmp_path / ".git/index").read_bytes() == index


def test_directory_scope_does_not_match_sibling(tmp_path):
    from harness_agent.runtime.fusion.snapshot import path_allowed

    assert path_allowed("src/a.py", ("src/",))
    assert not path_allowed("src-other/a.py", ("src/",))
    assert not path_allowed("src/a.py", ("src",))


def test_write_scope_rejects_symlink_alias_inside_workspace(tmp_path):
    from harness_agent.runtime.fusion.snapshot import normalize_paths

    (tmp_path / "real").mkdir()
    (tmp_path / "alias").symlink_to(tmp_path / "real", target_is_directory=True)
    with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
        normalize_paths(tmp_path, ["alias/file.py"])


def test_new_file_and_new_directory_scopes_do_not_need_to_exist(tmp_path):
    normalize, capture, changed = api()
    allowed = normalize(tmp_path, ["calc.py", "new/test_calc.py", "new/"])
    before = capture(tmp_path, allowed)
    assert before["entries"] == {}
    (tmp_path / "calc.py").write_text("created")
    (tmp_path / "new").mkdir()
    (tmp_path / "new/test_calc.py").write_text("created")
    assert changed(before, capture(tmp_path, allowed)) == (
        "calc.py",
        "new/test_calc.py",
    )
