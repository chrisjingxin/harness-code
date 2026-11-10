"""按实际模型请求归集一轮用量，不依赖可关闭的 Trace。"""

from __future__ import annotations

from collections.abc import Mapping
from contextvars import ContextVar
from threading import RLock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

MAX_TOKEN_COUNT = 2**53 - 1
current_run_usage: ContextVar[RunUsage | None] = ContextVar("run_usage", default=None)


class RunUsage:
    """保存请求最终值、缺失与冲突事实，并在终态冻结。"""

    def __init__(self) -> None:
        """初始化本轮的请求事实，支持模型回调在不同线程收敛。"""
        self._requests: dict[str, dict[str, int] | None] = {}
        self._conflicts: set[tuple[str, str]] = set()
        self._frozen: dict[str, int | bool | None] | None = None
        self._lock = RLock()

    def start(self, invocation_id: str) -> None:
        """在请求发出前登记身份，缺少结果不能视为零。"""
        with self._lock:
            if self._frozen is None:
                self._requests.setdefault(invocation_id, None)

    def finish(self, invocation_id: str, usage: Mapping[str, Any]) -> None:
        """登记最终累计值；重复相同报告幂等，冲突不覆盖原值。"""
        values = {
            key: value for key in ("input_tokens", "output_tokens", "cached_tokens")
            if type(value := usage.get(key)) is int and 0 <= value <= MAX_TOKEN_COUNT
        }
        with self._lock:
            if self._frozen is not None:
                return
            previous = self._requests.get(invocation_id)
            if previous is not None and previous != values:
                for key in ("input_tokens", "output_tokens", "cached_tokens"):
                    if previous.get(key) != values.get(key):
                        self._conflicts.add((invocation_id, key))
            else:
                self._requests[invocation_id] = values

    def snapshot(self) -> dict[str, int | bool | None]:
        """分别返回输入与输出的已知小计及完整性。"""
        with self._lock:
            return self._snapshot()

    def _snapshot(self) -> dict[str, int | bool | None]:
        """在同一锁内读取事实，避免并行回调增删请求造成不一致。"""
        if self._frozen is not None:
            return dict(self._frozen)
        result: dict[str, int | bool | None] = {}
        for direction in ("input", "output"):
            key = f"{direction}_tokens"
            values = [entry[key] for entry in self._requests.values() if entry is not None and key in entry]
            total = sum(values)
            overflow = total > MAX_TOKEN_COUNT
            result[key] = None if overflow or (self._requests and not values) else total
            conflicted = any(field == key for _, field in self._conflicts)
            result[f"{direction}_complete"] = not overflow and not conflicted and len(values) == len(self._requests)
        # 缓存是输入子集。只在所有请求都报告合法明细时提供命中率所需分子。
        if self._requests and result["input_complete"] and not any(field == "cached_tokens" for _, field in self._conflicts) and all(
            entry is not None and "cached_tokens" in entry and entry["cached_tokens"] <= entry.get("input_tokens", -1)
            for entry in self._requests.values()
        ):
            result["cached_tokens"] = sum(entry["cached_tokens"] for entry in self._requests.values() if entry is not None)
        return result

    def freeze(self) -> dict[str, int | bool | None]:
        """封口后忽略迟到请求或回调。"""
        with self._lock:
            self._frozen = self._snapshot()
            return dict(self._frozen)

    def numeric_totals(self) -> dict[str, int]:
        """为执行注册表投影已知数值；完整性只由最终 Usage 保存。"""
        return {key: value for key, value in self.snapshot().items() if key.endswith("_tokens") and type(value) is int}


class UsageCallback(BaseCallbackHandler):
    """在 LangChain 模型请求边界采集，流式 chunk 不另行累计。"""

    run_inline = True

    def __init__(self, usage: RunUsage, counts: dict[str, int] | None = None) -> None:
        """绑定统计事实及可选的执行层数值投影，不将未知伪装成 wire 零值。"""
        self.usage = usage
        self.counts = counts

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: Any, **kwargs: Any) -> None:
        """请求发出时登记 callback run_id。"""
        self.usage.start(str(run_id))

    def on_llm_start(self, serialized: Any, prompts: Any, *, run_id: Any, **kwargs: Any) -> None:
        """非聊天模型同样登记真实请求。"""
        self.usage.start(str(run_id))

    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> None:
        """仅消费最终响应，防止流式累计值被重复相加。"""
        usage: Mapping[str, Any] = {}
        for group in getattr(response, "generations", ()):
            for generation in group:
                message = getattr(generation, "message", None)
                candidate = getattr(message, "usage_metadata", None)
                metadata = getattr(message, "response_metadata", None)
                raw = (metadata.get("token_usage") or metadata.get("usage")) if isinstance(metadata, Mapping) else None
                if isinstance(candidate, Mapping) or isinstance(raw, Mapping):
                    usage = {**(raw if isinstance(raw, Mapping) else {}), **(candidate if isinstance(candidate, Mapping) else {})}
                    break
            if usage:
                break
        if not usage:
            output = getattr(response, "llm_output", None) or {}
            raw = (output.get("token_usage") or output.get("usage") or {}) if isinstance(output, Mapping) else {}
            if isinstance(raw, Mapping):
                usage = raw
        normalized = dict(usage)
        for key, alias in (("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens")):
            if key not in normalized and alias in normalized:
                normalized[key] = normalized[alias]
        details = normalized.get("input_token_details")
        prompt_details = normalized.get("prompt_tokens_details")
        if isinstance(details, Mapping) and "cache_read" in details:
            normalized["cached_tokens"] = details["cache_read"]
        elif isinstance(prompt_details, Mapping) and "cached_tokens" in prompt_details:
            normalized["cached_tokens"] = prompt_details["cached_tokens"]
        self.usage.finish(str(run_id), normalized)
        if self.counts is not None:
            self.counts.clear()
            self.counts.update(self.usage.numeric_totals())

    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
        """失败前供应商已报告的实际用量仍保留，未报告部分保持未知。"""
        response = kwargs.get("response")
        if response is not None:
            self.on_llm_end(response, run_id=run_id)


def model_usage_config() -> dict[str, object]:
    """直接模型调用显式绑定当前 Run；独立命令没有可继承的旧轮用量。"""
    usage = current_run_usage.get()
    return {"callbacks": [UsageCallback(usage)] if usage is not None else []}
