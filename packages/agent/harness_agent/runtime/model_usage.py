"""保留每次模型调用实际报告的计数，避免把缺失统计当成零。

StreamSession 记录分片 → 同次调用按最大累计值合并 → Managed 按 attempt 截取。
不读取提示词、不改变运行控制和现有 Run usage 口径。
"""

from __future__ import annotations

from typing import Mapping


def usage_fields(usage: Mapping[str, object], chunk: object = None) -> dict[str, int]:
    """只接受非负整数；缓存未知与明确报告零分别保留。"""
    result: dict[str, int] = {}

    def take(key: str, *candidates: object) -> None:
        for value in candidates:
            if (
                isinstance(value, int)
                and not isinstance(value, bool)
                and 0 <= value <= 2**53 - 1
            ):
                result[key] = value
                return

    take("input_tokens", usage.get("input_tokens"), usage.get("prompt_tokens"))
    take("output_tokens", usage.get("output_tokens"), usage.get("completion_tokens"))
    cache = []
    for source in (usage, getattr(chunk, "response_metadata", None)):
        if not isinstance(source, Mapping):
            continue
        if source is not usage:
            source = source.get("token_usage") or source.get("usage") or {}
        if not isinstance(source, Mapping):
            continue
        cache.append(source.get("cached_tokens"))
        for name, aliases in (
            ("input_token_details", ("cache_read", "cached_tokens")),
            ("prompt_tokens_details", ("cached_tokens",)),
        ):
            details = source.get(name)
            if isinstance(details, Mapping):
                cache.extend(details.get(alias) for alias in aliases)
    take("cached_input_tokens", *cache)
    return result


def observe_usage(
    session: object, usage: Mapping[str, object], chunk: object = None
) -> None:
    """更新当前模型调用的已知计数，不用后来的不完整分片覆盖已知值。"""
    calls = session.usage_observations
    if not calls:
        calls.append({})
    values = usage_fields(usage, chunk)
    for key, value in values.items():
        calls[-1][key] = max(calls[-1].get(key, 0), value)


def observed_calls(session: object, cursor: int) -> list[dict[str, int]]:
    """一次图调用可能含多个模型回合，逐个返回而非只取最后一回合。"""
    return [dict(value) for value in session.usage_observations[cursor:]]
