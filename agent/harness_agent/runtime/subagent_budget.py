"""子代理轮次与时间预算守卫，防止调研失控并在超时前强制收敛交卷。

本模块将可变的预算状态保存在每次派发的 ``RunContext.subagent_budget`` 上，
不在共享图中间件实例上保留任何请求私有状态，确保并发安全。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import SystemMessage, ToolMessage

DEFAULT_EXPLORE_MAX_ROUNDS = 15
DEFAULT_SUBAGENT_MAX_ROUNDS = 30
DEFAULT_WRAP_UP_WINDOW_SECONDS = 30.0

BudgetPhase = Literal["normal", "warn", "force_wrap_up"]


def default_max_rounds_for(
    agent_id: str,
    configured_max_turns: int | None = None,
) -> int:
    """解析子代理允许的最大模型轮次。"""
    if (
        isinstance(configured_max_turns, int)
        and not isinstance(configured_max_turns, bool)
        and configured_max_turns > 0
    ):
        return configured_max_turns
    if agent_id == "explore":
        return DEFAULT_EXPLORE_MAX_ROUNDS
    return DEFAULT_SUBAGENT_MAX_ROUNDS


@dataclass(slots=True)
class SubagentBudget:
    """单次子代理执行持有的轮次与截止时间预算。"""

    max_rounds: int
    deadline_monotonic: float | None = None
    wrap_up_window_seconds: float = DEFAULT_WRAP_UP_WINDOW_SECONDS
    clock: Callable[[], float] = time.monotonic
    rounds_started: int = 0
    wrap_up_forced: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.max_rounds < 1:
            raise ValueError("max_rounds must be positive")
        if self.wrap_up_window_seconds < 0:
            raise ValueError("wrap_up_window_seconds must be non-negative")

    @classmethod
    def for_delegation(
        cls,
        *,
        agent_id: str,
        configured_max_turns: int | None = None,
        timeout_seconds: float | None = None,
        wrap_up_window_seconds: float = DEFAULT_WRAP_UP_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> "SubagentBudget":
        """根据子代理角色、配置轮次与总超时构建预算对象。"""
        max_rounds = default_max_rounds_for(agent_id, configured_max_turns)
        deadline: float | None = None
        effective_window = wrap_up_window_seconds
        if timeout_seconds is not None and timeout_seconds > 0:
            deadline = clock() + timeout_seconds
            effective_window = min(wrap_up_window_seconds, timeout_seconds * 0.2)
        return cls(
            max_rounds=max_rounds,
            deadline_monotonic=deadline,
            wrap_up_window_seconds=effective_window,
            clock=clock,
        )

    @property
    def tools_blocked(self) -> bool:
        """进入强制收敛阶段后，禁止再执行任何工具调用。"""
        with self._lock:
            return self.wrap_up_forced

    def begin_model_round(self) -> BudgetPhase:
        """推进一次模型轮次并返回当前预算阶段。"""
        with self._lock:
            self.rounds_started += 1
            if self.wrap_up_forced:
                return "force_wrap_up"
            # 仅从第 2 轮起检查时间窗口，避免短超时单元测试在首轮被误拦截。
            if (
                self.rounds_started >= 2
                and self.deadline_monotonic is not None
                and (self.deadline_monotonic - self.clock()) <= self.wrap_up_window_seconds
            ):
                self.wrap_up_forced = True
                return "force_wrap_up"
            if self.rounds_started >= self.max_rounds:
                self.wrap_up_forced = True
                return "force_wrap_up"
            if self.max_rounds >= 3 and self.rounds_started == self.max_rounds - 1:
                return "warn"
            return "normal"


def _budget_from_runtime(runtime: object) -> SubagentBudget | None:
    context = getattr(runtime, "context", None)
    budget = getattr(context, "subagent_budget", None)
    return budget if isinstance(budget, SubagentBudget) else None


def _system_text(system_message: SystemMessage | None) -> str:
    if system_message is None:
        return ""
    content = system_message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return str(content or "")


def _apply_budget_prompt(
    request: ModelRequest,
    budget: SubagentBudget,
    phase: BudgetPhase,
) -> ModelRequest:
    if phase == "normal":
        return request
    if phase == "warn":
        notice = (
            f"\n\n【预算提示】当前已接近子代理步数上限（第 {budget.rounds_started}/{budget.max_rounds} 轮），"
            "请收敛调查并准备在下一轮交付最终摘要。"
        )
    else:
        notice = (
            "\n\n【预算已达上限】已达到子代理轮次或时间上限，禁止再调用任何工具。"
            "请立即基于已收集的证据输出结构化最终回复（结论、关键文件路径与符号、未确认缺口），直接交回父 Agent。"
        )
    base = _system_text(request.system_message).rstrip()
    return request.override(system_message=SystemMessage(content=f"{base}{notice}".lstrip()))


def _blocked_tool_message(request: ToolCallRequest) -> ToolMessage:
    tool_call = request.tool_call if isinstance(request.tool_call, dict) else {}
    return ToolMessage(
        content="已达到子代理轮次/时间预算上限，工具调用已停止。请勿再调用工具，立即基于已有证据输出最终摘要回复。",
        tool_call_id=str(tool_call.get("id") or ""),
        name=str(tool_call.get("name") or ""),
        status="error",
    )


class SubagentBudgetMiddleware(AgentMiddleware):
    """在子代理临近上限时注入收敛提示，并在达限后拦截后续工具调用。"""

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse | ExtendedModelResponse:
        budget = _budget_from_runtime(getattr(request, "runtime", None))
        if budget is None:
            return handler(request)
        phase = budget.begin_model_round()
        return handler(_apply_budget_prompt(request, budget, phase))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse | ExtendedModelResponse:
        budget = _budget_from_runtime(getattr(request, "runtime", None))
        if budget is None:
            return await handler(request)
        phase = budget.begin_model_round()
        return await handler(_apply_budget_prompt(request, budget, phase))

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Any],
    ) -> Any:
        budget = _budget_from_runtime(getattr(request, "runtime", None))
        if budget is not None and budget.tools_blocked:
            return _blocked_tool_message(request)
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[Any]],
    ) -> Any:
        budget = _budget_from_runtime(getattr(request, "runtime", None))
        if budget is not None and budget.tools_blocked:
            return _blocked_tool_message(request)
        return await handler(request)


__all__ = [
    "BudgetPhase",
    "DEFAULT_EXPLORE_MAX_ROUNDS",
    "DEFAULT_SUBAGENT_MAX_ROUNDS",
    "DEFAULT_WRAP_UP_WINDOW_SECONDS",
    "SubagentBudget",
    "SubagentBudgetMiddleware",
    "default_max_rounds_for",
]
