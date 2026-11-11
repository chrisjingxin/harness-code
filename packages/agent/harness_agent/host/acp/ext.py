"""ACP 扩展协商：声明 `_meta.harnessCode` 的能力、版本与出站出口。

【这是做什么的？】
ACP 允许 Agent 在 `_meta` 里放自有字段，但只允许发给**声明过**的客户端。本模块负责：
1. 解析客户端在 `initialize.clientCapabilities._meta.harnessCode` 里的声明；
2. 在握手响应里回报自己支持的能力；
3. 提供「运行摘要」的 `_meta` 形状。

【上下游】
- 上游：`server.py` 的 `initialize`（协商一次）与 `_prompt_response`（运行摘要）。
- 下游：`permissions.py` 的 `approval_meta`（审批细节），它自己也只在协商开启时被调用。
- 客户端侧（S3 的适配层）按同一套键名读。

【协商规则（输入 → 判断 → 输出）】
    clientCapabilities._meta.harnessCode
      ├─ 不是对象 / version 缺失 / version 不是整数 / version ≠ 1
      ├─ capabilities 缺失 / 不是列表 / 有非字符串元素
      └─ 以上任一 → 按「没声明」处理：整条连接不出现任何 harnessCode 字节
    其余 → 已声明；approval / runSummary 按名字开启，未知能力名忽略（向后兼容）

【出站出口】
`agent_capabilities_meta`、`approval_meta`、`run_meta`、`session_summary_meta`、
`parent_meta`、`available_command_meta`、`command_meta`、`command_chunk_meta`。
所有出站 `_meta.harnessCode`
都必须从这里产出，调用点先看 `Negotiation`，这样「没声明就一个字节都不带」只有一处
需要维护（测试用递归扫描锁定）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

EXT_KEY: Final = "harnessCode"
"""扩展字段键名；出现在 `_meta` 与能力声明里，属于对外线上契约。"""

EXT_METHOD_PREFIX: Final = f"_{EXT_KEY}/"
"""自定义 JSON-RPC 方法前缀；ACP 约定扩展方法以 `_` 开头。"""

EXT_VERSION: Final = 1
"""本实现的扩展版本；客户端声明其它版本按「没声明」处理。"""

CAP_APPROVAL: Final = "approval"
"""能力名：权限请求的 `toolCall._meta.harnessCode.approval`。"""

CAP_RUN_SUMMARY: Final = "runSummary"
"""能力名：`session/prompt` 响应的 `_meta.harnessCode.run`。"""

CAP_SESSION_SUMMARY: Final = "sessionSummary"

CAP_SUBAGENT: Final = "subagent"
"""能力名：`SessionInfo._meta.harnessCode.summary`（列表与回放都带）。"""

CAP_GOAL: Final = "goal"
"""能力名：Goal 确认之后的计划条目。`/goal` 命令是否出现在菜单里看的是表单能力，不是这个名字。"""

CAP_COMMANDS: Final = "commands"
"""能力名：命令来源与内置命令结果上的 `_meta.harnessCode.command`。"""

KNOWN_CAPABILITIES: Final = frozenset({CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL, CAP_COMMANDS})
"""认识的能力名；其余名字忽略，方便以后加能力而不破坏老客户端。"""

_CAPABILITY_ORDER: Final[tuple[str, ...]] = (CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL, CAP_COMMANDS)
"""回报顺序固定，客户端可以按顺序展示。"""


@dataclass(frozen=True, slots=True)
class Negotiation:
    """一次握手的协商结果；`declared=False` 时整条连接不带任何扩展字段。"""

    declared: bool = False
    approval: bool = False
    run_summary: bool = False
    session_summary: bool = False
    subagent: bool = False
    goal: bool = False
    commands: bool = False

    @property
    def capabilities(self) -> tuple[str, ...]:
        """本次开启的能力，按固定顺序回报。"""
        enabled = []
        if self.approval:
            enabled.append(CAP_APPROVAL)
        if self.run_summary:
            enabled.append(CAP_RUN_SUMMARY)
        if self.session_summary:
            enabled.append(CAP_SESSION_SUMMARY)
        if self.subagent:
            enabled.append(CAP_SUBAGENT)
        if self.goal:
            enabled.append(CAP_GOAL)
        if self.commands:
            enabled.append(CAP_COMMANDS)
        return tuple(enabled)


def negotiate(client_capabilities: object | None) -> Negotiation:
    """从客户端能力里解析扩展声明；任何形状问题都按「没声明」处理，绝不抛异常。

    输入：SDK 解析出的 `ClientCapabilities`（读 `field_meta`），或等价的 dict
          （测试与将来的传输层适配器用）。
    输出：`Negotiation`；未声明时所有能力都是 False。
    """
    meta = _field_meta(client_capabilities)
    declaration = meta.get(EXT_KEY) if isinstance(meta, Mapping) else None
    if not isinstance(declaration, Mapping):
        return Negotiation()
    version = declaration.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version != EXT_VERSION:
        return Negotiation()
    capabilities = declaration.get("capabilities")
    if not isinstance(capabilities, Sequence) or isinstance(capabilities, (str, bytes)):
        return Negotiation()
    if any(not isinstance(name, str) for name in capabilities):
        return Negotiation()
    enabled = {name for name in capabilities if name in KNOWN_CAPABILITIES}
    return Negotiation(
        declared=True,
        approval=CAP_APPROVAL in enabled,
        run_summary=CAP_RUN_SUMMARY in enabled,
        session_summary=CAP_SESSION_SUMMARY in enabled,
        subagent=CAP_SUBAGENT in enabled,
        goal=CAP_GOAL in enabled,
        commands=CAP_COMMANDS in enabled,
    )


def agent_capabilities_meta(neg: Negotiation) -> dict[str, object] | None:
    """握手响应里的能力回报；没声明时返回 `None`（连键都不出现）。"""
    if not neg.declared:
        return None
    return {EXT_KEY: {"version": EXT_VERSION, "capabilities": list(neg.capabilities)}}


def session_summary_meta(summary: Mapping[str, object]) -> dict[str, object]:
    """`SessionInfo._meta.harnessCode.summary`（§12.2）；键名与 v3 摘要同义。"""
    return {EXT_KEY: {"summary": dict(summary)}}


def parent_meta(
    *, tool_call_id: str, agent_id: str | None, execution_id: str
) -> dict[str, object]:
    """子代理工具卡的 `_meta.harnessCode.parent`：挂回父 task 卡（§7.3）。

    agentId 为 None 时省略该键；只在协商了 subagent 能力的连接上使用。
    """
    parent: dict[str, object] = {"toolCallId": tool_call_id, "executionId": execution_id}
    if agent_id:
        parent["agentId"] = agent_id
    return {EXT_KEY: {"parent": parent}}


def available_command_meta(
    *,
    command_id: str,
    source: str,
    requested_skill_id: str | None = None,
    plugin_id: str | None = None,
) -> dict[str, object]:
    """`AvailableCommand._meta.harnessCode`：命令从哪来的。空的可选字段不写。"""
    body: dict[str, object] = {"id": command_id, "source": source}
    if requested_skill_id:
        body["requestedSkillId"] = requested_skill_id
    if plugin_id:
        body["pluginId"] = plugin_id
    return {EXT_KEY: body}


def command_meta(command: Mapping[str, object]) -> dict[str, object]:
    """内置命令结果上的 `_meta.harnessCode.command`。"""
    return {EXT_KEY: {"command": dict(command)}}


def command_chunk_meta(
    command: Mapping[str, object] | None = None,
    *,
    ephemeral: bool = False,
) -> dict[str, object]:
    """消息块上的扩展。`/btw` 的块带 `ephemeral: true`，刷新后客户端不把它当历史。"""
    body: dict[str, object] = {}
    if ephemeral:
        body["ephemeral"] = True
    if command:
        body["command"] = dict(command)
    return {EXT_KEY: body}


def merge_harness_meta(
    base: Mapping[str, object] | None,
    extra: Mapping[str, object] | None,
) -> dict[str, object] | None:
    """把两份 `_meta` 的 `harnessCode` 并到一起。任一边缺失就用另一边。"""
    if not extra:
        return dict(base) if base else None
    if not base:
        return dict(extra)
    merged: dict[str, object] = dict(base)
    left = merged.get(EXT_KEY)
    right = extra.get(EXT_KEY)
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        body = dict(left)
        body.update(dict(right))
        merged[EXT_KEY] = body
        return merged
    merged.update(dict(extra))
    return merged


def run_meta(summary: Mapping[str, object]) -> dict[str, object]:
    """`session/prompt` 响应的 `_meta.harnessCode.run`。

    键名沿用 v3 `run.completed` 的原样形状（`usage` / `duration_ms` / `context`），
    不在这里改名——它是 v3 payload 的子集原样转发。
    """
    return {EXT_KEY: {"run": dict(summary)}}


def _field_meta(client_capabilities: object | None) -> Mapping[str, object] | None:
    """取客户端能力里的 `_meta`：支持模型对象与 dict 两种形状。"""
    if isinstance(client_capabilities, Mapping):
        meta = client_capabilities.get("_meta")
        if meta is None:
            meta = client_capabilities.get("field_meta")
        return cast(Mapping[str, object] | None, meta) if isinstance(meta, Mapping) else None
    meta = getattr(client_capabilities, "field_meta", None)
    return cast(Mapping[str, object] | None, meta) if isinstance(meta, Mapping) else None


__all__ = [
    "CAP_APPROVAL",
    "CAP_COMMANDS",
    "CAP_GOAL",
    "CAP_RUN_SUMMARY",
    "CAP_SESSION_SUMMARY",
    "CAP_SUBAGENT",
    "EXT_KEY",
    "EXT_METHOD_PREFIX",
    "EXT_VERSION",
    "KNOWN_CAPABILITIES",
    "Negotiation",
    "agent_capabilities_meta",
    "available_command_meta",
    "command_chunk_meta",
    "command_meta",
    "merge_harness_meta",
    "negotiate",
    "parent_meta",
    "run_meta",
    "session_summary_meta",
]
