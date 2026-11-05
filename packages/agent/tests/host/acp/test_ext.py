"""ACP 扩展命名空间的常量契约。

【为什么单独测这两个常量】
扩展字段名会同时出现在 initialize 能力声明、`_meta` 键和 JSON-RPC 方法前缀里。
前缀必须严格由键推导，只改其中一个就会让客户端和 Agent 说不同的语言，
所以这里锁死两者的推导关系，而不是各测一遍字面值。
"""

from __future__ import annotations

from harness_agent.host.acp.ext import EXT_KEY, EXT_METHOD_PREFIX


def test_ext_key_is_stable_wire_name() -> None:
    """键名是对外协议的一部分，改动等于破坏兼容。"""
    assert EXT_KEY == "harnessCode"


def test_method_prefix_is_derived_from_key() -> None:
    """方法前缀必须等于 `_<键>/`，防止只改一个导致扩展调用错位。"""
    expected = f"_{EXT_KEY}/"
    assert expected == EXT_METHOD_PREFIX
