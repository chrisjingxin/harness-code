"""ACP 斜杠命令：命令表快照、`available_commands` 映射与 `/名称 参数` 识别。

【这是做什么的？】
把 Host 在 `HostSnapshot.agent_commands` 里给出的命令快照翻译成两样东西：
1. `available_commands_update` 需要的 `AvailableCommand` 列表（供客户端做补全菜单）；
2. `session/prompt` 里识别 `/名称 参数`，补全 `RequestedSkill`，让 Host 渲染命令正文。

【上下游】
- 上游：`server.py` 的 `_bind_commands`（握手时建命令表）与 `prompt`（每轮识别）。
- 下游：`harness_agent.host.run_coordinator.RequestedSkill`（Host 唯一接受的命令入参形状）。

【三条硬约束】
1. **不匹配就当普通文本。** 未知名称、`//` 转义、`/skill:<id>`（S2 不做）、没有 `/`
   一律返回 `None`，绝不猜。猜错会让用户输入的正文被当成命令吞掉。
2. **`raw_invocation` 必须逐字等于发给 Host 的 message。** Host 会严格比较
   （`agent_host.py` 的 `COMMAND_INVOCATION_RAW_MISMATCH`），所以这里传整条 text，
   不做 strip、不改大小写。
3. **解析规则与 Host 逐字一致。** Host 的解析函数是私有的、ACP 侧只依赖
   `HostServicePort` 不能 import，所以这里复制那三行，并用漂移测试锁定两边相等。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final

from acp.schema import AvailableCommand, AvailableCommandInput

from harness_agent.host.run_coordinator import RequestedSkill

_SLASH = re.compile(r"/([^\s/]+)([\s\S]*)")
"""与 `agent_host._parse_raw_command_invocation` 同一条正则。"""


@dataclass(frozen=True, slots=True)
class CommandSpec:
    """一条可被用户直接调用的斜杠命令（来自 Skill/Plugin catalog）。"""

    skill_id: str
    name: str
    description: str
    argument_hint: str | None = None


@dataclass(frozen=True, slots=True)
class CommandIndex:
    """一次连接级的命令表：保持 Host 给的顺序，按名称大小写不敏感查找。"""

    commands: tuple[CommandSpec, ...] = ()
    by_name: Mapping[str, CommandSpec] = field(
        default_factory=lambda: MappingProxyType({})
    )

    @classmethod
    def from_snapshot(cls, agent_commands: Sequence[Mapping[str, object]]) -> CommandIndex:
        """从 `HostSnapshot.agent_commands` 建表；畸形条目直接跳过（不猜字段）。"""
        commands: list[CommandSpec] = []
        by_name: dict[str, CommandSpec] = {}
        for entry in agent_commands:
            skill_id = entry.get("id")
            name = entry.get("name")
            if not isinstance(skill_id, str) or not skill_id:
                continue
            if not isinstance(name, str) or not name:
                continue
            description = entry.get("description")
            hint = entry.get("argument_hint")
            spec = CommandSpec(
                skill_id=skill_id,
                name=name,
                description=description if isinstance(description, str) else "",
                argument_hint=hint if isinstance(hint, str) and hint else None,
            )
            commands.append(spec)
            by_name.setdefault(name.casefold(), spec)
        return cls(commands=tuple(commands), by_name=MappingProxyType(by_name))

    def available_commands(self) -> list[AvailableCommand]:
        """给客户端的命令列表；只有带 `argument_hint` 的命令才声明输入提示。"""
        return [
            AvailableCommand(
                name=spec.name,
                description=spec.description,
                input=(
                    AvailableCommandInput.model_validate({"hint": spec.argument_hint})
                    if spec.argument_hint
                    else None
                ),
            )
            for spec in self.commands
        ]

    def match(self, text: str) -> RequestedSkill | None:
        """识别 `/名称 参数`；命中返回 `RequestedSkill`，否则 `None`（当普通文本）。"""
        parsed = parse_slash(text)
        if parsed is None:
            return None
        name, args = parsed
        spec = self.by_name.get(name.casefold())
        if spec is None:
            return None
        return RequestedSkill(
            skill_id=spec.skill_id,
            args=args,
            raw_invocation=text,
            command_name=spec.name,
        )


def parse_slash(text: str) -> tuple[str, str] | None:
    """拆出（名称, 规范化参数）；`//` 转义、没有名称或没有 `/` 返回 `None`。"""
    value = text.lstrip()
    if not value.startswith("/") or value.startswith("//"):
        return None
    match = _SLASH.fullmatch(value)
    if match is None:
        return None
    return match.group(1), match.group(2).strip()


EMPTY_COMMAND_INDEX: Final = CommandIndex()
"""没有命令时的默认表（握手失败或 catalog 为空）。"""

__all__ = [
    "EMPTY_COMMAND_INDEX",
    "CommandIndex",
    "CommandSpec",
    "parse_slash",
]
