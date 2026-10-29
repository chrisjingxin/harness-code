"""解析可选的模型单价；只用于用量估算，不传给模型服务。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Mapping


@dataclass(frozen=True, slots=True)
class ModelPricing:
    """单位为每百万 token；缓存单价未填写时保持未知。"""

    currency: str
    input_per_million: Decimal
    output_per_million: Decimal
    cached_input_per_million: Decimal | None = None

    def to_record(self) -> dict[str, str | None]:
        """用十进制字符串输出，避免金额经过浮点取整。"""
        return {
            "currency": self.currency,
            "input_per_million": str(self.input_per_million),
            "output_per_million": str(self.output_per_million),
            "cached_input_per_million": None
            if self.cached_input_per_million is None
            else str(self.cached_input_per_million),
        }


def parse_model_pricing(value: object) -> ModelPricing | None:
    """拒绝未知字段、负数、布尔及非有限值，错误不回显配置内容。"""
    if value is None:
        return None
    fields = {
        "currency",
        "input_per_million",
        "output_per_million",
        "cached_input_per_million",
    }
    if not isinstance(value, Mapping) or set(value) - fields:
        raise ValueError(
            "models.profiles.<id>.pricing must be a pricing table with supported fields"
        )
    currency = value.get("currency")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError(
            "models.profiles.<id>.pricing.currency must use three uppercase letters"
        )

    def rate(key: str, *, optional: bool = False) -> Decimal | None:
        raw = value.get(key)
        if raw is None and optional:
            return None
        try:
            if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
                raise ValueError()
            number = Decimal(str(raw))
            if not number.is_finite() or not Decimal(0) <= number <= Decimal("1e12"):
                raise ValueError()
            return number.normalize() if number else Decimal(0)
        except (ValueError, InvalidOperation) as exc:
            raise ValueError(
                f"models.profiles.<id>.pricing.{key} requires a finite non-negative rate up to 1e12"
            ) from exc

    return ModelPricing(
        currency,
        rate("input_per_million"),
        rate("output_per_million"),
        rate("cached_input_per_million", optional=True),
    )
