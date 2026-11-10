"""一次 Run 的 v2 写入入口：span、去重载荷和关闭。"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Mapping

from harness_agent.tracing.recorder import TraceRecorder, TraceStatus

_SECRET_KEYS = {"api_key", "apikey", "authorization", "cookie", "set-cookie"}
_TOKEN_VALUE = re.compile(r"^(sk-|ghp_|github_pat_|xox|Bearer )")
_ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")


def redact(value: object) -> object:
    """递归替换密钥和疑似 token 的环境变量值，正文原样保留。"""
    if isinstance(value, Mapping):
        redacted: dict[str, object] = {}
        for key, item in value.items():
            name = str(key).lower()
            if name in _SECRET_KEYS:
                redacted[str(key)] = "[redacted]"
            elif isinstance(item, str) and _ENV_KEY.match(str(key)) and _TOKEN_VALUE.match(item):
                redacted[str(key)] = "[redacted]"
            else:
                redacted[str(key)] = redact(item)
        return redacted
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    return {"unserializable": type(value).__name__}


def payload_digest(body: object) -> str:
    """按脱敏后的稳定 JSON 计算内容哈希。"""
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class Span:
    """一次已打开的 span。结束时合并开始属性。"""

    def __init__(self, recorder: TraceRecorder, handle: object) -> None:
        self._recorder = recorder
        self._handle = handle

    def end(
        self,
        status: TraceStatus | str = TraceStatus.SUCCESS,
        *,
        attributes: Mapping[str, object] | None = None,
    ) -> None:
        """写入结束记录。没有打开过的 span 不产生事件。"""
        self._recorder.end_span(self._handle, status, attributes=attributes)


class TraceSession:
    """一次 Run 的 v2 写入器。档位为 off 时所有方法都是空操作。"""

    def __init__(
        self,
        *,
        session_id: str,
        run_id: str,
        log_dir: Path | str,
        capture: str = "full",
        retention_days: int = 14,
        max_file_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        """打开写入器并写出 trace.start。off 不创建文件。"""
        self._recorder = TraceRecorder(
            session_id=session_id,
            run_id=run_id,
            log_dir=log_dir,
            capture=capture,
            retention_days=retention_days,
            max_file_bytes=max_file_bytes,
        )
        self._recorder.start_trace()

    def span(
        self,
        name: str,
        *,
        kind: str = "FUNC",
        parent: str | None = None,
        attributes: Mapping[str, object] | None = None,
    ) -> Span:
        """打开 span。off 档位返回一个结束时不写事件的空 span。"""
        handle = self._recorder.start_span(name, kind=kind, parent_span_id=parent, attributes=attributes)
        return Span(self._recorder, handle)

    def payload(self, kind: str, body: object) -> str:
        """脱敏后按内容去重，返回 payload_id。meta 和 off 返回空字符串。"""
        return self._recorder.payload(kind, body)

    def close(
        self,
        status: TraceStatus | str = TraceStatus.SUCCESS,
        attributes: Mapping[str, object] | None = None,
    ) -> None:
        """写 run 的结束记录并关闭文件。重复调用无效果。"""
        self._recorder.end_trace(status, attributes=attributes)
