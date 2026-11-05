"""按 session 追加的 UTF-8 JSONL writer，所有文件故障均与业务隔离。"""

from __future__ import annotations

import json
import logging
import threading
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

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)

    def append(self, session_id: str, event: Mapping[str, object]) -> None:
        """尽力追加一条完整 JSON，失败只写 stderr 日志，不抛给业务。"""
        try:
            encoded = json.dumps(
                dict(event), ensure_ascii=False, allow_nan=False, separators=(",", ":")
            )
            self._root.mkdir(parents=True, exist_ok=True)
            path = self._root / session_filename(session_id)
            with _lock_for(self._root):
                with path.open("a", encoding="utf-8", newline="\n") as stream:
                    stream.write(encoded + "\n")
        except Exception:
            _LOGGER.warning("Session Trace JSONL 写入失败", exc_info=True)
