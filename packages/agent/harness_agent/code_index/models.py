"""代码索引的供应商无关快照与错误文案。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Literal, Mapping, Protocol

ENGINE_VERSION = "1.1.6"
DATA_DIRECTORY = ".harness-index"

ErrorCode = Literal[
    "CODE_INDEX_RUNTIME_UNAVAILABLE",
    "CODE_INDEX_VERSION_MISMATCH",
    "CODE_INDEX_RUN_ACTIVE",
    "CODE_INDEX_JOB_ACTIVE",
    "CODE_INDEX_REVISION_CONFLICT",
    "CODE_INDEX_JOB_NOT_FOUND",
    "CODE_INDEX_INCOMPLETE",
    "CODE_INDEX_PATH_UNSAFE",
]

_ERROR_COPY: Mapping[ErrorCode, tuple[str, str]] = {
    "CODE_INDEX_RUNTIME_UNAVAILABLE": (
        "代码索引运行时不可用。",
        "安装匹配的 1.1.6 依赖后重启 Harness。",
    ),
    "CODE_INDEX_VERSION_MISMATCH": (
        "代码索引依赖版本不一致。",
        "修复企业依赖版本后重启 Harness。",
    ),
    "CODE_INDEX_RUN_ACTIVE": (
        "当前有对话正在使用代码索引。",
        "等待该对话结束后重试。",
    ),
    "CODE_INDEX_JOB_ACTIVE": (
        "已有代码索引任务在运行。",
        "查看 /code-index status，或取消后再试。",
    ),
    "CODE_INDEX_REVISION_CONFLICT": (
        "代码索引状态已变化。",
        "刷新 /code-index status 后重试。",
    ),
    "CODE_INDEX_JOB_NOT_FOUND": (
        "要取消的代码索引任务已结束。",
        "刷新 /code-index status。",
    ),
    "CODE_INDEX_INCOMPLETE": (
        "代码索引不完整，不能安全查询。",
        "执行 /code-index rebuild 重建。",
    ),
    "CODE_INDEX_PATH_UNSAFE": (
        "代码索引目录不在当前工作区内。",
        "修复目录后重试。",
    ),
}


@dataclass(frozen=True, slots=True)
class CodeIndexError:
    """协议 snapshot.error 的稳定用户文案。"""

    code: ErrorCode
    message: str
    recovery: str

    def to_wire(self) -> dict[str, str]:
        """转为协议对象。"""
        return {"code": self.code, "message": self.message, "recovery": self.recovery}


def error_for(code: ErrorCode) -> CodeIndexError:
    """按稳定错误码生成供应商无关文案。"""
    message, recovery = _ERROR_COPY[code]
    return CodeIndexError(code=code, message=message, recovery=recovery)


@dataclass(frozen=True, slots=True)
class CodeIndexPreflight:
    """离线包校验结果；失败时不含绝对路径。"""

    ok: bool
    error: CodeIndexError | None = None


CodeIndexLifecycle = Literal["running", "serving", "ready", "cancelled", "incomplete", "failed"]


@dataclass(frozen=True, slots=True)
class DurableCodeIndexState:
    """写入 state.json 的最小供应商无关状态。"""

    revision: int
    generation: int
    lifecycle: CodeIndexLifecycle
    last_job: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class CodeIndexBuildResult:
    """受管建图进程的脱敏终态。"""

    success: bool
    stats: dict[str, int] | None = None
    error: CodeIndexError | None = None


@dataclass(frozen=True, slots=True)
class CodeIndexQuerySession:
    """私有查询进程的脱敏就绪结果；不含 MCP 类型。"""

    watcher_status: Literal["ready", "degraded", "failed"] = "ready"


class CodeIndexQueryLease:
    """绑定当前 generation 的查询租约；release 幂等。"""

    def __init__(
        self,
        generation: int,
        explore: Callable[..., Awaitable[str]],
        release: Callable[["CodeIndexQueryLease"], Awaitable[None]],
    ) -> None:
        self.generation = generation
        self._explore = explore
        self._release = release
        self._released = False

    async def explore(self, query: str, max_files: int = 8) -> str:
        """按当前 generation 查询；租约释放后返回可恢复说明。"""
        if self._released:
            return "代码索引查询已结束。请改用 glob、grep 或 read_file。"
        return await self._explore(self.generation, query, max_files)

    async def release(self) -> None:
        """归还租约；重复调用保持计数不为负。"""
        if self._released:
            return
        self._released = True
        await self._release(self)


@dataclass(frozen=True, slots=True)
class CodeIndexSnapshot:
    """Host 与 CLI 共用的代码索引状态。"""

    revision: int = 0
    generation: int = 0
    engine_version: str = ENGINE_VERSION
    data_directory: str = DATA_DIRECTORY
    runtime_status: Literal["ready", "unavailable"] = "ready"
    index_status: Literal["absent", "ready", "incomplete"] = "absent"
    query_status: Literal["stopped", "starting", "ready", "failed"] = "stopped"
    watcher_status: Literal["stopped", "starting", "ready", "degraded", "failed"] = "stopped"
    job: dict[str, Any] | None = None
    stats: dict[str, Any] | None = None
    error: CodeIndexError | None = None

    def to_wire(self) -> dict[str, Any]:
        """转为协议 snapshot；不包含绝对路径或供应商名称。"""
        return {
            "revision": self.revision,
            "generation": self.generation,
            "engine_version": self.engine_version,
            "data_directory": self.data_directory,
            "runtime_status": self.runtime_status,
            "index_status": self.index_status,
            "query_status": self.query_status,
            "watcher_status": self.watcher_status,
            "job": self.job,
            "stats": self.stats,
            "error": None if self.error is None else self.error.to_wire(),
        }


class CodeIndexRuntimePort(Protocol):
    """真实 Node 进程与测试 fake 的唯一 seam。"""

    def preflight(self) -> CodeIndexPreflight:
        """离线校验主包、平台包和随包 Node。"""
        ...

    async def run_index(
        self,
        workspace: Path,
        *,
        operation: Literal["initialize", "sync", "rebuild"] = "initialize",
        on_progress: Callable[[dict[str, object]], Awaitable[None] | None],
        timeout: float = 1800.0,
    ) -> CodeIndexBuildResult:
        """首建、增量或重建索引，并只返回经过校验的 Harness 事件。"""
        ...

    async def start_query(self, workspace: Path) -> CodeIndexQuerySession:
        """启动私有查询进程；失败时抛出可恢复错误。"""
        ...

    async def stop_query(self) -> None:
        """幂等关闭私有查询进程。"""
        ...

    async def explore(self, query: str, max_files: int) -> str:
        """在已启动的查询进程上执行一次探索。"""
        ...
