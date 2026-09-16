"""代码索引目录的工作区边界与 Git 本地忽略规则。"""

from __future__ import annotations

import shutil
from pathlib import Path

from harness_agent.code_index.models import DATA_DIRECTORY

_DIRECTORY_IGNORE = "*\n"
_EXCLUDE_BLOCK = "# BEGIN HARNESS CODE INDEX\n/.harness-index/\n# END HARNESS CODE INDEX\n"


class CodeIndexPathError(RuntimeError):
    """索引路径或相邻元数据不满足安全边界。"""


class CodeIndexPathPolicy:
    """只管理规范化工作区直属的单一索引目录。"""

    def __init__(self, workspace: Path) -> None:
        try:
            self.workspace = workspace.resolve(strict=True)
        except OSError as exc:
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE") from exc
        if not self.workspace.is_dir():
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        self.data_directory = self.workspace / DATA_DIRECTORY

    def prepare(self) -> Path:
        """创建并复核受管目录；不跟随既有链接或覆盖未知文件。"""
        target = self.data_directory
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        target.mkdir(mode=0o700, exist_ok=True)
        if target.is_symlink() or target.resolve() != target:
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        self._ensure_managed_file(target / ".gitignore", _DIRECTORY_IGNORE)
        self._ensure_local_exclude()
        return target

    def assert_managed_file(self, path: Path) -> None:
        """拒绝目录外路径和符号链接文件。"""
        if path.parent != self.data_directory or path.is_symlink():
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        try:
            path.parent.resolve(strict=True).relative_to(self.workspace)
        except (OSError, ValueError) as exc:
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE") from exc

    def assert_managed_directory(self) -> None:
        """验证数据目录和 Harness 所有权标识，供重启读取与删除共用。"""
        target = self.data_directory
        marker = target / ".gitignore"
        if (
            target.is_symlink()
            or not target.is_dir()
            or marker.is_symlink()
            or not marker.is_file()
            or marker.read_text(encoding="utf-8") != _DIRECTORY_IGNORE
            or target.resolve() != target
        ):
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")

    def _ensure_managed_file(self, path: Path, expected: str) -> None:
        self.assert_managed_file(path)
        if path.exists():
            if not path.is_file() or path.read_text(encoding="utf-8") != expected:
                raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
            return
        path.write_text(expected, encoding="utf-8")

    def _ensure_local_exclude(self) -> None:
        git_dir = self.workspace / ".git"
        if not git_dir.is_dir() or git_dir.is_symlink():
            return
        exclude = git_dir / "info" / "exclude"
        if exclude.is_symlink() or (exclude.exists() and not exclude.is_file()):
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        exclude.parent.mkdir(parents=True, exist_ok=True)
        current = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        if _EXCLUDE_BLOCK in current:
            return
        separator = "" if not current or current.endswith("\n") else "\n"
        exclude.write_text(f"{current}{separator}{_EXCLUDE_BLOCK}", encoding="utf-8")

    def remove(self) -> None:
        """只删除有 Harness 标识的索引目录和本功能写入的 exclude 块。"""
        self.assert_managed_directory()
        shutil.rmtree(self.data_directory)
        self._remove_local_exclude()

    def _remove_local_exclude(self) -> None:
        git_dir = self.workspace / ".git"
        if not git_dir.is_dir() or git_dir.is_symlink():
            return
        exclude = git_dir / "info" / "exclude"
        if not exclude.exists():
            return
        if exclude.is_symlink() or not exclude.is_file():
            raise CodeIndexPathError("CODE_INDEX_PATH_UNSAFE")
        current = exclude.read_text(encoding="utf-8")
        if _EXCLUDE_BLOCK not in current:
            return
        exclude.write_text(current.replace(_EXCLUDE_BLOCK, "", 1), encoding="utf-8")
