"""代码索引 state.json 的校验与原子持久化。"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from harness_agent.code_index.models import ENGINE_VERSION, CodeIndexLifecycle, DurableCodeIndexState
from harness_agent.code_index.path_policy import CodeIndexPathError, CodeIndexPathPolicy

_SCHEMA_VERSION = 1
_LIFECYCLES = {"running", "serving", "ready", "cancelled", "incomplete", "failed"}
_STATE_FIELDS = {
    "schema_version",
    "workspace_fingerprint",
    "engine_version",
    "revision",
    "generation",
    "lifecycle",
    "last_job",
}


class CodeIndexStateError(RuntimeError):
    """持久状态不可安全读取或写入。"""


class CodeIndexStateStore:
    """拥有 `.harness-index/state.json`，不读写上游数据库。"""

    def __init__(self, policy: CodeIndexPathPolicy) -> None:
        self.policy = policy
        self.state_path = policy.data_directory / "state.json"
        self._fingerprint = hashlib.sha256(str(policy.workspace).encode("utf-8")).hexdigest()

    def prepare(self) -> None:
        """在第一次写操作前创建受管目录与 ignore。"""
        self.policy.prepare()

    def load(self) -> DurableCodeIndexState | None:
        """读取有效 marker；目录不存在表示 absent，其余异常表示 incomplete。"""
        if not self.policy.data_directory.exists():
            return None
        try:
            self.policy.assert_managed_directory()
            self.policy.assert_managed_file(self.state_path)
            if not self.state_path.is_file():
                raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            return self._decode(payload)
        except CodeIndexPathError as exc:
            raise CodeIndexStateError("CODE_INDEX_PATH_UNSAFE") from exc
        except CodeIndexStateError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise CodeIndexStateError("CODE_INDEX_INCOMPLETE") from exc

    def write(self, state: DurableCodeIndexState) -> None:
        """同目录 temp fsync 后原子替换，失败不覆盖最后有效 marker。"""
        payload: dict[str, Any] = {
            "schema_version": _SCHEMA_VERSION,
            "workspace_fingerprint": self._fingerprint,
            "engine_version": ENGINE_VERSION,
            "revision": state.revision,
            "generation": state.generation,
            "lifecycle": state.lifecycle,
            "last_job": state.last_job,
        }
        temporary: Path | None = None
        try:
            self.prepare()
            self.policy.assert_managed_file(self.state_path)
            encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
            descriptor, name = tempfile.mkstemp(prefix=".state.json.", suffix=".tmp", dir=self.policy.data_directory)
            temporary = Path(name)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.state_path)
            temporary = None
            if os.name != "nt":
                directory_fd = os.open(self.policy.data_directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except (OSError, CodeIndexPathError) as exc:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
            code = "CODE_INDEX_PATH_UNSAFE" if isinstance(exc, CodeIndexPathError) else "CODE_INDEX_INCOMPLETE"
            raise CodeIndexStateError(code) from exc

    def remove(self) -> None:
        """验证 marker 与目录归属后精确删除受管索引。"""
        if self.load() is None:
            raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")
        try:
            self.policy.remove()
        except (OSError, UnicodeDecodeError, CodeIndexPathError) as exc:
            code = "CODE_INDEX_PATH_UNSAFE" if isinstance(exc, CodeIndexPathError) else "CODE_INDEX_INCOMPLETE"
            raise CodeIndexStateError(code) from exc

    def _decode(self, payload: object) -> DurableCodeIndexState:
        if not isinstance(payload, dict) or set(payload) != _STATE_FIELDS:
            raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")
        if (
            payload["schema_version"] != _SCHEMA_VERSION
            or payload["workspace_fingerprint"] != self._fingerprint
            or payload["engine_version"] != ENGINE_VERSION
            or type(payload["revision"]) is not int
            or payload["revision"] < 0
            or type(payload["generation"]) is not int
            or payload["generation"] < 0
            or payload["lifecycle"] not in _LIFECYCLES
            or (payload["last_job"] is not None and not isinstance(payload["last_job"], dict))
        ):
            raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")
        last_job = payload["last_job"]
        if last_job is not None and not all(isinstance(key, str) and isinstance(value, str) for key, value in last_job.items()):
            raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")
        return DurableCodeIndexState(
            revision=payload["revision"],
            generation=payload["generation"],
            lifecycle=payload["lifecycle"],
            last_job=last_job,
        )
