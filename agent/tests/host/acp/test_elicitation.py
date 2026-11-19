"""提问、计划、Goal、拒绝反馈四种表单的形状与取消语义。

不连真实客户端：schema 快照、回答映射、以及一个假连接上的
`$/cancel_request`（参数是 SDK 的 `requestId`，晚到的回答丢掉）。
"""

from __future__ import annotations

import asyncio
import importlib.metadata

from acp.schema import (
    AcceptElicitationResponse,
    CancelElicitationResponse,
    ClientCapabilities,
    DeclineElicitationResponse,
    ElicitationCapabilities,
    ElicitationFormCapabilities,
)

from harness_agent.host.acp.elicitation import (
    FEEDBACK_MAX,
    PLAN_MARKDOWN_LIMIT,
    SDK_VERSION,
    ElicitationBroker,
    FormJob,
    apply_response,
    feedback_form,
    forms_enabled,
    goal_form,
    plan_form,
    question_form,
)

_QUESTION = {
    "questions": [
        {
            "id": "pick",
            "question": "用哪种方案？",
            "header": "方案",
            "body": "请选择",
            "multi_select": False,
            "allow_other": True,
            "options": [
                {"label": "甲", "value": "a", "description": "快"},
                {"label": "乙", "value": "b", "description": ""},
            ],
        },
        {
            "id": "extras",
            "question": "还要什么？",
            "header": "",
            "body": "",
            "multi_select": True,
            "allow_other": False,
            "options": [{"label": "日志", "value": "log", "description": "详细"}],
        },
        {
            "question": "没有选项，跳过",
            "options": [],
        },
    ]
}


def _dump(spec: object) -> dict[str, object]:
    """把表单 schema 打成客户端真正收到的 JSON 形状。"""
    return spec.requested_schema.model_dump(mode="json", by_alias=True, exclude_none=True)  # type: ignore[attr-defined]


def test_sdk_version_is_locked() -> None:
    """表单协议还标着 UNSTABLE，SDK 版本变了必须先改这两处。"""
    assert importlib.metadata.version("agent-client-protocol") == "0.12.1"
    assert SDK_VERSION == "0.12.1"


def test_forms_enabled_only_when_form_object_is_present() -> None:
    """`{}` 表示会画表单；缺省或 null 都表示不会。"""
    enabled = ClientCapabilities(
        elicitation=ElicitationCapabilities(form=ElicitationFormCapabilities())
    )
    disabled = ClientCapabilities(elicitation=ElicitationCapabilities(form=None))
    assert forms_enabled(enabled) is True
    assert forms_enabled(disabled) is False
    assert forms_enabled(ClientCapabilities()) is False
    assert forms_enabled(None) is False
    assert forms_enabled({"elicitation": {"form": {}}}) is True
    assert forms_enabled({"elicitation": {"form": None}}) is False


def test_question_schema_uses_index_names_and_keeps_ids() -> None:
    """属性名是序号；没有选项的问题不占序号；id 留在待回答表里。"""
    spec = question_form(_QUESTION)
    assert spec is not None
    assert spec.message == "Agent 有 2 个问题需要你回答"
    assert _dump(spec) == {
        "type": "object",
        "properties": {
            "q_0": {
                "type": "string",
                "title": "方案",
                "description": "请选择\n甲：快",
                "oneOf": [
                    {"const": "a", "title": "甲"},
                    {"const": "b", "title": "乙"},
                ],
            },
            "q_0_other": {"type": "string", "title": "其他（可选）"},
            "q_1": {
                "type": "array",
                "title": "还要什么？",
                "description": "日志：详细",
                "items": {"anyOf": [{"const": "log", "title": "日志"}]},
            },
        },
        "required": ["q_0", "q_1"],
    }
    assert [item.question_id for item in spec.questions] == ["pick", "extras"]


def test_free_text_question_keeps_a_required_string() -> None:
    """没有选项但允许自由填写时，整题是一段必填文本，不能把表单作废。"""
    spec = question_form(
        {
            "questions": [
                {
                    "id": "task",
                    "question": "具体任务是什么？",
                    "allow_other": True,
                    "options": [],
                }
            ]
        }
    )
    assert spec is not None
    assert spec.message == "具体任务是什么？"
    prop = _dump(spec)["properties"]["q_0"]
    assert prop["type"] == "string"
    assert "oneOf" not in prop
    assert _dump(spec)["required"] == ["q_0"]
    accepted = apply_response(spec, {"action": "accept", "content": {"q_0": " 用甲方案 "}})
    assert accepted.settle == "resolve"
    assert accepted.value == {"answers": {"task": ["用甲方案"]}}
    blank = apply_response(spec, {"action": "accept", "content": {"q_0": "  "}})
    assert blank.settle == "fail"


def test_question_without_id_uses_resume_key() -> None:
    """缺 id 时用 question-{序号}，和 Host 把回答交回模型的键一致。"""
    spec = question_form(
        {
            "questions": [
                {
                    "question": "只问这一件",
                    "options": [{"label": "好", "value": "yes", "description": ""}],
                }
            ]
        }
    )
    assert spec is not None
    assert spec.message == "只问这一件"
    assert spec.questions[0].question_id == "question-1"


