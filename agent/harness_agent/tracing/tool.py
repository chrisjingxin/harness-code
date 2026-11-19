"""在工具执行边界采集输入输出；采集故障不改变工具的返回或异常。"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import contextmanager
from typing import Any, Callable, Awaitable, Iterator

from langchain.agents.middleware.types import AgentMiddleware

from harness_agent.tracing.context import current_trace, _bind_span, _reset_span
from harness_agent.tracing.recorder import TraceStatus

_LOGGER = logging.getLogger(__name__)


def _bytes(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


@contextmanager
def _capture(request: Any) -> Iterator[dict[str, Any]]:
    context = current_trace()
    state: dict[str, Any] = {}
    span = token = None
    if context is not None:
        try:
            recorder = context.recorder
            call = request.tool_call
            name, args = str(call.get("name", "")), call.get("args") or {}
            metadata = getattr(getattr(request, "tool", None), "metadata", None) or {}
            attrs: dict[str, object] = {
                "tool": name, "call_id": call.get("id", ""),
                "source": "subagent" if name == "task" else "mcp" if metadata.get("harness_tool_kind") == "mcp" else "builtin",
                "args_bytes": _bytes(args), "args_ref": recorder.payload("tool_args", args),
            }
            if metadata.get("harness_mcp_server_name"):
                attrs["server"] = metadata["harness_mcp_server_name"]
            policy = recorder.policy_span(str(call.get("id", "")))
            if policy:
                attrs["policy_span_id"] = policy
            if name == "execute":
                attrs["command_ref"] = recorder.payload("tool_args", args.get("command", ""))
                if "cwd" in args:
                    attrs["cwd"] = args["cwd"]
            if name in {"write_file", "edit_file", "delete_file"}:
                attrs["operation"] = name.removesuffix("_file")
                path = args.get("file_path", args.get("path"))
                if path is not None:
                    attrs["path"] = path
            span = recorder.start_span("tool.call", kind="TOOL", attributes=attrs)
            token = _bind_span(span)
        except Exception:
            _LOGGER.warning("工具 trace 创建失败", exc_info=True)
    error = None
    try:
        yield state
    except BaseException as exc:
        error = exc
        raise
    finally:
        if token is not None:
            _reset_span(token)
        if span is not None and context is not None:
            attrs = {}
            status = TraceStatus.CANCELLED if isinstance(error, asyncio.CancelledError) else (
                TraceStatus.FAILED if error is not None else TraceStatus.SUCCESS
            )
            try:
                if "result" in state:
                    result = state["result"]
                    body = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
                    attrs = {"result_ref": context.recorder.payload("tool_result", body),
                             "result_bytes": _bytes(body), "result_status": getattr(result, "status", "success")}
                    # execute 后端已采到完整原文时，不能用展示层的截断结果覆盖。
                    for key in ("result_ref", "result_bytes"):
                        if key in span.attributes:
                            attrs.pop(key, None)
                    artifact = getattr(result, "artifact", None)
                    if isinstance(artifact, dict):
                        for key in ("exit_code", "stdout_bytes", "stderr_bytes", "timed_out", "truncated",
                                    "artifact_id", "diff_added", "diff_removed"):
                            if key in artifact:
                                attrs[key] = artifact[key]
                    if attrs["result_status"] == "error":
                        status = TraceStatus.FAILED
                    if isinstance(span.attributes.get("exit_code"), int) and span.attributes["exit_code"] != 0:
                        status = TraceStatus.FAILED
                        attrs["result_status"] = "error"
            except Exception:
                _LOGGER.warning("工具 trace 结果采集失败", exc_info=True)
            try:
                context.recorder.end_span(span, status, attributes=attrs, error=error)
            except Exception:
                _LOGGER.warning("工具 trace 关闭失败", exc_info=True)


class TraceToolMiddleware(AgentMiddleware):
    """工具执行边界的同步和异步采集适配器。"""

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        """采集同步工具，原样返回业务结果。"""
        with _capture(request) as state:
            result = handler(request)
            state["result"] = result
            return result

    async def awrap_tool_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        """采集异步工具，取消和异常原样传播。"""
        with _capture(request) as state:
            result = await handler(request)
            state["result"] = result
            return result
