"""Fusion 角色用量和配置价格估算；不推测缺失值或真实账单。

Host 记录调用 → 角色累计 → 配置价格估算 → 协议安全投影。
假设差额仅比较 Sidekick 已观测 token，不等同全 Lead 实验。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Mapping, Sequence


def aggregate_usage(
    previous: Mapping[str, object] | None,
    profile_id: str,
    calls: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """累加合法 token，缺失和不合理缓存计数令对应完整性失效。"""
    result = dict(
        previous
        or {
            "profile_id": profile_id,
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cached_input_tokens": 0,
            "complete": True,
            "cache_complete": True,
        }
    )
    if result["profile_id"] != profile_id:
        raise ValueError("FUSION_USAGE_PROFILE_CONFLICT")
    for call in calls:
        result["calls"] += 1
        for key in ("input_tokens", "output_tokens", "cached_input_tokens"):
            value = call.get(key)
            valid = (
                isinstance(value, int)
                and not isinstance(value, bool)
                and 0 <= value <= 2**53 - 1
            )
            if valid:
                result[key] += value
            if not valid or (
                key == "cached_input_tokens"
                and isinstance(call.get("input_tokens"), int)
                and value > call["input_tokens"]
            ):
                result[
                    "cache_complete" if key == "cached_input_tokens" else "complete"
                ] = False
    result["cache_hit_rate"] = (
        result["cached_input_tokens"] / result["input_tokens"]
        if result["complete"] and result["cache_complete"] and result["input_tokens"]
        else None
    )
    return result


def price_usage(
    usage: Mapping[str, object] | None, pricing: Mapping[str, object] | None
) -> str | None:
    """完整用量和必要单价齐备才计算，缓存未提供单价不当免费。"""
    if (
        not usage
        or not pricing
        or not usage["calls"]
        or not usage["complete"]
        or not usage["cache_complete"]
    ):
        return None
    cached = usage["cached_input_tokens"]
    if cached and pricing.get("cached_input_per_million") is None:
        return None
    cost = (
        (Decimal(usage["input_tokens"]) - Decimal(cached))
        * Decimal(pricing["input_per_million"])
        + Decimal(usage["output_tokens"]) * Decimal(pricing["output_per_million"])
        + Decimal(cached) * Decimal(pricing.get("cached_input_per_million") or "0")
    ) / Decimal(1000000)
    return format(cost.normalize(), "f")


def usage_record(
    roles: Mapping[str, object], prices: Mapping[str, object]
) -> dict[str, object]:
    """投影金额和假设差额，币种不同不比较，也不猜汇率。"""
    result = {
        "lead": roles.get("lead"),
        "sidekick": roles.get("sidekick"),
        "estimate": None,
    }
    lead_price, side_price = prices.get("lead"), prices.get("sidekick")
    if (
        not lead_price
        or not side_price
        or lead_price["currency"] != side_price["currency"]
    ):
        return result
    lead = price_usage(roles.get("lead"), lead_price)
    side = price_usage(roles.get("sidekick"), side_price)
    hypothetical = price_usage(roles.get("sidekick"), lead_price)
    result["estimate"] = {
        "currency": lead_price["currency"],
        "lead_cost": lead,
        "sidekick_cost": side,
        "sidekick_at_lead_price": hypothetical,
        "estimated_saving": format(Decimal(hypothetical) - Decimal(side), "f")
        if hypothetical is not None and side is not None
        else None,
    }
    return result
