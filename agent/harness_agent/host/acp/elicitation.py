"""提问、计划确认、Goal 确认、拒绝反馈：统一走 ACP 的 `elicitation/create`。

【这是做什么的？】
客户端声明了 `clientCapabilities.elicitation.form` 之后，这四种需要人填字的交互
不再走权限卡片。本模块只做两件事：把 Host 的 payload 收成一张表单，以及把
客户端的回答翻回 Host 认得的结果。

【上下游】
- 上游：`server.py` 的交互泵（提问 / 计划 / Goal）和 `permissions.py`（拒绝并说明原因）。
- 下游：官方 SDK 的 `create_elicitation`。取消时补发 `$/cancel_request`，因为 SDK
  自己取消等待时不会发这帧。

【取消时为什么要包一层 send_request】
SDK 在 `send_request` 里同步分配请求号，但取消异常不会发出 `$/cancel_request`。
这里在发请求的那一瞬间记下请求号，取消时先从表里摘掉，再通知客户端，再取消等待。
已经到了的回答看到取消标记就丢掉。

【同一 Run 一张表】
Host 的交互本来就是串行的。万一同一 Run 来了第二张，排队等前一张结束，不一起弹。
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from acp.schema import (
    CancelRequestNotification,
    ElicitationFormSessionMode,
    ElicitationMultiSelectPropertySchema,
    ElicitationSchema,
    ElicitationStringPropertySchema,
    EnumOption,
    TitledMultiSelectItems,
)

from harness_agent.host.connection import RpcError

SDK_VERSION = "0.12.1"
"""锁定的 `agent-client-protocol` 版本。表单协议仍是 UNSTABLE，升级 SDK 时先改测试。"""

PLAN_MARKDOWN_LIMIT = 16 * 1024
"""计划正文放进表单说明时的 UTF-8 上限。"""

FEEDBACK_MAX = 4000
"""意见和拒绝原因的字数上限。"""

GOAL_CRITERIA_MAX = 32
"""用户改写判定条件时允许的行数。"""

_CANCELLED_CODE = -32004
"""本地取消表单时交给 Host 的错误码，和权限取消用的是同一个。"""

_PLAN_DECISIONS: tuple[tuple[str, str], ...] = (
    ("approved", "批准并开始执行"),
    ("revise", "需要修改"),
    ("abandoned", "放弃"),
)
_GOAL_DECISIONS: tuple[tuple[str, str], ...] = (
    ("accepted", "接受"),
    ("edited", "修改判定条件后接受"),
    ("rejected", "拒绝"),
)
_PLAN_NOTE = "（计划正文已截断，仅显示前 16 KiB）"

Settle = Literal["resolve", "fail", "reject"]
"""resolve 回填 Host；fail 表示提问没人答；reject 表示反馈表单没有可用文本。"""


@dataclass(frozen=True, slots=True)
class QuestionBinding:
    """一张提问表单里，序号属性名回到问题 id 的一条映射。"""

    question_id: str
    property_name: str
    other_name: str | None
    options: frozenset[str]


@dataclass(frozen=True, slots=True)
class FormSpec:
    """一张待发送的表单。`questions` 只在提问时有内容。"""

    kind: Literal["question", "plan", "goal", "feedback"]
    message: str
    requested_schema: ElicitationSchema
    questions: tuple[QuestionBinding, ...] = ()
    decisions: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class FormJob:
    """一次挂在某个 Run 上的表单请求。反馈表单的 request_id 带 `:feedback` 后缀。"""

    request_id: str
    session_id: str
    run_id: str
    spec: FormSpec


@dataclass(frozen=True, slots=True)
class FormResolution:
    """表单回答翻译后的收尾。`value` 只在 resolve 时有意义。"""

    settle: Settle
    value: Mapping[str, object] | None = None


@dataclass
class _Pending:
    """一张正在等回答的表单。任务自己拿着这份对象，摘表之后仍能看见取消标记。"""

    job: FormJob
    task: asyncio.Task[object] | None = None
    wait_task: asyncio.Task[object] | None = None
    rpc_id: int | str | None = None
    cancelled: bool = False
    delivered: bool = False


def forms_enabled(client_capabilities: object) -> bool:
    """客户端给出了 elicitation.form 对象（包括空对象）才算会画表单。"""
    if client_capabilities is None:
        return False
    if isinstance(client_capabilities, Mapping):
        elicitation = client_capabilities.get("elicitation")
    else:
        elicitation = getattr(client_capabilities, "elicitation", None)
    if elicitation is None:
        return False
    if isinstance(elicitation, Mapping):
        form = elicitation.get("form")
    else:
        form = getattr(elicitation, "form", None)
    return form is not None


def question_form(payload: Mapping[str, object]) -> FormSpec | None:
    """把一组问题收成一张表单。没有选项、也不允许自由填写的问题跳过；一张都没有就返回 None。"""
    raw_questions = payload.get("questions")
    if not isinstance(raw_questions, list):
        return None
    properties: dict[str, ElicitationStringPropertySchema | ElicitationMultiSelectPropertySchema] = {}
    required: list[str] = []
    bindings: list[QuestionBinding] = []
    included = 0
    first_text = ""
    for index, raw in enumerate(raw_questions):
        if not isinstance(raw, Mapping):
            continue
        options = _options(raw.get("options"))
        allow_other = raw.get("allow_other") is True
        # 填空题没有选项，但 Host 会带上 allow_other。整题收成一段必填文本，
        # 否则这张表直接作废，模型会把「没法问」读成用户取消。
        if not options and not allow_other:
            continue
        name = f"q_{included}"
        title = _text(raw.get("header")) or _text(raw.get("question")) or "请回答"
        description = _question_description(raw.get("body"), options)
        if included == 0:
            first_text = _text(raw.get("question")) or title
        if not options:
            properties[name] = ElicitationStringPropertySchema(
                type="string",
                title=title,
                description=description,
                max_length=FEEDBACK_MAX,
            )
            required.append(name)
            bindings.append(
                QuestionBinding(
                    question_id=_text(raw.get("id")) or f"question-{index + 1}",
                    property_name=name,
                    other_name=None,
                    options=frozenset(),
                )
            )
            included += 1
            continue
        if raw.get("multi_select") is True:
            properties[name] = ElicitationMultiSelectPropertySchema(
                type="array",
                title=title,
                description=description,
                items=TitledMultiSelectItems(
                    any_of=[EnumOption(const=value, title=label) for value, label, _desc in options]
                ),
            )
        else:
            properties[name] = ElicitationStringPropertySchema(
                type="string",
                title=title,
                description=description,
                one_of=[EnumOption(const=value, title=label) for value, label, _desc in options],
            )
        required.append(name)
        other_name = None
        if raw.get("allow_other") is True:
            other_name = f"{name}_other"
            properties[other_name] = ElicitationStringPropertySchema(type="string", title="其他（可选）")
        question_id = _text(raw.get("id")) or f"question-{index + 1}"
        bindings.append(
            QuestionBinding(
                question_id=question_id,
                property_name=name,
                other_name=other_name,
                options=frozenset(value for value, _label, _desc in options),
            )
        )
        included += 1
    if not bindings:
        return None
    message = first_text if included == 1 else f"Agent 有 {included} 个问题需要你回答"
    return FormSpec(
        kind="question",
        message=message,
        requested_schema=ElicitationSchema(properties=properties, required=required),
        questions=tuple(bindings),
    )


def plan_form(payload: Mapping[str, object]) -> FormSpec | None:
    """计划确认。决策只保留 payload 里认得的那几项；一项都没有就不是一张表单。"""
    decisions = _known_decisions(payload.get("decisions"), _PLAN_DECISIONS)
    if not decisions:
        return None
    path = payload.get("plan_display_path")
    display = path.strip() if isinstance(path, str) else ""
    markdown = payload.get("plan_markdown")
    body = _truncate_plan(markdown if isinstance(markdown, str) else "")
    return FormSpec(
        kind="plan",
        message=f"请确认执行计划（{display}）\n\n{body}",
        requested_schema=_decision_schema(
            decisions,
            extra={
                "feedback": ElicitationStringPropertySchema(
                    type="string",
                    title="修改意见",
                    max_length=FEEDBACK_MAX,
                )
            },
        ),
        decisions=frozenset(item[0] for item in decisions),
    )


def goal_form(payload: Mapping[str, object]) -> FormSpec | None:
    """Goal 确认。`cancelled` 是拒绝回答的结果，不是表单上的选项。"""
    decisions = _known_decisions(payload.get("decisions"), _GOAL_DECISIONS)
    if not decisions:
        return None
    objective = payload.get("objective")
    lines = [f"确认目标：{objective.strip() if isinstance(objective, str) else ''}"]
    assumptions = [item.strip() for item in _string_list(payload.get("assumptions"))]
    if assumptions:
        lines.append(f"假设：{assumptions[0]}")
        lines.extend(assumptions[1:])
    criteria = _string_list(payload.get("criteria"))
    return FormSpec(
        kind="goal",
        message="\n".join(lines),
        requested_schema=_decision_schema(
            decisions,
            extra={
                "criteria": ElicitationStringPropertySchema(
                    type="string",
                    title="判定条件（每行一条）",
                    default="\n".join(criteria) if criteria else None,
                ),
                "feedback": ElicitationStringPropertySchema(type="string", max_length=FEEDBACK_MAX),
            },
        ),
        decisions=frozenset(item[0] for item in decisions),
    )


def feedback_form() -> FormSpec:
    """拒绝并说明原因之后的追问。文本必填。"""
    return FormSpec(
        kind="feedback",
        message="请说明拒绝原因，Agent 会据此调整",
        requested_schema=ElicitationSchema(
            properties={
                "feedback": ElicitationStringPropertySchema(type="string", max_length=FEEDBACK_MAX),
            },
            required=["feedback"],
        ),
    )


def apply_response(spec: FormSpec, response: object) -> FormResolution:
    """把客户端的 accept / decline / cancel 翻成 Host 结果。乱填按取消处理。"""
    action, content = _action_and_content(response)
    if spec.kind == "question":
        return _apply_question(spec, action, content)
    if spec.kind == "plan":
        return _apply_plan(spec, action, content)
    if spec.kind == "goal":
        return _apply_goal(spec, action, content)
    return _apply_feedback(action, content)


class ElicitationBroker:
    """把表单跑成后台任务：不加超时。断开和取消都按「用户没填完」交还。"""

    def __init__(self, *, host: object, connection: object, client: object, log: object) -> None:
        """绑定 Host、连接和 SDK 客户端。状态只有待回答表和每条 Run 的排队锁。"""
        self._host = host
        self._connection = connection
        self._client = client
        self._log = log
        self._send_lock = asyncio.Lock()
        self._run_locks: dict[str, asyncio.Lock] = {}
        self._tokens: dict[str, _Pending] = {}
        self._tasks: set[asyncio.Task[object]] = set()
        self._notify_tasks: set[asyncio.Task[None]] = set()

    @property
    def pending_count(self) -> int:
        """还没结束的表单任务数（含已发出取消、但任务还没把结果交还的）。"""
        return len(self._tasks)

    def start(self, job: FormJob) -> None:
        """起一个表单任务后立即返回，让发送泵继续消费队列。"""
        token = self._register(job)
        task = asyncio.create_task(self._host_run(job, token), name=f"harness-acp-elicitation-{job.request_id}")
        token.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(lambda _done, key=job.request_id, current=token: self._forget(key, current))

    def cancel_session(self, session_id: str) -> None:
        """会话关掉时，把它还没回答的表单按取消交还。"""
        for token in list(self._tokens.values()):
            if token.job.session_id == session_id:
                self._cancel_token(token)

    def cancel_run(self, run_id: str) -> None:
        """Run 结束或 session/cancel 时，取消这个 Run 上的表单。"""
        for token in list(self._tokens.values()):
            if token.job.run_id == run_id:
                self._cancel_token(token)

    async def ask_feedback(self, *, request_id: str, session_id: str, run_id: str) -> str | None:
        """等一条拒绝原因。没有可用文本时返回 None，调用方按普通拒绝处理。

        这里不回填 Host：权限请求还挂在调用方手里。调用方自己的任务被取消时，
        取消异常继续往上抛；只是这张表单被取消时，返回 None。
        """
        job = FormJob(
            request_id=f"{request_id}:feedback",
            session_id=session_id,
            run_id=run_id,
            spec=feedback_form(),
        )
        token = self._register(job)
        task: asyncio.Task[FormResolution | None] = asyncio.create_task(
            self._exchange(job, token),
            name=f"harness-acp-elicitation-{job.request_id}",
        )
        token.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        try:
            resolution = await task
        except asyncio.CancelledError:
            self._cancel_wait(token)
            if _self_cancelling():
                raise
            resolution = None
        finally:
            self._forget(job.request_id, token)
        if token.cancelled or resolution is None or resolution.settle != "resolve" or not resolution.value:
            return None
        text = resolution.value.get("feedback")
        return text if isinstance(text, str) and text else None

    async def aclose(self) -> None:
        """取消并等完所有表单任务；可以重复调用。"""
        for token in list(self._tokens.values()):
            self._cancel_token(token)
        tasks = list(self._tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        notes = list(self._notify_tasks)
        if notes:
            await asyncio.gather(*notes, return_exceptions=True)

    async def _host_run(self, job: FormJob, token: _Pending) -> None:
        """等回答并交还 Host。任何异常都交还一次，避免 Run 一直挂着。"""
        try:
            resolution = await self._exchange(job, token)
            if token.cancelled or resolution is None:
                self._deliver_once(token, _cancelled_resolution(job.spec))
                return
            self._deliver_once(token, resolution)
        except asyncio.CancelledError:
            self._deliver_once(token, _cancelled_resolution(job.spec))
            raise
        except Exception as exc:  # noqa: BLE001 - 表单失败必须交还，否则 Run 永远挂着
            self._warn("elicitation_failed", exc)
            self._deliver_once(token, _cancelled_resolution(job.spec))

    async def _exchange(self, job: FormJob, token: _Pending) -> FormResolution | None:
        """同一 Run 的表单串行发送。取消标记在回答套用前再看一次，晚到的接受丢掉。"""
        lock = self._run_locks.setdefault(job.run_id, asyncio.Lock())
        async with lock:
            if token.cancelled:
                return None
            response = await self._send(job, token)
            if token.cancelled:
                return None
            return apply_response(job.spec, response)

    async def _send(self, job: FormJob, token: _Pending) -> object:
        """发出表单并记下 JSON-RPC 请求号。锁只盖住「分配请求号」那一下。"""
        conn = getattr(self._client, "_conn", None)
        if conn is None or not hasattr(conn, "send_request"):
            raise RuntimeError("elicitation client has no connection")
        mode = ElicitationFormSessionMode(session_id=job.session_id, requested_schema=job.spec.requested_schema)
        captured = asyncio.Event()

        async def hooked(method: str, params: object = None) -> object:
            token.rpc_id = conn._next_request_id
            captured.set()
            return await original(method, params)

        async with self._send_lock:
            original = conn.send_request
            conn.send_request = hooked
            send_task: asyncio.Task[object] = asyncio.create_task(
                self._client.create_elicitation(job.spec.message, mode),  # type: ignore[attr-defined]
                name=f"harness-acp-elicitation-send-{job.request_id}",
            )
            token.wait_task = send_task
            waiter = asyncio.create_task(captured.wait())
            try:
                await asyncio.wait({send_task, waiter}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                if conn.send_request is hooked:
                    conn.send_request = original
                waiter.cancel()
        try:
            return await send_task
        except asyncio.CancelledError:
            send_task.cancel()
            raise

    def _register(self, job: FormJob) -> _Pending:
        """登记一张待回答表单。同一个请求号还在等时，先取消旧的。"""
        current = self._tokens.get(job.request_id)
        if current is not None:
            self._cancel_token(current)
        token = _Pending(job=job)
        self._tokens[job.request_id] = token
        return token

    def _cancel_token(self, token: _Pending) -> None:
        """先摘表，再通知客户端取消这一个请求，最后取消等待任务。"""
        first = not token.cancelled
        token.cancelled = True
        self._tokens.pop(token.job.request_id, None)
        if first:
            self._notify_cancel(token)
        self._cancel_wait(token)
        if token.task is not None and token.task is not asyncio.current_task():
            token.task.cancel()

    def _cancel_wait(self, token: _Pending) -> None:
        """取消正在飞的那次 `elicitation/create`。从那次请求里面取消自己没有意义。"""
        wait = token.wait_task
        if wait is not None and wait is not asyncio.current_task():
            wait.cancel()

    def _notify_cancel(self, token: _Pending) -> None:
        """请求号还没分配（卡在排队）时不发通知，线上没有这一帧。"""
        if token.rpc_id is None:
            return
        rpc_id = token.rpc_id

        async def go() -> None:
            try:
                params = CancelRequestNotification(request_id=rpc_id).model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
                await self._client._conn.send_notification("$/cancel_request", params)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001 - 通知失败不能再绊住已经在取消的 Run
                self._warn("elicitation_cancel_notify_failed", exc)

        task = asyncio.create_task(go(), name=f"harness-acp-elicitation-cancel-{token.job.request_id}")
        self._notify_tasks.add(task)
        task.add_done_callback(self._notify_tasks.discard)

    def _deliver_once(self, token: _Pending, resolution: FormResolution) -> None:
        """每张表单只交还 Host 一次。反馈表单由 `ask_feedback` 自己拿文本。"""
        if token.delivered or token.job.spec.kind == "feedback":
            token.delivered = True
            return
        token.delivered = True
        request_id = token.job.request_id
        if resolution.settle == "resolve":
            self._host.resolve_interaction(  # type: ignore[attr-defined]
                self._connection, request_id, dict(resolution.value or {})
            )
            return
        if resolution.settle == "fail":
            self._host.fail_interaction(  # type: ignore[attr-defined]
                self._connection,
                request_id,
                RpcError(_CANCELLED_CODE, "ELICITATION_CANCELLED"),
            )

    def _forget(self, key: str, token: _Pending) -> None:
        """任务结束后再摘一次，避免取消和正常结束各摘各的。"""
        if self._tokens.get(key) is token:
            self._tokens.pop(key, None)

    def _warn(self, code: str, exc: BaseException) -> None:
        warn = getattr(self._log, "warn", None)
        if warn is None:
            return
        warn(
            "ipc.request.failed",
            {
                "side": "server",
                "method": "elicitation/create",
                "failure_stage": code,
                "error_type": type(exc).__name__,
                "summary_code": code.upper(),
            },
        )


def _cancelled_resolution(spec: FormSpec) -> FormResolution:
    """连接取消或客户端没填完时，按这种交互自己的「算了」结果交还。"""
    if spec.kind == "plan":
        return FormResolution("resolve", {"decision": "abandoned", "feedback": ""})
    if spec.kind == "goal":
        return FormResolution("resolve", {"decision": "cancelled", "feedback": ""})
    if spec.kind == "feedback":
        return FormResolution("reject", None)
    return FormResolution("fail", None)


def _apply_question(spec: FormSpec, action: str, content: Mapping[str, object]) -> FormResolution:
    if action != "accept":
        return FormResolution("fail", None)
    answers: dict[str, list[str]] = {}
    for binding in spec.questions:
        selected = _selected(content.get(binding.property_name), binding.options)
        other = _text(content.get(binding.other_name)) if binding.other_name else ""
        if other and other not in selected:
            selected.append(other)
        if not binding.options:
            # 填空没有选项表，文本本身就是回答。
            written = _clip(_text(content.get(binding.property_name)))
            if not written:
                return FormResolution("fail", None)
            answers[binding.question_id] = [written]
            continue
        if not selected:
            return FormResolution("fail", None)
        answers[binding.question_id] = selected
    return FormResolution("resolve", {"answers": answers})


def _apply_plan(spec: FormSpec, action: str, content: Mapping[str, object]) -> FormResolution:
    decision = content.get("decision") if action == "accept" else None
    if not isinstance(decision, str) or decision not in spec.decisions:
        decision = "abandoned"
    return FormResolution("resolve", {"decision": decision, "feedback": _clip(_text(content.get("feedback")))})


def _apply_goal(spec: FormSpec, action: str, content: Mapping[str, object]) -> FormResolution:
    feedback = _clip(_text(content.get("feedback")))
    decision = content.get("decision") if action == "accept" else None
    if not isinstance(decision, str) or decision not in spec.decisions:
        return FormResolution("resolve", {"decision": "cancelled", "feedback": feedback})
    if decision != "edited":
        return FormResolution("resolve", {"decision": decision, "feedback": feedback})
    lines = _criteria_lines(content.get("criteria"))
    if not lines:
        return FormResolution(
            "resolve",
            {"decision": "rejected", "feedback": _note(feedback, "判定条件为空，已按拒绝处理")},
        )
    if len(lines) > GOAL_CRITERIA_MAX:
        return FormResolution(
            "resolve",
            {"decision": "rejected", "feedback": _note(feedback, "判定条件超过 32 条，已按拒绝处理")},
        )
    return FormResolution("resolve", {"decision": "edited", "criteria": lines, "feedback": feedback})


def _apply_feedback(action: str, content: Mapping[str, object]) -> FormResolution:
    text = _clip(_text(content.get("feedback")))
    if action == "accept" and text:
        return FormResolution("resolve", {"feedback": text})
    return FormResolution("reject", None)


def _decision_schema(
    decisions: list[tuple[str, str]],
    *,
    extra: dict[str, ElicitationStringPropertySchema],
) -> ElicitationSchema:
    properties: dict[str, ElicitationStringPropertySchema] = {
        "decision": ElicitationStringPropertySchema(
            type="string",
            one_of=[EnumOption(const=value, title=title) for value, title in decisions],
        )
    }
    properties.update(extra)
    return ElicitationSchema(properties=properties, required=["decision"])


def _known_decisions(raw: object, order: tuple[tuple[str, str], ...]) -> list[tuple[str, str]]:
    if not isinstance(raw, list):
        return []
    present = {item for item in raw if isinstance(item, str)}
    return [row for row in order if row[0] in present]


def _options(raw: object) -> list[tuple[str, str, str]]:
    """选项收成 (value, label, description)。没有 value 的条目丢掉。"""
    if not isinstance(raw, list):
        return []
    options: list[tuple[str, str, str]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        value = item.get("value")
        if not isinstance(value, str) or not value:
            continue
        label = _text(item.get("label")) or value
        description = item.get("description")
        options.append((value, label, description if isinstance(description, str) else ""))
    return options


def _question_description(body: object, options: list[tuple[str, str, str]]) -> str | None:
    lines: list[str] = []
    text = _text(body)
    if text:
        lines.append(text)
    for _value, label, description in options:
        detail = description.strip()
        if detail:
            lines.append(f"{label}：{detail}")
    return "\n".join(lines) or None


def _selected(raw: object, allowed: frozenset[str]) -> list[str]:
    """单选的字符串先包成列表，再丢掉不在选项里的值。"""
    if isinstance(raw, str):
        values = [raw]
    elif isinstance(raw, list):
        values = [item for item in raw if isinstance(item, str)]
    else:
        values = []
    chosen: list[str] = []
    for value in values:
        if value in allowed and value not in chosen:
            chosen.append(value)
    return chosen


def _criteria_lines(raw: object) -> list[str]:
    if isinstance(raw, str):
        items = raw.splitlines()
    elif isinstance(raw, list):
        items = [item for item in raw if isinstance(item, str)]
    else:
        return []
    return [item.strip() for item in items if item.strip()]


def _string_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()]


def _truncate_plan(text: str) -> str:
    """按 UTF-8 字节截断。截断点如果劈开了一个字，这个字不保留。"""
    raw = text.encode("utf-8")
    if len(raw) <= PLAN_MARKDOWN_LIMIT:
        return text
    cut = raw[:PLAN_MARKDOWN_LIMIT].decode("utf-8", errors="ignore")
    return f"{cut}\n{_PLAN_NOTE}"


def _action_and_content(response: object) -> tuple[str, Mapping[str, object]]:
    if isinstance(response, Mapping):
        action = response.get("action")
        content = response.get("content")
    else:
        action = getattr(response, "action", None)
        content = getattr(response, "content", None)
    if not isinstance(content, Mapping):
        content = {}
    return action if isinstance(action, str) else "", content


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clip(text: str) -> str:
    return text if len(text) <= FEEDBACK_MAX else text[:FEEDBACK_MAX]


def _note(feedback: str, note: str) -> str:
    combined = f"{feedback}\n{note}" if feedback else note
    return _clip(combined)


def _self_cancelling() -> bool:
    """当前任务是不是自己被取消了（而不是它在等的那张表单被取消了）。"""
    current = asyncio.current_task()
    return current is not None and current.cancelling() > 0


__all__ = [
    "FEEDBACK_MAX",
    "GOAL_CRITERIA_MAX",
    "PLAN_MARKDOWN_LIMIT",
    "SDK_VERSION",
    "ElicitationBroker",
    "FormJob",
    "FormResolution",
    "FormSpec",
    "QuestionBinding",
    "apply_response",
    "feedback_form",
    "forms_enabled",
    "goal_form",
    "plan_form",
    "question_form",
]
