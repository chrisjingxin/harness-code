"""Shell 后端的采集适配器：在展示层截断之前记录实际返回值。"""

from __future__ import annotations

import logging
from typing import Any

from deepagents.backends.protocol import SandboxBackendProtocol

from harness_agent.tracing.context import current_span, current_trace

_LOGGER = logging.getLogger(__name__)


class TraceExecutionBackend:
    """只观察 execute 返回值，其余 backend 操作直接交给原后端。"""

    def __init__(self, backend: Any, *, cwd: str) -> None:
        """绑定既有后端和已解析的工作目录，不创建资源。"""
        self._backend = backend
        self._cwd = cwd

    def __getattr__(self, name: str) -> Any:
        """保持原后端的文件能力和生命周期。"""
        return getattr(self._backend, name)

    def delete(self, file_path: str) -> Any:
        """显式透传删除能力，供 DeepAgents 在类对象上探测可选接口。"""
        return self._backend.delete(file_path)

    def execute(self, command: str, *, timeout: int | None = None) -> Any:
        """观察同步执行的真实结果，不改写返回值或执行参数。"""
        result = self._backend.execute(command) if timeout is None else self._backend.execute(command, timeout=timeout)
        self._record(result)
        return result

    async def aexecute(self, command: str, *, timeout: int | None = None) -> Any:
        """观察异步执行，取消和后端错误保持原样。"""
        result = await self._backend.aexecute(command) if timeout is None else await self._backend.aexecute(command, timeout=timeout)
        self._record(result)
        return result

    def _record(self, result: Any) -> None:
        trace, span = current_trace(), current_span()
        if trace is None or span is None or span.name != "tool.call":
            return
        try:
            output = result.output
            attributes = {
                "cwd": self._cwd, "truncated": result.truncated,
                "result_bytes": len(output.encode("utf-8")),
                "result_ref": trace.recorder.payload("tool_result", {
                    "output": output, "exit_code": result.exit_code, "truncated": result.truncated,
                }),
            }
            if result.exit_code is not None:
                attributes["exit_code"] = result.exit_code
            trace.recorder.annotate_span(span, attributes)
        except Exception:
            _LOGGER.warning("Shell trace 采集失败", exc_info=True)


SandboxBackendProtocol.register(TraceExecutionBackend)
