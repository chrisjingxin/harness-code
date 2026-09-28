"""Harness 文件操作安全契约（基于 Snapshot 快照与先读后写机制）。

【为什么需要 Snapshot（快照）机制？】
大语言模型在直接修改代码文件时，通常面临两个容易引发代码灾难的问题：
1. 凭空幻觉：模型凭记忆猜测文件里有某段代码并尝试替换，若匹配逻辑粗糙，容易改错位置甚至破坏文件；
2. 并发脏写：在模型思考期间，用户或外部构建工具可能已经改动了文件。若模型仍按旧内容覆盖，会导致最新修改丢失。

为了彻底消除这两类问题，Harness 设计了基于快照（Snapshot）的“先读后写”（Prior-Read）契约：
- 先读：模型必须先调用 read_file 实际读取目标文件，系统会根据文件当前哈希签发唯一的 snapshot_id；
- 后写：模型调用 edit_file 时必须附带此 snapshot_id，并提供精确唯一的 old_string；
- 校验：系统会校验 snapshot_id 是否仍与当前磁盘内容一致、old_string 是否在文件中唯一且处于模型实际读过的行范围内；
- 原子替换：校验完全通过后，才生成差异预览交由用户/系统审批并写入磁盘。

┌────────────────────────────────────────────────────────────────────────┐
│                   Harness 文件先读后写安全工作流 (Snapshot)            │
└────────────────────────────────────────────────────────────────────────┘

    大模型 (LLM)                  文件系统契约 (Contract)            本地磁盘 (Disk)
         │                                   │                             │
    1. 想改文件，先读代码                     │                             │
         │──── read_file(path, offset) ─────>│                             │
         │                                   │──── 读取文件与哈希指纹 ────>│
         │                                   │<─── 返回磁盘内容与哈希 ─────│
         │                                   │                             │
         │                                   │ [生成短期快照 Snapshot]    │
         │                                   │ (记录当前哈希与已读行范围)  │
         │<─── {snapshot_id, content} ───────│                             │
         │                                   │                             │
    2. 发起精确替换修改                      │                             │
         │──── edit_file(snapshot_id, ──────>│                             │
         │               old_str, new_str)   │                             │
         │                                   │ 严格三重安全门禁校验：      │
         │                                   │ 1. 快照校验：磁盘文件有无变动│
         │                                   │ 2. 范围校验：模型是否真读过  │
         │                                   │ 3. 唯一校验：old_str 是否唯一│
         │                                   │                             │
         │                                   │ [通过后写入磁盘并重读验证]  │
         │                                   │────────────────────────────>│
         │<─── {ok: true, snapshot_id} ──────│<─── 写入成功，签发新快照 ───│
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import FileData, GlobResult, GrepResult, LsResult, ReadResult
from deepagents.backends.utils import (
    _get_file_type,
    check_empty_content,
    format_content_with_line_numbers,
    format_grep_matches,
    truncate_if_too_long,
)
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.config import get_config

from harness_agent.threads.snapshots import (
    SnapshotRecord,
    ThreadSnapshotStore,
)
from harness_agent.threads.text_backend import (
    TextDocument,
    TextMutationBackend,
    TextMutationError,
)
from harness_agent.tools.file_mutation import (
    FileMutationService,
    MutationMetadata,
    PreparedFileMutation,
    mutation_fingerprint,
)
from harness_agent.tools.file_diagnostics import (
    MAX_DIAGNOSTIC_BYTES,
    MAX_DIAGNOSTIC_ITEMS,
    diagnostics_timeout as _diagnostics_timeout,
    diagnostics_unavailable as _diagnostics_unavailable,
    elapsed_ms as _elapsed_ms,
    summarize_diagnostics as _summarize_diagnostics,
)
from harness_agent.tools.file_tool_metrics import FileToolMetrics
from harness_agent.tools.file_tools import (
    BUILTIN_FILE_TOOL_NAMES,
    HARNESS_FILE_TOOL_NAMES,
    FileToolContractError,
)
from harness_agent.tools.plan_file import is_plan_virtual_path
from harness_agent.tools.snapshot_file_schema import (
    CanonicalDeleteFileSchema,
    CanonicalEditFileSchema,
    CanonicalReadFileSchema,
    CanonicalWriteFileSchema,
    DEFAULT_READ_LIMIT,
    MAX_READ_LIMIT,
    create_file_tool_definitions,
    is_harness_virtual_path as _is_virtual,
    non_negative_int_argument as _non_negative_int,
    optional_path_argument as _optional_path,
    path_argument as _path,
    positive_int_argument as _positive_int,
    require_canonical_argument_keys as _require_canonical_argument_keys,
    snapshot_id_argument as _snapshot_id,
    string_argument as _string_arg,
)
from harness_agent.tools.snapshot_file_support import (
    attach_post_write_drift as _attach_post_write_drift,
    error_code as _error_code,
    error_message as _error_message,
    message as _message,
    next_action as _next_action,
    normalize_line_endings as _normalize_line_endings,
    observation_path as _observation_path,
    render_changed_context as _render_changed_context,
    render_window as _render_window,
    require_actual_document as _require_actual_document,
    require_mutation_size as _require_mutation_size,
    require_mutation_text_size as _require_mutation_text_size,
    require_text_size as _require_text_size,
    shown_lines as _shown_lines,
    source_line_range as _source_line_range,
    tool_payload as _tool_payload,
)

logger = logging.getLogger(__name__)

DEFAULT_DIAGNOSTICS_TIMEOUT_SECONDS = 1.0
"""写入成功后，只读代码诊断（如语法检查、Linter 提示）的等待超时上限（秒），超时不会影响已成功的写盘。"""


class SnapshotFileToolContract:
    """Harness 唯一官方文件工具契约实现，强制实行先读后写与版本一致性校验。"""

    def __init__(
        self,
        backend: Any,
        *,
        snapshot_store: ThreadSnapshotStore | None,
        text_backend: TextMutationBackend,
        diagnostics_provider: Callable[[str], Awaitable[Mapping[str, object]]] | None = None,
        diagnostics_timeout_seconds: float = DEFAULT_DIAGNOSTICS_TIMEOUT_SECONDS,
        metrics: FileToolMetrics | None = None,
    ) -> None:
        """绑定文件系统底层后端、快照持久化仓库、文本替换服务与指标收集器。"""
        if diagnostics_timeout_seconds <= 0:
            raise ValueError("DIAGNOSTICS_TIMEOUT_INVALID")
        self._backend = backend
        self._snapshot_store = snapshot_store or ThreadSnapshotStore()
        self._text_backend = text_backend
        self._mutation_service = FileMutationService(text_backend)
        self._diagnostics_provider = diagnostics_provider
        self._diagnostics_timeout_seconds = diagnostics_timeout_seconds
        self._metrics = metrics or FileToolMetrics()
        self._definitions = create_file_tool_definitions()

    @property
    def tool_definitions(self) -> Sequence[BaseTool | dict[str, Any]]:
        """返回主 Agent 与子 Agent 统一对模型可见的工具参数描述（Schema）。"""
        return self._definitions

    @property
    def handled_tool_names(self) -> frozenset[str]:
        """返回由当前契约全权接管的所有文件工具名称集合。"""
        return HARNESS_FILE_TOOL_NAMES

    @property
    def registration_tools(self) -> Sequence[BaseTool | dict[str, Any]]:
        """只注册底层框架原生不提供的占位工具（例如 delete_file）。"""
        return tuple(tool for tool in self._definitions if getattr(tool, "name", "") not in BUILTIN_FILE_TOOL_NAMES)

    def dispatch(self, request: ToolCallRequest) -> ToolMessage:
        """同步分发执行一项文件工具调用，将任何异常统一收敛为结构化 JSON 提示。"""
        message = self._dispatch(request)
        self._observe(message)
        return message

    def _dispatch(self, request: ToolCallRequest) -> ToolMessage:
        """根据工具名称分发到具体的读取、创建、编辑或搜索方法。"""
        name, args, tool_call_id = self._call_args(request)
        try:
            _require_canonical_argument_keys(name, args)
            if name == "read_file":
                return self._read_file(request, args, tool_call_id)
            if name == "write_file":
                return self._write_file(request, args, tool_call_id)
            if name == "edit_file":
                return self._edit_file(request, args, tool_call_id)
            if name == "delete_file":
                return self._delete_file(request, args, tool_call_id)
            if name == "ls":
                return self._ls(request, args, tool_call_id)
            if name == "glob":
                return self._glob(request, args, tool_call_id)
            if name == "grep":
                return self._grep(request, args, tool_call_id)
            raise FileToolContractError("FILE_TOOL_NAME_UNSUPPORTED")
        except Exception as exc:  # noqa: BLE001 - 工具边界不得泄露原始 backend 异常栈
            return self._error(name, tool_call_id, _error_code(exc))

    async def adispatch(self, request: ToolCallRequest) -> ToolMessage:
        """异步执行文件工具：落盘完成后可限时收集语法诊断结果并随消息返回。"""
        message = await asyncio.to_thread(self._dispatch, request)
        message = await self._attach_async_diagnostics(request, message)
        self._observe(message)
        return message

    def approval_preflight(self, request: ToolCallRequest) -> bool:
        """在弹出用户审批卡片前做预检：若参数本身非法或快照已失效，直接报错而不弹出注定失败的审批卡片。"""
        name = str(request.tool_call.get("name", ""))
        if name not in {"write_file", "edit_file", "delete_file"}:
            return True
        args = request.tool_call.get("args") or {}
        path = args.get("file_path") if isinstance(args, dict) else None
        if name in {"write_file", "edit_file"} and isinstance(path, str) and is_plan_virtual_path(path):
            return True
        try:
            self._prepare_mutation(request)
        except Exception:  # noqa: BLE001 - 校验失败由后续真正执行时的 ToolMessage 明确说明
            return False
        return True

    def approval_description(self, tool_call: dict[str, Any], _state: Any, runtime: Any) -> str:
        """从预先准备好的文件变更计划中生成人性化的文本 Diff 摘要，供用户审批界面展示。"""
        request = type("ApprovalToolCallRequest", (), {"tool_call": tool_call, "runtime": runtime})()
        plan = self._prepare_mutation(request)
        return self._mutation_service.approval_description(plan)

    def approval_details(self, tool_call: dict[str, Any], _state: Any, runtime: Any) -> Any:
        """返回结构化的 Diff 详情对象，便于前端 TUI/Web 渲染高亮对比视图。"""
        request = type("ApprovalToolCallRequest", (), {"tool_call": tool_call, "runtime": runtime})()
        plan = self._prepare_mutation(request)
        return self._mutation_service.approval_details(plan)

    def _read_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """读取文件文本内容并签发快照（Snapshot）。
        
        为避免超大文件撑爆上下文，支持分页窗口（offset/limit）。系统会记录模型
        本次读取的实际行范围，并签发唯一的 snapshot_id。后续模型如果想编辑该文件，
        只能修改这次“亲眼读过”的有效行范围。
        """
        path = _path(args, "file_path", "read_file")
        offset = _non_negative_int(args.get("offset", 0), "offset")
        limit = _positive_int(args.get("limit", DEFAULT_READ_LIMIT), "limit")
        if limit > MAX_READ_LIMIT:
            raise FileToolContractError("READ_LIMIT_EXCEEDED")
        if _is_virtual(path):
            return self._read_virtual(request, path, offset, limit, tool_call_id)
        if Path(path).suffix.lower() == ".ipynb":
            return self._read_without_snapshot(request, path, offset, limit, tool_call_id)
        try:
            document = self._text_backend.read_text_document(path)
        except TextMutationError as exc:
            if exc.code not in {"TEXT_ENCODING_UNSUPPORTED", "BACKEND_TEXT_UNSUPPORTED"}:
                raise
            return self._read_without_snapshot(request, path, offset, limit, tool_call_id)
        _require_mutation_size(document)
        rendered, shown_count, context_truncated = _render_window(document.content, offset, limit)
        # 超长输出的可见部分不足以证明模型读过一整源行，不能扩大 seen range。
        record_limit = shown_count if not context_truncated else 0
        record = self._record_snapshot(request, document, offset=offset, limit=record_limit)
        payload = {
            "ok": True,
            "path": path,
            "snapshot_id": record.snapshot_id,
            "shown_lines": _shown_lines(offset, shown_count),
            "total_lines": record.line_count,
            "line_count": record.line_count,
            "byte_length": record.byte_length,
            "content": rendered,
            "truncated": context_truncated,
        }
        return _message("read_file", tool_call_id, payload)

    def _read_without_snapshot(
        self,
        request: ToolCallRequest,
        path: str,
        offset: int,
        limit: int,
        tool_call_id: str,
    ) -> ToolMessage:
        """读取 Notebook (.ipynb) 或二进制等特殊文件，仅供查看，绝不签发可写快照。
        
        Notebook 文件由复杂的 JSON 单元格组成，直接当成纯文本让模型替换极易损坏格式；
        非文本二进制文件同样如此。因此此类文件仅能读取供模型参考，不可通过 edit_file 编辑。
        """
        result = self._resolve_backend(request).read(path, offset=offset, limit=limit)
        if isinstance(result, str):
            content = result
            encoding = "utf-8"
        elif isinstance(result, ReadResult):
            if result.error or result.file_data is None:
                raise FileToolContractError("BACKEND_READ_FAILED")
            content = str(result.file_data.get("content", ""))
            encoding = str(result.file_data.get("encoding", "utf-8"))
        else:
            raise FileToolContractError("BACKEND_READ_FAILED")

        file_type = _get_file_type(path)
        if encoding == "base64" or file_type != "text":
            block_type = file_type if file_type != "text" else "file"
            mime_type = mimetypes.guess_type("file" + Path(path).suffix)[0] or "application/octet-stream"
            return ToolMessage(
                content_blocks=[{"type": block_type, "base64": content, "mime_type": mime_type}],
                name="read_file",
                tool_call_id=tool_call_id,
                additional_kwargs={"read_file_path": path, "read_file_media_type": mime_type},
                status="success",
            )

        empty = check_empty_content(content)
        rendered = empty or format_content_with_line_numbers(content, start_line=offset + 1)
        payload = {
            "ok": True,
            "path": path,
            "snapshot_id": None,
            "shown_lines": _shown_lines(offset, len(content.splitlines())),
            "total_lines": None,
            "content": rendered,
            "truncated": False,
        }
        return _message("read_file", tool_call_id, payload)

    def _read_virtual(
        self,
        request: ToolCallRequest,
        path: str,
        offset: int,
        limit: int,
        tool_call_id: str,
    ) -> ToolMessage:
        """保留 /.harness 的只读 backend 行为，但绝不生成可写 Snapshot。"""
        result = self._resolve_backend(request).read(path, offset=offset, limit=limit)
        if isinstance(result, str):
            content = result
        elif isinstance(result, ReadResult):
            if result.error:
                raise FileToolContractError("BACKEND_READ_FAILED")
            data: FileData | None = result.file_data
            if data is None or not isinstance(data.get("content"), str):
                raise FileToolContractError("BACKEND_READ_FAILED")
            content = str(data["content"])
        else:
            raise FileToolContractError("BACKEND_READ_FAILED")
        payload = {
            "ok": True,
            "path": path,
            "snapshot_id": None,
            "shown_lines": _shown_lines(offset, len(content.splitlines())),
            "total_lines": None,
            "content": content,
            "truncated": False,
        }
        return _message("read_file", tool_call_id, payload)

    def _write_plan_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """覆盖写入会话计划文件；不走工作区 Snapshot / CAS。"""
        path = _path(args, "file_path", "write_file")
        content = _string_arg(args, "content")
        _require_mutation_text_size(content)
        result = self._resolve_backend(request).write(path, content)
        if getattr(result, "error", None):
            raise FileToolContractError("VIRTUAL_READONLY")
        return _message(
            "write_file",
            tool_call_id,
            {
                "ok": True,
                "path": path,
                "created": True,
                "snapshot_id": None,
                "content": content,
                "truncated": False,
                "diagnostics": _diagnostics_unavailable(),
            },
        )

    def _edit_plan_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """按 exact replacement 改会话计划文件；不签发工作区 Snapshot。"""
        path = _path(args, "file_path", "edit_file")
        old_string = _string_arg(args, "old_string")
        new_string = _string_arg(args, "new_string")
        _require_text_size(old_string)
        _require_text_size(new_string)
        result = self._resolve_backend(request).edit(path, old_string, new_string)
        error = getattr(result, "error", None)
        if error:
            text = str(error)
            if "does not exist" in text:
                raise FileToolContractError("FILE_NOT_FOUND")
            if "old_string not found" in text:
                raise FileToolContractError("EXACT_MATCH_NOT_FOUND")
            raise FileToolContractError("VIRTUAL_READONLY")
        return _message(
            "edit_file",
            tool_call_id,
            {
                "ok": True,
                "path": path,
                "replaced": getattr(result, "occurrences", 1) or 1,
                "snapshot_id": None,
                "diagnostics": _diagnostics_unavailable(),
            },
        )

    def _write_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """新建文件并写入内容。
        
        仅适用于创建尚不存在的新文件。如果文件已存在，会报错拒绝并引导使用 edit_file，
        防止模型不小心覆盖现有代码。创建成功后，会立即为该文件签发首个有效快照。
        """
        path = _path(args, "file_path", "write_file")
        if is_plan_virtual_path(path):
            return self._write_plan_file(request, args, tool_call_id)
        plan = self._prepare_mutation(request)
        committed = self._mutation_service.commit(plan)
        document = _require_actual_document(committed.actual)
        _require_mutation_size(document)
        rendered, offset, shown_count, context_truncated, context_editable = _render_changed_context(
            document,
            committed.changed_range,
        )
        record = self._record_snapshot(
            request,
            document,
            offset=offset,
            limit=shown_count if context_editable else 0,
        )
        payload = {
            "ok": True,
            "path": plan.metadata.path,
            "created": True,
            "snapshot_id": record.snapshot_id,
            "changed_range": committed.changed_range.payload(),
            "shown_lines": _shown_lines(offset, shown_count),
            "total_lines": record.line_count,
            "line_count": record.line_count,
            "content": rendered,
            "truncated": context_truncated,
            "diagnostics": _diagnostics_unavailable(),
        }
        _attach_post_write_drift(payload, committed, plan)
        return _message("write_file", tool_call_id, payload)

    def _edit_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """基于快照的精确局部文本替换。
        
        必须传入有效的 snapshot_id 以及在文件中唯一出现的 old_string。
        在校验快照未过期、文本唯一且在已读范围内之后，执行局部替换并回读磁盘。
        执行成功后向模型返回修改局部的新内容以及全新签发的 snapshot_id。
        """
        path = _path(args, "file_path", "edit_file")
        if is_plan_virtual_path(path):
            return self._edit_plan_file(request, args, tool_call_id)
        plan = self._prepare_mutation(request)
        committed = self._mutation_service.commit(plan)
        actual = _require_actual_document(committed.actual)
        _require_mutation_size(actual)
        rendered, offset, shown_count, context_truncated, context_editable = _render_changed_context(
            actual,
            committed.changed_range,
        )
        new_record = self._record_snapshot(
            request,
            actual,
            offset=offset,
            limit=shown_count if context_editable else 0,
        )
        payload = {
            "ok": True,
            "path": plan.metadata.path,
            "snapshot_id": new_record.snapshot_id,
            "replaced": 1,
            "changed_range": committed.changed_range.payload(),
            "shown_lines": _shown_lines(offset, shown_count),
            "total_lines": new_record.line_count,
            "line_count": new_record.line_count,
            "content": rendered,
            "truncated": context_truncated,
            "diagnostics": _diagnostics_unavailable(),
        }
        _attach_post_write_drift(payload, committed, plan)
        return _message("edit_file", tool_call_id, payload)

    def _delete_file(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> ToolMessage:
        """安全删除文件。
        
        要求必须完整读过该文件并附带有效 snapshot_id。删除成功后，会把该文件关联
        的所有历史快照标记为失效，防止模型后续拿旧快照进行误操作。
        """
        plan = self._prepare_mutation(request)
        committed = self._mutation_service.commit(plan)
        path = plan.metadata.path
        invalidated = self._snapshot_store.invalidate_path(
            self._thread_id(request), path, self._text_backend.backend_id
        )
        payload: dict[str, Any] = {
            "ok": True,
            "path": path,
            "deleted": committed.actual is None,
            "invalidated_snapshots": invalidated,
        }
        if committed.actual is not None:
            _require_mutation_size(committed.actual)
            rendered, offset, shown_count, context_truncated, context_editable = _render_changed_context(
                committed.actual,
                committed.changed_range,
            )
            actual_record = self._record_snapshot(
                request,
                committed.actual,
                offset=offset,
                limit=shown_count if context_editable else 0,
            )
            payload["snapshot_id"] = actual_record.snapshot_id
            payload["shown_lines"] = _shown_lines(offset, shown_count)
            payload["total_lines"] = actual_record.line_count
            payload["content"] = rendered
            payload["truncated"] = context_truncated
        _attach_post_write_drift(payload, committed, plan)
        return _message("delete_file", tool_call_id, payload)

    async def _attach_async_diagnostics(
        self, request: ToolCallRequest, message: ToolMessage
    ) -> ToolMessage:
        """仅对已成功 create/edit 的实际文件追加有界只读 diagnostics 摘要。"""
        name = str(request.tool_call.get("name", ""))
        if name not in {"write_file", "edit_file"}:
            return message
        payload = _tool_payload(message)
        if payload is None or payload.get("ok") is not True:
            return message
        path = payload.get("path")
        if not isinstance(path, str):
            return message
        payload["diagnostics"] = await self._collect_diagnostics(path)
        return _message(name, str(request.tool_call.get("id") or "file-tool"), payload)

    async def _collect_diagnostics(self, path: str) -> dict[str, object]:
        """在固定短超时内调用可选 provider；任何失败都不影响已完成提交。"""
        provider = self._diagnostics_provider
        if provider is None:
            return _diagnostics_unavailable()
        started = time.monotonic()
        try:
            response = await asyncio.wait_for(
                provider(path),
                timeout=self._diagnostics_timeout_seconds,
            )
        except TimeoutError:
            return _diagnostics_timeout(_elapsed_ms(started))
        except Exception:  # noqa: BLE001 - provider 细节不能进入模型结果或日志
            return _diagnostics_unavailable(_elapsed_ms(started))
        return _summarize_diagnostics(response, _elapsed_ms(started))

    def _observe(self, message: ToolMessage) -> None:
        """写入不含路径、正文、参数和完整 Snapshot ID 的 Host 聚合指标。"""
        name = str(getattr(message, "name", "filesystem"))
        content = str(message.content)
        payload = _tool_payload(message)
        if payload is None:
            self._metrics.record_result(name, ok=False, result_bytes=len(content.encode("utf-8")), error_code=None)
            return
        ok = payload.get("ok") is True
        error = payload.get("error")
        error_code = error.get("code") if isinstance(error, dict) else None
        self._metrics.record_result(
            name,
            ok=ok,
            result_bytes=len(content.encode("utf-8")),
            error_code=error_code if isinstance(error_code, str) else None,
        )
        logger.info(
            "file_tool_observed tool=%s path=%s ok=%s code=%s result_bytes=%s",
            name,
            _observation_path(payload.get("path")),
            ok,
            error_code if isinstance(error_code, str) else "-",
            len(content.encode("utf-8")),
        )
        if name == "read_file" and ok:
            snapshot_id = payload.get("snapshot_id")
            self._metrics.record_read(snapshot_id if isinstance(snapshot_id, str) else None)
        diagnostics = payload.get("diagnostics")
        if isinstance(diagnostics, dict):
            status = diagnostics.get("status")
            latency_ms = diagnostics.get("latency_ms")
            self._metrics.record_diagnostics(
                status if isinstance(status, str) else "unavailable",
                float(latency_ms) if isinstance(latency_ms, (int, float)) else None,
            )

    def _prepare_mutation(self, request: ToolCallRequest) -> PreparedFileMutation:
        """把已通过 canonical schema 的工具调用转换为不含原始参数的提交计划。"""
        name, args, tool_call_id = self._call_args(request)
        _require_canonical_argument_keys(name, args)
        if name == "write_file":
            return self._prepare_write(request, args, tool_call_id)
        if name == "edit_file":
            return self._prepare_edit(request, args, tool_call_id)
        if name == "delete_file":
            return self._prepare_delete(request, args, tool_call_id)
        raise FileToolContractError("FILE_TOOL_NAME_UNSUPPORTED")

    def _prepare_write(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> PreparedFileMutation:
        """确认目标当前不存在，再把 create 内容固定为可审批计划。"""
        path = _path(args, "file_path", "write_file")
        content = _string_arg(args, "content")
        _require_mutation_text_size(content)
        thread_id = self._thread_id(request)
        fingerprint = mutation_fingerprint("write_file", args)
        if cached := self._mutation_service.prepared(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            return cached
        if self._mutation_service.was_consumed(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            raise FileToolContractError("COMMIT_CONFLICT")
        try:
            existing = self._text_backend.read_text_document(path)
        except TextMutationError as exc:
            if exc.code != "FILE_NOT_FOUND":
                raise
        else:
            _require_mutation_size(existing)
            raise FileToolContractError("FILE_ALREADY_EXISTS")
        return self._mutation_service.prepare(
            metadata=MutationMetadata(
                operation="write",
                path=path,
                thread_id=thread_id,
                tool_call_id=tool_call_id,
            ),
            current=None,
            proposed_content=content,
            fingerprint=fingerprint,
        )

    def _prepare_edit(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> PreparedFileMutation:
        """验证 prior-read 唯一替换后，固定当前内容、拟议内容和 expected identity。"""
        path = _path(args, "file_path", "edit_file")
        snapshot_id = _snapshot_id(args)
        old_string = _string_arg(args, "old_string")
        new_string = _string_arg(args, "new_string")
        _require_text_size(old_string)
        _require_text_size(new_string)
        thread_id = self._thread_id(request)
        fingerprint = mutation_fingerprint("edit_file", args)
        if cached := self._mutation_service.prepared(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            return cached
        if self._mutation_service.was_consumed(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            raise FileToolContractError("COMMIT_CONFLICT")
        record = self._resolve_snapshot(request, path, snapshot_id)
        current = self._text_backend.read_text_document(path)
        _require_mutation_size(current)
        self._require_current(record, current)
        old_source = _normalize_line_endings(old_string, current)
        new_source = _normalize_line_endings(new_string, current)
        if not old_source:
            # 空文档没有可登记的源行。只有 Snapshot 与当前完整 identity 都证明
            # 文档仍为零行空文本时，空 old_string 才表示替换整个空文档；绝不
            # 交给 str.find("") 猜测非空文件中的插入位置。
            if record.line_count != 0 or current.content != "":
                raise FileToolContractError("INVALID_EDIT")
            proposed = new_source
        else:
            start = current.content.find(old_source)
            if start < 0:
                raise FileToolContractError("EXACT_MATCH_NOT_FOUND")
            # str.count 只统计不重叠匹配；从首个起点的下一字符继续
            # 搜索，才能把 `aaa` 中的两个 `aa` 正确判为歧义。
            if current.content.find(old_source, start + 1) >= 0:
                raise FileToolContractError("AMBIGUOUS_MATCH")
            start_line, end_line = _source_line_range(current.content, start, old_source)
            if not self._snapshot_store.has_seen(record, start_line, end_line):
                raise FileToolContractError("UNREAD_RANGE")
            proposed = current.content[:start] + new_source + current.content[start + len(old_source) :]
        if proposed == current.content:
            raise FileToolContractError("NO_CHANGES")
        _require_mutation_text_size(proposed)
        return self._mutation_service.prepare(
            metadata=MutationMetadata(
                operation="edit",
                path=path,
                thread_id=thread_id,
                tool_call_id=tool_call_id,
                snapshot_id=snapshot_id,
            ),
            current=current,
            proposed_content=proposed,
            fingerprint=fingerprint,
        )

    def _prepare_delete(
        self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str
    ) -> PreparedFileMutation:
        """验证完整 prior-read 后，固定 compare-delete 所需的 expected identity。"""
        path = _path(args, "file_path", "delete_file")
        snapshot_id = _snapshot_id(args)
        thread_id = self._thread_id(request)
        fingerprint = mutation_fingerprint("delete_file", args)
        if cached := self._mutation_service.prepared(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            return cached
        if self._mutation_service.was_consumed(
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            fingerprint=fingerprint,
        ):
            raise FileToolContractError("COMMIT_CONFLICT")
        record = self._resolve_snapshot(request, path, snapshot_id)
        current = self._text_backend.read_text_document(path)
        _require_mutation_size(current)
        self._require_current(record, current)
        if record.line_count and not self._snapshot_store.has_seen(record, 0, record.line_count):
            raise FileToolContractError("UNREAD_RANGE")
        return self._mutation_service.prepare(
            metadata=MutationMetadata(
                operation="delete",
                path=path,
                thread_id=thread_id,
                tool_call_id=tool_call_id,
                snapshot_id=snapshot_id,
            ),
            current=current,
            proposed_content=None,
            fingerprint=fingerprint,
        )

    def _ls(self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str) -> ToolMessage:
        """保留既有只读 ls 输出。"""
        result: LsResult = self._resolve_backend(request).ls(_path(args, "path", "ls"))
        if result.error:
            raise FileToolContractError("BACKEND_READ_FAILED")
        return ToolMessage(
            content=str(truncate_if_too_long([item.get("path", "") for item in (result.entries or [])])),
            name="ls",
            tool_call_id=tool_call_id,
            status="success",
        )

    def _glob(self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str) -> ToolMessage:
        """保留既有只读 glob 输出。"""
        path = _optional_path(args, "path", "glob")
        result: GlobResult = self._resolve_backend(request).glob(_string_arg(args, "pattern"), path=path)
        if result.error:
            raise FileToolContractError("BACKEND_READ_FAILED")
        return ToolMessage(
            content=str(truncate_if_too_long([item.get("path", "") for item in (result.matches or [])])),
            name="glob",
            tool_call_id=tool_call_id,
            status="success",
        )

    def _grep(self, request: ToolCallRequest, args: dict[str, Any], tool_call_id: str) -> ToolMessage:
        """保留既有只读 grep 输出和三种输出模式。"""
        output_mode = str(args.get("output_mode", "files_with_matches"))
        if output_mode not in {"files_with_matches", "content", "count"}:
            raise FileToolContractError("GREP_OUTPUT_MODE_INVALID")
        result: GrepResult = self._resolve_backend(request).grep(
            _string_arg(args, "pattern"),
            path=_optional_path(args, "path", "grep"),
            glob=args.get("glob") if isinstance(args.get("glob"), str) else None,
        )
        if result.error:
            raise FileToolContractError("BACKEND_READ_FAILED")
        return ToolMessage(
            content=str(truncate_if_too_long(format_grep_matches(result.matches or [], output_mode))),
            name="grep",
            tool_call_id=tool_call_id,
            status="success",
        )

    def _resolve_snapshot(self, request: ToolCallRequest, path: str, snapshot_id: str) -> SnapshotRecord:
        """按当前 Thread、路径和 backend identity 解析，不匹配时 fail closed。"""
        return self._snapshot_store.resolve(
            snapshot_id,
            self._thread_id(request),
            path,
            self._text_backend.backend_id,
        )

    def _record_snapshot(
        self, request: ToolCallRequest, document: TextDocument, *, offset: int, limit: int
    ) -> SnapshotRecord:
        """为模型实际获得的窗口记录身份与 seen range，不缓存源码。"""
        record = self._snapshot_store.record_read(
            self._thread_id(request),
            document.path,
            self._text_backend.backend_id,
            document.content,
            offset=offset,
            limit=limit,
            encoding=document.identity.encoding,
            has_bom=document.identity.has_bom,
            raw_bytes=_raw_bytes(document),
        )
        if record is None:
            raise FileToolContractError("VIRTUAL_READONLY")
        return record

    @staticmethod
    def _require_current(record: SnapshotRecord, document: TextDocument) -> None:
        """Snapshot 只证明当时版本；当前 identity 不同即拒绝提交。"""
        if (
            record.content_hash != document.identity.digest
            or record.byte_length != document.identity.byte_length
            or record.encoding != document.identity.encoding
            or record.has_bom != document.identity.has_bom
            or record.line_ending != document.identity.line_ending
            or record.has_final_newline != document.identity.has_final_newline
        ):
            raise FileToolContractError("STALE_FILE")

    def _resolve_backend(self, request: ToolCallRequest) -> Any:
        """共享图每次调用从 RunContext 获取已挂载虚拟 backend。"""
        return self._backend(request.runtime) if callable(self._backend) else self._backend

    @staticmethod
    def _thread_id(request: ToolCallRequest) -> str:
        """从当前 RunContext 取得 execution scope；缺失时拒绝共享 Snapshot。"""
        runtime = getattr(request, "runtime", None)
        context = getattr(runtime, "context", None)
        checkpoint_thread_id = getattr(context, "checkpoint_thread_id", None)
        if isinstance(checkpoint_thread_id, str) and checkpoint_thread_id:
            return checkpoint_thread_id
        thread_id = getattr(context, "thread_id", None)
        if not isinstance(thread_id, str) or not thread_id:
            config = getattr(runtime, "config", None)
            configurable = config.get("configurable") if isinstance(config, Mapping) else None
            thread_id = configurable.get("thread_id") if isinstance(configurable, Mapping) else None
        if not isinstance(thread_id, str) or not thread_id:
            # HumanInTheLoop 的 description callback 不暴露 Runtime.config，
            # 但仍运行在 LangGraph 的当前调用 context 中；直接读取同一份 config，
            # 不使用进程级 sentinel，也不会让不同 Thread 共享 Snapshot scope。
            try:
                config = get_config()
            except RuntimeError:
                config = {}
            configurable = config.get("configurable") if isinstance(config, Mapping) else None
            thread_id = configurable.get("thread_id") if isinstance(configurable, Mapping) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise FileToolContractError("RUN_CONTEXT_REQUIRED")
        return thread_id

    @staticmethod
    def _call_args(request: ToolCallRequest) -> tuple[str, dict[str, Any], str]:
        """校验工具调用承载的名称、参数对象与追踪 ID。"""
        name = str(request.tool_call.get("name", ""))
        args = request.tool_call.get("args") or {}
        if not isinstance(args, dict):
            raise FileToolContractError("FILE_TOOL_ARGUMENTS_INVALID")
        return name, args, str(request.tool_call.get("id") or "file-tool")

    @staticmethod
    def _error(name: str, tool_call_id: str, code: str) -> ToolMessage:
        """输出不含源码、路径外信息或 backend 异常文本的 JSON 错误。"""
        return _message(
            name or "filesystem",
            tool_call_id,
            {
                "ok": False,
                "error": {
                    "code": code,
                    "message": _error_message(code),
                    "next_action": _next_action(code),
                },
            },
            status="error",
        )


def create_snapshot_file_tool_contract(
    backend: Any,
    *,
    snapshot_store: ThreadSnapshotStore | None,
    text_backend: TextMutationBackend,
    diagnostics_provider: Callable[[str], Awaitable[Mapping[str, object]]] | None = None,
    diagnostics_timeout_seconds: float = DEFAULT_DIAGNOSTICS_TIMEOUT_SECONDS,
    metrics: FileToolMetrics | None = None,
) -> SnapshotFileToolContract:
    """创建唯一 canonical Snapshot 文件工具 contract。"""
    return SnapshotFileToolContract(
        backend,
        snapshot_store=snapshot_store,
        text_backend=text_backend,
        diagnostics_provider=diagnostics_provider,
        diagnostics_timeout_seconds=diagnostics_timeout_seconds,
        metrics=metrics,
    )


def _raw_bytes(document: TextDocument) -> bytes:
    """重建与 TextMutationBackend identity 等价的 UTF-8 原始字节。"""
    prefix = b"\xef\xbb\xbf" if document.identity.has_bom else b""
    return prefix + document.content.encode("utf-8")


__all__ = [
    "CanonicalDeleteFileSchema",
    "CanonicalEditFileSchema",
    "CanonicalReadFileSchema",
    "CanonicalWriteFileSchema",
    "DEFAULT_READ_LIMIT",
    "DEFAULT_DIAGNOSTICS_TIMEOUT_SECONDS",
    "MAX_DIAGNOSTIC_BYTES",
    "MAX_DIAGNOSTIC_ITEMS",
    "MAX_READ_LIMIT",
    "SnapshotFileToolContract",
    "create_snapshot_file_tool_contract",
]