def test_question_accept_maps_indexes_back_to_ids() -> None:
    """选中值和「其他」合成 answers[id]；不在选项里的值丢掉。"""
    spec = question_form(_QUESTION)
    assert spec is not None
    accepted = apply_response(
        spec,
        AcceptElicitationResponse(
            action="accept",
            content={"q_0": "a", "q_0_other": "自定义", "q_1": ["log", "nope"]},
        ),
    )
    assert accepted.settle == "resolve"
    assert accepted.value == {"answers": {"pick": ["a", "自定义"], "extras": ["log"]}}
    dropped = apply_response(
        spec,
        {"action": "accept", "content": {"q_0": "不在选项里", "q_1": ["log"]}},
    )
    assert dropped.settle == "fail"
    assert apply_response(spec, DeclineElicitationResponse(action="decline")).settle == "fail"
    assert apply_response(spec, CancelElicitationResponse(action="cancel")).settle == "fail"


def test_plan_form_truncates_markdown_and_only_lists_known_decisions() -> None:
    """正文按 16 KiB UTF-8 截断；未知决策不进选项；没有合法决策就不是一张表单。"""
    body = "a" * (PLAN_MARKDOWN_LIMIT - 1) + "é"  # 截断点落在「é」的第一字节上
    spec = plan_form(
        {
            "plan_display_path": "/.harness/plan.md",
            "plan_markdown": body,
            "decisions": ["revise", "nope", "approved"],
        }
    )
    assert spec is not None
    assert "（计划正文已截断，仅显示前 16 KiB）" in spec.message
    shown = spec.message.split("\n\n", 1)[1]
    markdown = shown.split("\n（计划正文已截断", 1)[0]
    assert len(markdown.encode("utf-8")) <= PLAN_MARKDOWN_LIMIT
    assert "é" not in markdown
    dumped = _dump(spec)
    assert dumped["properties"]["decision"]["oneOf"] == [
        {"const": "approved", "title": "批准并开始执行"},
        {"const": "revise", "title": "需要修改"},
    ]
    assert dumped["properties"]["feedback"]["maxLength"] == FEEDBACK_MAX
    assert dumped["required"] == ["decision"]
    assert plan_form({"plan_markdown": "x", "decisions": ["nope"]}) is None
    kept = plan_form(
        {"plan_display_path": "计划", "plan_markdown": "hello", "decisions": ["approved"]}
    )
    assert kept is not None
    assert "hello" in kept.message
    assert "已截断" not in kept.message


def test_plan_accept_and_cancel() -> None:
    """接受带回决策和意见；拒绝、取消或乱选都按放弃。"""
    spec = plan_form(
        {
            "plan_display_path": "计划",
            "plan_markdown": "do it",
            "decisions": ["approved", "revise", "abandoned"],
        }
    )
    assert spec is not None
    accepted = apply_response(
        spec,
        {"action": "accept", "content": {"decision": "revise", "feedback": "改一下"}},
    )
    assert accepted.settle == "resolve"
    assert accepted.value == {"decision": "revise", "feedback": "改一下"}
    assert apply_response(spec, {"action": "decline"}).value == {
        "decision": "abandoned",
        "feedback": "",
    }
    assert apply_response(spec, {"action": "accept", "content": {"decision": "nope"}}).value == {
        "decision": "abandoned",
        "feedback": "",
    }


def test_goal_form_omits_cancelled_and_splits_edited_criteria() -> None:
    """cancelled 不是选项；改完为空或超过 32 条就按拒绝，并在意见里写明原因。"""
    spec = goal_form(
        {
            "objective": "把测试补上",
            "assumptions": ["仓库可跑", 1, "不改协议"],
            "criteria": ["有失败用例", "实现后变绿"],
            "decisions": ["accepted", "edited", "rejected", "cancelled"],
        }
    )
    assert spec is not None
    assert spec.message == "确认目标：把测试补上\n假设：仓库可跑\n不改协议"
    dumped = _dump(spec)
    assert [item["const"] for item in dumped["properties"]["decision"]["oneOf"]] == [
        "accepted",
        "edited",
        "rejected",
    ]
    assert dumped["properties"]["criteria"]["default"] == "有失败用例\n实现后变绿"
    edited = apply_response(
        spec,
        {"action": "accept", "content": {"decision": "edited", "criteria": "第一行\n\n第二行"}},
    )
    assert edited.value == {"decision": "edited", "criteria": ["第一行", "第二行"], "feedback": ""}
    empty = apply_response(
        spec,
        {"action": "accept", "content": {"decision": "edited", "criteria": "\n"}},
    )
    assert empty.value["decision"] == "rejected"
    assert "判定条件为空" in str(empty.value["feedback"])
    too_many = "\n".join(f"c{i}" for i in range(33))
    overflow = apply_response(
        spec,
        {"action": "accept", "content": {"decision": "edited", "criteria": too_many}},
    )
    assert overflow.value["decision"] == "rejected"
    assert "超过 32 条" in str(overflow.value["feedback"])
    assert apply_response(spec, {"action": "cancel"}).value == {
        "decision": "cancelled",
        "feedback": "",
    }
    bare = goal_form({"objective": "只确认", "decisions": ["accepted"]})
    assert bare is not None
    assert "假设" not in bare.message


