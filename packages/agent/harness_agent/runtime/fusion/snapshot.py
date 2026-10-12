"""Host 独立工作区快照：Git 临时 index、逐文件摘要和严格路径边界。"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePosixPath

INTERNAL = frozenset({".git", ".harness-index"})


def normalize_paths(workspace: Path, values: Iterable[str]) -> tuple[str, ...]:
    """规范化精确文件或目录范围，并拒绝路径绕过和内部状态目录。"""
    root = workspace.resolve()
    result = []
    for value in values:
        if (
            not isinstance(value, str)
            or not value
            or "\\" in value
            or "\x00" in value
            or any(c in value for c in "*?[]")
        ):
            raise ValueError("FUSION_PATH_INVALID")
        path = PurePosixPath(value)
        if (
            path.is_absolute()
            or ".." in path.parts
            or ":" in value
            or any(p in INTERNAL for p in path.parts)
        ):
            raise ValueError("FUSION_PATH_INVALID")
        if not (root / path).resolve().is_relative_to(root):
            raise ValueError("FUSION_PATH_INVALID")
        if any(
            (root / Path(*path.parts[:i])).is_symlink()
            for i in range(1, len(path.parts) + 1)
        ):
            raise ValueError("FUSION_PATH_INVALID")
        normalized = path.as_posix().rstrip("/") + ("/" if value.endswith("/") else "")
        if normalized in {".", "./"}:
            normalized = "./"
        if normalized not in result:
            result.append(normalized)
    if not result:
        raise ValueError("FUSION_PATH_INVALID")
    return tuple(result)


def path_allowed(path: str, allowed: Iterable[str]) -> bool:
    """目录按子树匹配，文件只按精确路径匹配，内部目录永不匹配。"""
    if any(part in INTERNAL for part in PurePosixPath(path).parts):
        return False
    return any(
        value == "./"
        or path == value
        or (value.endswith("/") and path.startswith(value))
        for value in allowed
    )


def _git(
    root: Path,
    args: list[str],
    env: Mapping[str, str] | None = None,
    *,
    allow_empty_head: bool = False,
) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if result.returncode and not allow_empty_head:
        raise ValueError("FUSION_SNAPSHOT_UNAVAILABLE")
    return result.stdout


def _walk(root: Path, base: Path) -> set[str]:
    result = set()
    if base.is_symlink() or base.is_file():
        return {base.relative_to(root).as_posix()}
    if not base.exists():
        return result
    for current, directories, files in os.walk(
        base, followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)
    ):
        directories[:] = [name for name in directories if name not in INTERNAL]
        for name in [
            *files,
            *[name for name in directories if (Path(current) / name).is_symlink()],
        ]:
            result.add((Path(current) / name).relative_to(root).as_posix())
    return result


def _entry(root: Path, name: str) -> str:
    file = root / name
    before = file.lstat()
    digest = hashlib.sha256()
    if stat.S_ISLNK(before.st_mode):
        if not file.resolve().is_relative_to(root):
            raise ValueError("FUSION_PATH_INVALID")
        digest.update(os.readlink(file).encode())
    elif stat.S_ISREG(before.st_mode):
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    else:
        raise ValueError("FUSION_SNAPSHOT_UNAVAILABLE")
    after = file.lstat()
    if (before.st_size, before.st_mtime_ns, before.st_ino, before.st_mode) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
        after.st_mode,
    ):
        raise ValueError("FUSION_SNAPSHOT_CHANGED")
    return (
        f"{stat.S_IFMT(before.st_mode)}:{before.st_mode & 0o777}:{digest.hexdigest()}"
    )


def capture_snapshot(
    workspace: Path, allowed_paths: Iterable[str]
) -> dict[str, object]:
    """严格捕获实际文件；任何读取或 Git 错误都不能伪装成空快照。"""
    root = workspace.resolve()
    allowed = normalize_paths(root, allowed_paths)
    git_dir = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    git = git_dir.returncode == 0
    if git and Path(os.fsdecode(git_dir.stdout).strip()).resolve() != root:
        raise ValueError("FUSION_SNAPSHOT_UNAVAILABLE")
    tree = None
    if git:
        names = {
            os.fsdecode(item)
            for item in _git(
                root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
            ).split(b"\0")
            if item
        }
        with tempfile.TemporaryDirectory(prefix="fusion-index-") as temp:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(temp) / "index"))
            head = subprocess.run(
                ["git", "-C", str(root), "rev-parse", "--verify", "HEAD"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
            )
            _git(
                root,
                ["read-tree", os.fsdecode(head.stdout).strip()]
                if head.returncode == 0
                else ["read-tree", "--empty"],
                env,
            )
            _git(root, ["add", "-A", "--", "."], env)
            _git(
                root,
                ["rm", "-r", "--cached", "--ignore-unmatch", "--", ".harness-index"],
                env,
            )
            tree = _git(root, ["write-tree"], env).decode().strip()
    else:
        names = _walk(root, root)
    for value in allowed:
        names.update(_walk(root, root / value.rstrip("/")))
    entries = {}
    for name in sorted(names):
        if any(part in INTERNAL for part in PurePosixPath(name).parts):
            continue
        file = root / name
        if file.exists() or file.is_symlink():
            entries[name] = _entry(root, name)
    body = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return {
        "digest": hashlib.sha256(body).hexdigest(),
        "entries": entries,
        "tree": tree,
    }


def changed_paths(
    before: Mapping[str, object], after: Mapping[str, object]
) -> tuple[str, ...]:
    """从完整摘要集合找出新增、删除和修改的真实路径。"""
    left = before["entries"]
    right = after["entries"]
    if not isinstance(left, dict) or not isinstance(right, dict):
        raise ValueError("FUSION_SNAPSHOT_INVALID")
    return tuple(
        sorted(
            name
            for name in left.keys() | right.keys()
            if left.get(name) != right.get(name)
        )
    )
