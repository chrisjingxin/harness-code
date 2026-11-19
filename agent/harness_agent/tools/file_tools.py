"""Harness 自研文件工具透明拦截与接管中间件。

【为什么需要透明接管（Interposition）？】
底层 Agent 框架（DeepAgents）内部自带了基础的文件读写工具（FilesystemMiddleware）。
但原生的工具存在明显的安全缺陷：没有快照防并发校验，没有先读后写门禁，也不支持富文本 Diff 审批。
同时，框架的构图逻辑强制要求该脚手架存在，不能直接将其从执行图中删除。

因此，本模块扮演了“中间人透明接管”的角色：
1. 模型请求阶段（wrap_model_call）：拦截要发送给模型的工具描述列表，将框架原生文件工具的 Schema
   无缝替换为 Harness 增强版定义的 Schema（要求附带 snapshot_id、精确旧文本等）；
2. 工具执行阶段（wrap_tool_call）：当模型发起文件操作时，拦截该调用并短路分发给
   Harness 的 SnapshotFileToolContract 执行，完全绕过框架原生的未受控读写逻辑。

┌────────────────────────────────────────────────────────────────────────┐
│                 Harness 文件工具接管中间件拦截机制                       │
└────────────────────────────────────────────────────────────────────────┘

   LLM 请求 / 调用              HarnessFileToolsMiddleware           执行目标
         │                                 │                             │
  [模型请求工具定义]                       │                             │
         │── 包含框架内置工具定义 ────────>│                             │
         │                                 │ 过滤并替换为 Harness 定义   │
         │                                 │ (加入 snapshot_id 等强约束) │
         │<─ 返回经过安全增强的工具列表 ───│                             │
         │                                 │                             │
  [模型发起文件调用]                       │                             │
         │── write_file / edit_file ──────>│                             │
         │                                 │ 拦截并短路分发              │
         │                                 │ (完全绕过框架原生处理)      │
         │                                 │──── 转发给 Harness 契约 ───>│ (SnapshotFileToolContract)
         │                                 │                             │ [执行严格快照门禁]
         │<─ 返回结构化 ToolMessage ───────│<─── 返回安全执行结果 ───────│
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool

from harness_agent.compose.recovery import (
    EffectVerification,
    ToolEffectPolicy,
    VerificationOutcome,
)
from harness_agent.threads.text_backend import (
    TextDocument,
    TextMutationBackend,
    TextMutationError,
)
from harness_agent.tools.file_tool_catalog import (
    BUILTIN_FILE_TOOL_NAMES,
    HARNESS_FILE_TOOL_NAMES,
)


class FileToolContractError(RuntimeError):
    """文件契约接管或分发执行时的受控业务异常。"""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        edit_index: int | None = None,
    ) -> None:
        """保存标准化的错误代码（如 EXACT_MATCH_NOT_FOUND），以便大模型理解并自动重试。

        edit_index 仅用于 edit_file 的批量 edits[]：指出是数组里第几项（从 0 开始）出错，
        让模型只需要修正那一项；与某一项无关的错误保持 None。
        """
        self.code = code
        self.edit_index = edit_index
        super().__init__(message or code)


@runtime_checkable
class FileToolContract(Protocol):
    """可注入的 Harness 文件工具执行契约协议。"""

    @property
    def tool_definitions(self) -> Sequence[BaseTool | dict[str, Any]]:
        """返回模型请求中使用的 canonical definitions。"""

    @property
    def handled_tool_names(self) -> frozenset[str]:
        """返回不会落入 DeepAgents builtin handler 的工具名。"""

    @property
    def registration_tools(self) -> Sequence[BaseTool | dict[str, Any]]:
        """返回必须注册到 ToolNode 的非 builtin 工具。"""

    def dispatch(self, request: ToolCallRequest) -> ToolMessage | Any:
        """同步接管一个文件工具调用。"""

    async def adispatch(self, request: ToolCallRequest) -> ToolMessage | Any:
        """异步接管一个文件工具调用。"""


def _tool_name(tool: object) -> str:
    """读取 BaseTool、OpenAI function schema 或普通 mapping 的稳定名称。"""
    if isinstance(tool, dict):
        name = tool.get("name")
        if isinstance(name, str):
            return name
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            return str(function["name"])
        return ""
    return str(getattr(tool, "name", ""))


class HarnessFileToolsMiddleware(AgentMiddleware):
    """Harness 文件工具接管中间件：向模型注入强化后的 Schema，并在执行时短路分发给 Harness 契约。"""

    def __init__(self, contract: FileToolContract) -> None:
        """初始化中间件并校验契约。本中间件只作为透明拦截层，不自行注册孤立的 tools 属性。"""
        super().__init__()
        definitions = tuple(contract.tool_definitions)
        names = tuple(_tool_name(tool) for tool in definitions)
        if any(not name for name in names) or len(set(names)) != len(names):
            raise ValueError("FILE_TOOL_CONTRACT_SCHEMA_DUPLICATE")
        handled = frozenset(contract.handled_tool_names)
        if handled != frozenset(names):
            raise ValueError("FILE_TOOL_CONTRACT_NAMES_MISMATCH")
        self._contract = contract
        self._definitions = definitions
        self._definitions_by_name = dict(zip(names, definitions, strict=True))
        self._handled_tool_names = handled

    @property
    def handled_tool_names(self) -> frozenset[str]:
        """返回当前中间件接管的所有文件工具名称集合。"""
        return self._handled_tool_names

    def _replace_file_tools(self, tools: Sequence[object]) -> list[BaseTool | dict[str, Any]]:
        """保留上游工具顺序，并将所有被接管的文件工具替换为 Harness 增强版定义。"""
        replaced: list[BaseTool | dict[str, Any]] = []
        emitted: set[str] = set()
        for tool in tools:
            name = _tool_name(tool)
            if name not in self._handled_tool_names:
                replaced.append(tool)  # type: ignore[arg-type]
                continue
            if name not in emitted:
                replaced.append(self._definitions_by_name[name])
                emitted.add(name)
        return replaced

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse | ExtendedModelResponse:
        """拦截同步模型请求：向大模型展示带有快照约束的 Harness 文件工具 Schema。"""
        return handler(request.override(tools=self._replace_file_tools(request.tools)))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse | ExtendedModelResponse:
        """拦截异步模型请求：向大模型展示带有快照约束的 Harness 文件工具 Schema。"""
        return await handler(request.override(tools=self._replace_file_tools(request.tools)))

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Any],
    ) -> Any:
        """拦截同步工具执行：文件调用直接分发给 Harness 契约，绝不让调用流入框架默认未受控实现。"""
        name = str(request.tool_call.get("name", ""))
        if name not in self._handled_tool_names:
            return handler(request)
        try:
            result = self._contract.dispatch(request)
            if inspect.isawaitable(result):
                return self._error(request, "FILE_TOOL_ASYNC_REQUIRED")
            return result
        except Exception as exc:  # noqa: BLE001 - 工具边界必须转成稳定 ToolMessage
            return self._error(request, _error_code(exc))

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[Any]],
    ) -> Any:
        """拦截异步工具执行：文件调用直接分发给 Harness 契约，绝不让调用流入框架默认未受控实现。"""
        name = str(request.tool_call.get("name", ""))
        if name not in self._handled_tool_names:
            return await handler(request)
        try:
            result = self._contract.adispatch(request)
            if inspect.isawaitable(result):
                return await result
            return result
        except Exception as exc:  # noqa: BLE001 - 工具边界必须转成稳定 ToolMessage
            return self._error(request, _error_code(exc))

    @staticmethod
    def _error(request: ToolCallRequest, code: str) -> ToolMessage:
        """构造安全的统一错误返回消息，防止泄露系统内部敏感异常。"""
        name = str(request.tool_call.get("name", "filesystem"))
        return ToolMessage(
            content=f"Harness 文件工具接管失败：{code}。",
            name=name,
            tool_call_id=str(request.tool_call.get("id") or "file-tool"),
            status="error",
        )


def _error_code(exc: Exception) -> str:
    """从受控错误读取 code，普通异常统一归类不泄露内部信息。"""
    code = getattr(exc, "code", None)
    return str(code) if isinstance(code, str) and code else "FILE_TOOL_EXECUTION_FAILED"


def make_file_effect_receipt(document: TextDocument, *, backend_id: str) -> dict[str, object]:
    """以真实重读 Snapshot 构造文件 effect receipt；不接受模型自述内容。"""
    return {
        "backend_id": backend_id,
        "path": document.path,
        "digest": document.identity.digest,
        "byte_length": document.identity.byte_length,
    }


class FileMutationEffectVerifier:
    """文件写操作的真实状态对账器：通过读取磁盘实际文件哈希，验证写操作是已执行、未执行还是发生了漂移。
    
    在 Agent 执行异常崩溃、会话恢复或自动重试时，单纯看大模型的发言无法证明文件究竟写进去了没有。
    本对账器直接比对磁盘真实字节哈希与意图中的 expected_digest，为恢复逻辑提供绝对可信的物理事实。
    """

    def __init__(self, backend: TextMutationBackend) -> None:
        self._backend = backend

    def classify(self, intent: Mapping[str, object]) -> ToolEffectPolicy:
        """判断工具调用是否可对账：write、create、delete 等具有确定性磁盘副作用的操作支持对账。"""
        if intent.get("tool") in {"write", "create", "delete"}:
            return ToolEffectPolicy.RECONCILABLE
        return ToolEffectPolicy.UNKNOWN

    def verify(self, intent: Mapping[str, object]) -> EffectVerification:
        """读取磁盘实际内容，与预期哈希（expected_digest）及修改前哈希（base_digest）对账。"""
        tool = intent.get("tool")
        path = intent.get("path")
        if not isinstance(tool, str) or not isinstance(path, str):
            return EffectVerification(VerificationOutcome.UNKNOWN)
        if tool == "delete":
            return self._verify_delete(intent, path)
        try:
            current = self._backend.read_text_document(path)
        except TextMutationError as exc:
            if exc.code == "FILE_NOT_FOUND":
                if tool == "create":
                    return EffectVerification(VerificationOutcome.NOT_EXECUTED)
                return EffectVerification(VerificationOutcome.UNKNOWN)
            return EffectVerification(VerificationOutcome.UNKNOWN)
        expected_digest = intent.get("expected_digest")
        expected_length = intent.get("expected_byte_length")
        if (
            isinstance(expected_digest, str)
            and current.identity.digest == expected_digest
            and current.identity.byte_length == expected_length
        ):
            receipt = make_file_effect_receipt(
                current,
                backend_id=self._backend.backend_id,
            )
            return EffectVerification(VerificationOutcome.EXECUTED, receipt)
        base_digest = intent.get("base_digest")
        if isinstance(base_digest, str) and current.identity.digest == base_digest:
            return EffectVerification(VerificationOutcome.NOT_EXECUTED)
        return EffectVerification(VerificationOutcome.UNKNOWN)

    def _verify_delete(
        self,
        intent: Mapping[str, object],
        path: str,
    ) -> EffectVerification:
        """删除操作的物理对账：文件在磁盘上消失证明已执行；文件仍保留原哈希证明尚未执行。"""
        base_digest = intent.get("base_digest")
        try:
            current = self._backend.read_text_document(path)
        except TextMutationError as exc:
            if exc.code == "FILE_NOT_FOUND":
                if isinstance(base_digest, str) and base_digest:
                    return EffectVerification(
                        VerificationOutcome.EXECUTED,
                        {
                            "backend_id": self._backend.backend_id,
                            "path": path,
                            "deleted": True,
                            "digest": base_digest,
                        },
                    )
                return EffectVerification(VerificationOutcome.UNKNOWN)
            return EffectVerification(VerificationOutcome.UNKNOWN)
        if isinstance(base_digest, str) and current.identity.digest == base_digest:
            return EffectVerification(VerificationOutcome.NOT_EXECUTED)
        return EffectVerification(VerificationOutcome.UNKNOWN)


__all__ = [
    "BUILTIN_FILE_TOOL_NAMES",
    "FileMutationEffectVerifier",
    "FileToolContract",
    "FileToolContractError",
    "HARNESS_FILE_TOOL_NAMES",
    "HarnessFileToolsMiddleware",
    "make_file_effect_receipt",
]