class _Log:
    def warn(self, *_args: object, **_kwargs: object) -> None:
        """测试不关心诊断内容。"""


class _Host:
    def __init__(self) -> None:
        self.resolved: list[tuple[str, object]] = []
        self.failed: list[str] = []

    def resolve_interaction(self, _connection: object, request_id: str, value: object) -> str:
        self.resolved.append((request_id, value))
        return "resolved"

    def fail_interaction(self, _connection: object, request_id: str, _error: object) -> None:
        self.failed.append(request_id)


class _Conn:
    """只实现发请求和发通知；请求会停在门上，方便取消和排队。"""

    def __init__(self) -> None:
        self._next_request_id = 3
        self.calls = 0
        self.notifications: list[tuple[str, object]] = []
        self.entered = asyncio.Event()
        self.gate = asyncio.Event()
        self.on_response: object = None

    async def send_request(self, method: str, params: object = None) -> dict[str, object]:
        self.calls += 1
        self._next_request_id += 1
        self.entered.set()
        await self.gate.wait()
        if callable(self.on_response):
            self.on_response()
        return {"action": "accept", "content": {"q_0": "a"}}

    async def send_notification(self, method: str, params: object = None) -> None:
        self.notifications.append((method, params))


class _Client:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    async def create_elicitation(self, message: str, mode: object) -> dict[str, object]:
        return await self._conn.send_request("elicitation/create", {"message": message})


def _question_job(request_id: str, run_id: str = "run-1") -> FormJob:
    spec = question_form(
        {
            "questions": [
                {
                    "id": "pick",
                    "question": "用哪种？",
                    "options": [{"label": "甲", "value": "a", "description": ""}],
                }
            ]
        }
    )
    assert spec is not None
    return FormJob(request_id=request_id, session_id="sess-1", run_id=run_id, spec=spec)


async def test_cancel_notifies_request_id_and_discards_the_late_answer() -> None:
    """取消先摘表再发 `$/cancel_request`；随后才到的接受回答不能回填 Host。"""
    conn = _Conn()
    client = _Client(conn)
    host = _Host()
    broker = ElicitationBroker(host=host, connection=object(), client=client, log=_Log())
    broker.start(_question_job("req-1"))
    await conn.entered.wait()

    def _late_cancel() -> None:
        broker.cancel_run("run-1")

    conn.on_response = _late_cancel
    conn.gate.set()
    await asyncio.wait_for(_quiet(broker), timeout=1)
    assert conn.notifications == [("$/cancel_request", {"requestId": 3})]
    assert host.resolved == []
    assert host.failed == ["req-1"]
    await broker.aclose()


async def test_second_form_on_the_same_run_waits() -> None:
    """同一 Run 的第二张表单要等第一张结束，不能一起弹出来。"""
    conn = _Conn()
    client = _Client(conn)
    broker = ElicitationBroker(host=_Host(), connection=object(), client=client, log=_Log())
    broker.start(_question_job("req-1"))
    broker.start(_question_job("req-2"))
    await conn.entered.wait()
    await asyncio.sleep(0)
    assert conn.calls == 1
    conn.gate.set()
    await asyncio.wait_for(_quiet(broker), timeout=1)
    assert conn.calls == 2
    await broker.aclose()


async def test_feedback_decline_returns_none_without_touching_host() -> None:
    """反馈表单拒绝时返回空，让权限请求自己按普通拒绝回填。"""
    conn = _Conn()

    async def _decline(method: str, params: object = None) -> dict[str, str]:
        conn.calls += 1
        conn._next_request_id += 1
        return {"action": "decline"}

    conn.send_request = _decline  # type: ignore[method-assign]
    host = _Host()
    broker = ElicitationBroker(host=host, connection=object(), client=_Client(conn), log=_Log())
    text = await broker.ask_feedback(request_id="apr-1", session_id="sess-1", run_id="run-1")
    assert text is None
    assert host.resolved == []
    assert host.failed == []
    accepted = apply_response(feedback_form(), {"action": "accept", "content": {"feedback": " 太危险 "}})
    assert accepted.value == {"feedback": "太危险"}
    blank = apply_response(feedback_form(), {"action": "accept", "content": {"feedback": "  "}})
    assert blank.settle == "reject"


async def _quiet(broker: ElicitationBroker) -> None:
    """等后台表单任务和取消通知都跑完。"""
    for _ in range(20):
        if broker.pending_count == 0 and not broker._notify_tasks:
            return
        await asyncio.sleep(0)
    raise AssertionError("elicitation tasks did not finish")
