"""模型可见的 Fusion 控制工具和 Run 入口校验。"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any, Literal

from langchain_core.tools import StructuredTool
from langgraph.runtime import get_runtime
from pydantic import BaseModel, ConfigDict, Field

from harness_agent.runtime.fusion.store import FusionError, encode
from harness_agent.runtime.run_context import require_run_context

PATH_SCOPE_DESCRIPTION = (
    "使用项目相对路径，例如 calc.py、tests/test_calc.py；目录以 / 结尾，例如 tests/。"
    "目标文件或目录可以不存在，由 Sidekick 创建。不能以 / 开头，"
    "不接受 ..、通配符、符号链接或内部目录；只填写本次任务需要的范围。"
)


def validate_fusion_ingress(
    *,
    profile_id: str | None,
    protocol_minor: int,
    mode: str,
    input_kind: str,
    requested_skill: object | None,
    requested_primary_profile: str | None,
    approval_mode: str | None,
    capabilities: Collection[str],
) -> None:
    """在持久化或 Goal 状态变更前拒绝不兼容的选择。"""
    if profile_id is None:
        return
    if not profile_id.strip():
        raise FusionError("FUSION_PROFILE_INVALID")
    if protocol_minor < 11:
        raise FusionError("PROTOCOL_MINOR_REQUIRED")
    if "fusion.manage" not in capabilities:
        raise FusionError("FUSION_CAPABILITY_REQUIRED")
    if (
        mode != "build"
        or input_kind != "user"
        or requested_skill is not None
        or requested_primary_profile is not None
        or approval_mode == "plan"
    ):
        raise FusionError("FUSION_INPUT_INVALID")


class Input(BaseModel):
    """控制工具只接受公开定义的字段。"""

    model_config = ConfigDict(extra="forbid")


class EmptyInput(Input):
    """无参数状态查询。"""


class DirectInput(Input):
    """直接问答的完成说明。"""

    summary: str = Field(min_length=1, max_length=8000)


class DelegateInput(Input):
    """首轮派单：目标、步骤、路径和已配置检查 ID；需求原话由 Host 保存。"""

    goal: str = Field(min_length=1, max_length=8000)
    brief: str = Field(min_length=1, max_length=16000)
    allowed_paths: list[str] = Field(
        min_length=1, max_length=256, description=PATH_SCOPE_DESCRIPTION
    )
    check_plan_ids: list[str] = Field(
        default_factory=list,
        max_length=32,
        description="只能选择当前组合配置的检查 ID；空列表使用组合的全部检查，不可自行编造 ID。",
    )


class ReworkInput(Input):
    """返工反馈；扩大范围时必须说明原因。"""

    feedback: str = Field(min_length=1, max_length=16000)
    allowed_paths: list[str] = Field(
        default_factory=list,
        max_length=256,
        description="空列表沿用原范围；增加范围必须填写 reason。"
        + PATH_SCOPE_DESCRIPTION,
    )
    reason: str = Field(default="", max_length=4000)


class ReviewItem(Input):
    """一项用户要求的结论及可定位证据。"""

    id: str
    satisfied: bool
    evidence: list[str] = Field(min_length=1, max_length=32)


class ReviewInput(Input):
    """只接受当前票据，逐项核对要求和测试改动。"""

    ticket_id: str
    decision: Literal["accept", "reject"]
    requirements: list[ReviewItem] = Field(default_factory=list, max_length=32)
    test_review_reason: str = Field(default="", max_length=4000)


class SubmitInput(Input):
    """Sidekick 的本轮报告，不包含自报检查结果。"""

    status: Literal["completed", "blocked", "incomplete"]
    summary: str = Field(min_length=1, max_length=8000)
    unresolved: list[str] = Field(default_factory=list, max_length=32)


TOOLS = {
    "fusion_finish_direct": (
        "finish_direct",
        DirectInput,
        "完成无需改码的问答，验证状态为 unverified。",
    ),
    "fusion_delegate": (
        "delegate",
        DelegateInput,
        "派单给 Sidekick；Host 自动保存原始需求，实施细节填写 goal/brief。allowed_paths 使用项目相对路径，"
        "新文件无需预先创建。等待报告和 Host 检查。",
    ),
    "fusion_rework": (
        "rework",
        ReworkInput,
        "在原 Sidekick 会话追加反馈，扩大路径必须说明原因。",
    ),
    "fusion_review_result": (
        "review",
        ReviewInput,
        "逐项审阅当前票据。证据格式为 file:相对路径 或 check:检查ID。",
    ),
    "fusion_status": ("status", EmptyInput, "读取当前任务、阶段、版本、报告与票据。"),
    "fusion_submit_result": (
        "submit_result",
        SubmitInput,
        "提交 Sidekick 本轮报告，不代表最终验收。",
    ),
}


def create_fusion_tools(role: str) -> tuple[StructuredTool, ...]:
    """共享图的闭包只保存工具方法名，不捕获任务或模型。"""
    from harness_agent.runtime.fusion.roles import LEAD_CONTROLS, WORKER_CONTROLS

    def coroutine(method: str):
        async def invoke(**arguments: Any) -> str:
            context = require_run_context(get_runtime())
            service = context.fusion_service
            if service is None:
                return encode(
                    {
                        "error": "FUSION_ROLE_DENIED",
                        "message": "当前执行没有 Fusion 控制权限。",
                    }
                )
            if "requirements" in arguments:
                arguments["requirements"] = [
                    item.model_dump() if isinstance(item, BaseModel) else item
                    for item in arguments["requirements"]
                ]
            try:
                return encode(await getattr(service, method)(context, **arguments))
            except FusionError as exc:
                if exc.code == "FUSION_FIRST_ORDER_REQUIRED":
                    return encode(
                        {
                            "error": exc.code,
                            "message": "尚无首轮任务单，不能返工。请先用 fusion_delegate 派单；工作区被占用时先处理占用任务，不要反复重试。",
                        }
                    )
                hints = {
                    "FUSION_CHECK_INVALID": (
                        "check_plan_ids",
                        "只选择配置中的检查 ID；留空会使用组合的全部检查。",
                    ),
                    "FUSION_TASK_CONFLICT": (
                        "task",
                        "先调用 fusion_status；已有首轮任务单的修改用 fusion_rework，审阅使用当前 ticket_id。",
                    ),
                    "FUSION_INPUT_INVALID": (
                        "goal/brief",
                        "目标和实施说明均须填写非空文本。",
                    ),
                    "FUSION_REWORK_LIMIT": (
                        "round",
                        "已达到返工上限，说明受阻原因后等待用户调整任务。",
                    ),
                }
                if exc.code in hints:
                    field, message = hints[exc.code]
                    result = {"error": exc.code, "field": field, "message": message}
                    if exc.code == "FUSION_CHECK_INVALID":
                        result["available_check_plan_ids"] = [
                            p.plan_id
                            for p in service.profile_provider(
                                context.fusion_task_id
                            ).check_plans
                        ]
                    return encode(result)
                return encode(
                    {
                        "error": exc.code,
                        "message": "读取 fusion_status 确认当前任务状态；不要原样重复遭拒绝的调用。",
                    }
                )
            except ValueError as exc:
                # 仅解释已知路径错误；未知异常原文可能包含内部路径或凭据。
                if str(exc) == "FUSION_PATH_INVALID" and method in {
                    "delegate",
                    "rework",
                }:
                    return encode(
                        {
                            "error": "FUSION_PATH_INVALID",
                            "field": "allowed_paths",
                            "message": PATH_SCOPE_DESCRIPTION,
                        }
                    )
                return encode(
                    {
                        "error": "FUSION_INPUT_INVALID",
                        "message": "工具参数不符合当前定义，请检查字段后修正；不要重复相同调用。",
                    }
                )

        return invoke

    names = LEAD_CONTROLS if role == "lead" else WORKER_CONTROLS
    return tuple(
        StructuredTool.from_function(
            coroutine=coroutine(TOOLS[name][0]),
            name=name,
            args_schema=TOOLS[name][1],
            description=TOOLS[name][2],
            handle_validation_error=lambda error, schema=TOOLS[name][1]: encode(
                {
                    "error": "FUSION_INPUT_INVALID",
                    "fields": sorted(
                        {
                            str(item["loc"][0])
                            for item in error.errors()
                            if item.get("loc") and item["loc"][0] in schema.model_fields
                        }
                    ),
                    "message": "按当前工具参数填写必填字段；未知字段应删除，需求原话由 Host 自动保存。",
                }
            ),
        )
        for name in sorted(names)
    )
