"""审批与目录信任 ⇄ ACP `session/request_permission`。

【这是做什么的？】
把 Host 的两种交互请求（`interaction.approval`、`interaction.directory_trust`）翻译成
ACP 标准的权限请求，并把客户端的回答翻回 v3 的 `decision`：

    Host 交互帧 → 解析 → 纯函数构造请求（选项/文本兜底/_meta）
                → 权限任务在后台发请求、等客户端
                → 客户端回答 → decision → host.resolve_interaction

【上下游】
- 上游：`server.py` 的发送泵（`_pump_interaction`）与关闭/取消路径。
- 下游：官方 SDK 客户端对象的 `request_permission`、`HostServicePort` 的
  `resolve_interaction` / `fail_interaction`。

【三条硬约束】
1. **审批不加超时。** 用户可能几分钟才点一下；这里绝不能出现任何计时器。
   断开由 SDK 的 `ConnectionError` 驱动，取消由 `cancel_session` / `cancel_run` 驱动。
2. **任何异常一律降级为拒绝并 `resolve_interaction`。** 否则 Run 会永远挂在
   `pending_interactions` 上，客户端也永远等不到 `session/prompt` 的响应。
3. **没声明扩展的客户端一个 `harnessCode` 字节都收不到**：`approval_meta` 只在
   调用方确认协商开启后才被调用。

【一次批准的顺序】
```text
_pump_interaction ──▶ prepare_approval（建卡/补卡）──▶ _send(updates)
                  └─▶ broker.start(job) ──▶ create_task(request_permission)
                                              … 用户点击 …
                      resolve_interaction(decision) ──▶ on_done(approval_done)
```
`resolve_interaction` 与 `on_done` 之间没有 await，所以 Host 随后产生的任何帧
（`interaction.resolved`、下一个审批、`tool.completed`）一定排在 `approval_done` 之后，
批准后的 `in_progress` 不会盖掉后到的 `completed`。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

from acp.helpers import text_block, tool_content
from acp.schema import PermissionOption, ToolCallUpdate

from harness_agent.host.acp.ext import EXT_KEY
from harness_agent.host.acp.tool_display import sanitize_block, sanitize_line
from harness_agent.host.acp.translate import UNSET, ApprovalTarget, bounded_raw_input
from harness_agent.host.connection import ProtocolConnection, RpcError

InteractionKind = Literal["approval", "directory_trust"]
"""本模块处理的两种交互类型。"""

_METHOD_KINDS: Final[Mapping[str, InteractionKind]] = {
    "interaction.approval": "approval",
    "interaction.directory_trust": "directory_trust",
}

_APPROVAL_OPTIONS: Final[tuple[tuple[str, str, str], ...]] = (
    ("approve_once", "allow_once", "允许一次"),
    ("approve_thread", "allow_always", "本会话内总是允许"),
    ("approve_project", "allow_always", "本项目内总是允许"),
    ("reject", "reject_once", "拒绝"),
)
"""v3 决策 → ACP 权限选项。`reject_with_feedback` 不发：ACP 响应没有文字字段（GAP-05）。"""

_TRUST_OPTIONS: Final[tuple[tuple[str, str, str], ...]] = (
    ("allow_session", "allow_always", "本会话内允许访问该目录"),
    ("deny", "reject_once", "拒绝"),
)
"""目录信任只有本会话信任与拒绝两项。"""

_OPERATION_LABELS: Final[Mapping[str, str]] = {
    "write": "写入",
    "edit": "编辑",
    "delete": "删除",
}

DECISION_CANCELLED: Final = -32004
"""本地取消时给 Host 的错误码；Run 若已取消，这个调用什么都不做。"""


@dataclass(frozen=True, slots=True)
class InteractionFrame:
    """从 Host 的 `interaction.*` 帧解析出的、与传输无关的数据。"""

    request_id: str
    kind: InteractionKind
    session_id: str
    run_id: str
    payload: Mapping[str, object]
    is_child: bool
    agent_id: str | None


def action_tool(payload: Mapping[str, object]) -> tuple[str, dict[str, object] | None, str | None]:
    """从 `requests.action_requests[0]` 取工具名、参数与 provider `tool_call_id`。

    Host 每次只放一个 action；被 `_bounded_json` 截断时 `requests` 不是
    `action_requests` 形状，此时全返回空值（客户端降级为模糊匹配）。
    """
    requests = payload.get("requests")
    if not isinstance(requests, Mapping):
        return "", None, None
    actions = requests.get("action_requests")
    if not isinstance(actions, list) or not actions:
        return "", None, None
    action = actions[0]
    if not isinstance(action, Mapping):
        return "", None, None
    name = action.get("name")
    raw_args = action.get("args")
    tool_call_id = action.get("tool_call_id")
    return (
        name if isinstance(name, str) else "",
        dict(raw_args) if isinstance(raw_args, Mapping) else None,
        tool_call_id if isinstance(tool_call_id, str) and tool_call_id else None,
    )


def parse_interaction(frame: Mapping[str, object]) -> InteractionFrame | None:
    """解析一帧交互请求；任何形状不合法都返回 None（调用方 fail-closed）。"""
    method = frame.get("method")
    kind = _METHOD_KINDS.get(method) if isinstance(method, str) else None
    request_id = frame.get("id")
    params = frame.get("params")
    if kind is None or not isinstance(request_id, str) or not request_id:
        return None
    if not isinstance(params, Mapping):
        return None
    session_id = params.get("thread_id")
    run_id = params.get("run_id")
    payload = params.get("payload")
    if not isinstance(session_id, str) or not session_id:
        return None
    if not isinstance(run_id, str) or not run_id:
        return None
    if not isinstance(payload, Mapping):
        return None
    agent_id = params.get("agent_id")
    return InteractionFrame(
        request_id=request_id,
        kind=kind,
        session_id=session_id,
        run_id=run_id,
        payload=payload,
        is_child=params.get("parent_execution_id") is not None,
        agent_id=agent_id if isinstance(agent_id, str) and agent_id else None,
    )


@dataclass(frozen=True, slots=True)
class PermissionJob:
    """一次待回答的权限请求；`card_id` 就是请求里的 `toolCallId`。"""

    frame: InteractionFrame
    card_id: str
    tool_call: ToolCallUpdate
    options: list[PermissionOption]
    allow_ids: frozenset[str]
    reject_decision: str


@dataclass(frozen=True, slots=True)
class PermissionDone:
    """一次权限请求的收尾结果；`delivered` 是 `resolve_interaction` 的三态或 failed。"""

    job: PermissionJob
    decision: str
    delivered: Literal["resolved", "expired", "invalid", "failed"]


def approval_options(decisions: Sequence[str]) -> list[PermissionOption]:
    """按固定顺序给出选项；没有拒绝项时补一个（用户永远能说不）。"""
    options = _options(_APPROVAL_OPTIONS, decisions)
    if options and "reject" not in {option.option_id for option in options}:
        options.append(_option(("reject", "reject_once", "拒绝")))
    return options


def trust_options(decisions: Sequence[str]) -> list[PermissionOption]:
    """目录信任的两个选项；同样保证至少有一个拒绝项。"""
    options = _options(_TRUST_OPTIONS, decisions)
    if options and "deny" not in {option.option_id for option in options}:
        options.append(_option(("deny", "reject_once", "拒绝")))
    return options


def build_approval_job(
    frame: InteractionFrame,
    target: ApprovalTarget,
    *,
    ext_approval: bool,
) -> PermissionJob | None:
    """构造审批权限请求；选项为空时返回 None（调用方 fail-closed）。"""
    options = approval_options(_decisions(frame.payload))
    if not options:
        return None
    description = frame.payload.get("description")
    text = sanitize_block(description) if isinstance(description, str) else ""
    fallback = render_diff_fallback(frame.payload.get("presentation"))
    body = f"{text}\n\n{fallback}".strip() if fallback else text.strip()
    # 最后一道门：超过 rawInput 上限就整条不发（参数可能来自任意工具）。
    raw = bounded_raw_input(target.raw_input)
    tool_call = ToolCallUpdate(
        tool_call_id=target.tool_call_id,
        title=target.title,
        kind=target.kind,
        status="pending",
        content=[tool_content(text_block(body or target.title))],
        locations=target.locations or None,
        raw_input=None if raw is UNSET else raw,
        # `_meta.harnessCode.approval` 只放在 toolCall 上：前面的卡片更新不带，
        # 同一份 diff 不重复发两遍（Web 端消费的是权限请求）。
        field_meta=approval_meta(frame, agent_id=frame.agent_id) if ext_approval else None,
    )
    return PermissionJob(
        frame=frame,
        card_id=target.tool_call_id,
        tool_call=tool_call,
        options=options,
        allow_ids=_allow_ids(options),
        reject_decision="reject",
    )


def build_trust_job(
    frame: InteractionFrame,
    target: ApprovalTarget,
    *,
    ext_approval: bool,
) -> PermissionJob | None:
    """构造目录信任权限请求；没有可用选项时返回 None。"""
    options = trust_options(_decisions(frame.payload))
    if not options:
        return None
    directory = str(frame.payload.get("directory") or "")
    tool_name = str(frame.payload.get("tool_name") or "")
    access = str(frame.payload.get("access") or "read")
    target_path = str(frame.payload.get("target_path") or "")
    action = "写入" if access == "write" else "读取"
    lines = [
        f"工具 {tool_name} 需要{action} {target_path}",
        f"待信任目录：{directory}",
    ]
    if frame.payload.get("shadows_workspace"):
        lines.append("⚠ 该目录会遮蔽工作区内的同名路径")
    tool_call = ToolCallUpdate(
        tool_call_id=target.tool_call_id,
        title=target.title,
        kind=target.kind,
        status="pending",
        content=[tool_content(text_block(sanitize_block("\n".join(lines))))],
        locations=target.locations or None,
        field_meta=approval_meta(frame) if ext_approval else None,
    )
    return PermissionJob(
        frame=frame,
        card_id=target.tool_call_id,
        tool_call=tool_call,
        options=options,
        allow_ids=_allow_ids(options),
        reject_decision="deny",
    )


def decision_from_response(job: PermissionJob, response: object) -> str:
    """把客户端响应翻成 v3 决策；只有「选中本次发出去的选项」才算数。"""
    outcome = getattr(response, "outcome", None)
    if outcome is None or getattr(outcome, "outcome", None) != "selected":
        return job.reject_decision
    option_id = getattr(outcome, "option_id", None)
    if isinstance(option_id, str) and option_id in {option.option_id for option in job.options}:
        return option_id
    return job.reject_decision


def render_diff_fallback(presentation: object) -> str | None:
    """用 v3 已有的 `file_diff` 展示数据渲染文本兜底（不重新计算 diff）。"""
    if not isinstance(presentation, Mapping) or presentation.get("kind") != "file_diff":
        return None
    diff = presentation.get("unified_diff")
    path = presentation.get("path")
    if not isinstance(diff, str) or not isinstance(path, str) or not diff:
        return None
    safe_diff = sanitize_block(diff)
    operation = _OPERATION_LABELS.get(str(presentation.get("operation") or ""), "修改")
    header = (
        f"文件变更：{operation} {sanitize_line(path)}"
        f"（+{_count(presentation.get('added_lines'))} −{_count(presentation.get('removed_lines'))}）"
    )
    if presentation.get("truncated"):
        header += "（diff 已截断）"
    fence = "`" * max(3, _longest_run(safe_diff) + 1)
    return f"{header}\n{fence}diff\n{safe_diff}\n{fence}"


def approval_meta(frame: InteractionFrame, *, agent_id: str | None = None) -> dict[str, object]:
    """扩展协商开启时才产出的 `_meta`：只从这一处出口生成 `harnessCode.approval`。"""
    if frame.kind == "approval":
        body: dict[str, object] = {"type": "approval", "requestId": frame.request_id}
        description = frame.payload.get("description")
        if isinstance(description, str) and description:
            body["description"] = description
        presentation = frame.payload.get("presentation")
        if isinstance(presentation, Mapping):
            body["presentation"] = dict(presentation)
    else:
        body = {
            "type": "directory_trust",
            "requestId": frame.request_id,
            "directory": str(frame.payload.get("directory") or ""),
            "targetPath": str(frame.payload.get("target_path") or ""),
            "toolName": str(frame.payload.get("tool_name") or ""),
            "access": str(frame.payload.get("access") or "read"),
            "shadowsWorkspace": bool(frame.payload.get("shadows_workspace")),
        }
    if agent_id:
        body["agentId"] = agent_id
    return {EXT_KEY: {"approval": body}}


class PermissionBroker:
    """把权限请求跑成后台任务：绝不 await 客户端，也绝不加超时。"""

    def __init__(
        self,
        *,
        host: Any,
        connection: ProtocolConnection,
        client: Any,
        log: Any,
        on_done: Callable[[PermissionDone], None],
    ) -> None:
        """绑定 Host 服务面、连接、SDK 客户端与结果回调；状态只有任务表。"""
        self._host = host
        self._connection = connection
        self._client = client
        self._log = log
        self._on_done = on_done
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._jobs: dict[str, PermissionJob] = {}

    @property
    def pending_count(self) -> int:
        """挂起中的权限请求数量（测试与诊断用）。"""
        return len(self._tasks)

    def start(self, job: PermissionJob) -> None:
        """起一个权限任务后立即返回，让发送泵继续消费队列。"""
        task = asyncio.create_task(self._run(job), name=f"harness-acp-permission-{job.frame.request_id}")
        self._tasks[job.frame.request_id] = task
        self._jobs[job.frame.request_id] = job
        task.add_done_callback(lambda _task, key=job.frame.request_id: self._forget(key))

    def cancel_session(self, session_id: str) -> None:
        """会话被取消时本地取消它的挂起请求。"""
        self._cancel(lambda job: job.frame.session_id == session_id)

    def cancel_run(self, run_id: str) -> None:
        """Run 结束（正常或中途失败）后清理它的挂起请求。"""
        self._cancel(lambda job: job.frame.run_id == run_id)

    async def aclose(self) -> None:
        """取消并等待全部权限任务；可重复调用。"""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._jobs.clear()

    async def _run(self, job: PermissionJob) -> None:
        """等客户端回答并回填 Host；任何异常都降级为拒绝，绝不让 Run 挂死。"""
        decision = job.reject_decision
        try:
            response = await self._client.request_permission(
                job.frame.session_id,
                job.tool_call,
                job.options,
            )
            decision = decision_from_response(job, response)
        except asyncio.CancelledError:
            # 本地取消（session/cancel、Run 结束、aclose）：让 Host 立刻 fail-closed。
            # Run 若已被取消，pending future 已不在，这里返回 False，什么都不发生。
            self._host.fail_interaction(
                self._connection,
                job.frame.request_id,
                RpcError(DECISION_CANCELLED, "PERMISSION_CANCELLED"),
            )
            raise
        except Exception as exc:  # noqa: BLE001 - 客户端异常必须降级为拒绝，否则 Run 永远挂着
            self._log.warn(
                "ipc.request.failed",
                {
                    "side": "server",
                    "method": "session/request_permission",
                    "failure_stage": "permission_request",
                    "error_type": type(exc).__name__,
                    "summary_code": "PERMISSION_REQUEST_FAILED",
                },
            )
            decision = job.reject_decision
        delivered = self._host.resolve_interaction(
            self._connection, job.frame.request_id, {"decision": decision}
        )
        self._on_done(
            PermissionDone(
                job=job,
                decision=decision,
                delivered=delivered if delivered in {"resolved", "expired", "invalid"} else "failed",
            )
        )

    def _cancel(self, predicate: Callable[[PermissionJob], bool]) -> None:
        """按条件取消任务；已完成的条目自然不在表里。"""
        for key, job in list(self._jobs.items()):
            if not predicate(job):
                continue
            task = self._tasks.get(key)
            if task is not None:
                task.cancel()

    def _forget(self, request_id: str) -> None:
        """任务结束时清掉登记项（不给 Host 留悬挂引用）。"""
        self._tasks.pop(request_id, None)
        self._jobs.pop(request_id, None)


def _options(
    table: Sequence[tuple[str, str, str]], decisions: Sequence[str]
) -> list[PermissionOption]:
    """按表过滤并保持固定顺序。"""
    wanted = set(decisions)
    return [_option(entry) for entry in table if entry[0] in wanted]


def _option(entry: tuple[str, str, str]) -> PermissionOption:
    """把表行转成 SDK 的权限选项。"""
    option_id, kind, name = entry
    return PermissionOption(option_id=option_id, name=name, kind=kind)  # type: ignore[arg-type]


def _allow_ids(options: Sequence[PermissionOption]) -> frozenset[str]:
    """允许类选项的 id 集合。"""
    return frozenset(option.option_id for option in options if option.kind.startswith("allow"))


def _decisions(payload: Mapping[str, object]) -> list[str]:
    """取 payload 里的决策列表；畸形值按空处理。"""
    raw = payload.get("decisions")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    return [item for item in raw if isinstance(item, str)]


def _count(value: object) -> int:
    """把行数统计值转成整数；非整数按 0。"""
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _longest_run(text: str) -> int:
    """最长连续反引号数；代码围栏要比它更长才不会被内容提前结束。"""
    longest = current = 0
    for char in text:
        if char == "`":
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


__all__ = [
    "InteractionFrame",
    "PermissionBroker",
    "PermissionDone",
    "PermissionJob",
    "action_tool",
    "approval_meta",
    "approval_options",
    "build_approval_job",
    "build_trust_job",
    "decision_from_response",
    "parse_interaction",
    "render_diff_fallback",
    "trust_options",
]
