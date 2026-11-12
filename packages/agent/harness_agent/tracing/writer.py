"""按 session 追加的 UTF-8 JSONL writer，所有文件故障均与业务隔离。"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Mapping

_LOGGER = logging.getLogger(__name__)
_LOCKS: dict[str, threading.Lock] = {}
_FILENAMES: dict[str, str] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(root: Path) -> threading.Lock:
    key = str(root.absolute())
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def session_filename(session_id: str) -> str:
    """为 session 生成进程内稳定的时间随机文件名，避免追加事件时拆分文件。"""
    with _LOCKS_GUARD:
        filename = _FILENAMES.get(session_id)
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"Trace-log-{timestamp}-{uuid.uuid4().hex[:8]}.jsonl"
            _FILENAMES[session_id] = filename
        return filename


class JsonlTraceWriter:
    """逐行追加事件，不缓存 Trace；单行写入由同目录锁串行化。"""

    def __init__(
        self,
        root: Path | str,
        *,
        max_file_bytes: int = 64 * 1024 * 1024,
        retention_days: int = 14,
    ) -> None:
        """目录、单文件上限和保留天数。清理只作用于这个目录。"""
        self._root = Path(root)
        self._max_file_bytes = max_file_bytes
        self._retention_days = retention_days
        self._paths: dict[str, Path] = {}
        self._pruned = False

    def append(self, session_id: str, event: Mapping[str, object]) -> None:
        """尽力追加一条完整 JSON，失败只写 stderr 日志，不抛给业务。"""
        try:
            encoded = json.dumps(
                dict(event), ensure_ascii=False, allow_nan=False, separators=(",", ":")
            )
            self._root.mkdir(parents=True, exist_ok=True)
            self._prune_once()
            path = self._path_for(session_id, len(encoded) + 1)
            with _lock_for(self._root):
                with path.open("a", encoding="utf-8", newline="\n") as stream:
                    stream.write(encoded + "\n")
        except Exception:
            _LOGGER.warning("Session Trace JSONL 写入失败", exc_info=True)

    def _path_for(self, session_id: str, incoming: int) -> Path:
        """当前文件放不下这条记录时换一个新文件，会话 id 不因此改变。"""
        path = self._paths.get(session_id)
        if path is None:
            path = self._root / session_filename(session_id)
            self._paths[session_id] = path
        if path.exists() and path.stat().st_size + incoming > self._max_file_bytes:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = self._root / f"Trace-log-{timestamp}-{uuid.uuid4().hex[:8]}.jsonl"
            self._paths[session_id] = path
        return path

    def _prune_once(self) -> None:
        """删除修改时间早于保留天数的 jsonl。失败不影响随后的写入。"""
        if self._pruned:
            return
        self._pruned = True
        cutoff = time.time() - self._retention_days * 86400
        for path in self._root.glob("*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                _LOGGER.warning("Trace 过期文件删除失败: %s", path.name, exc_info=True)
