"""ACP 会话模式表：对外审批模式与默认值回退。

【这是做什么的？】
把 Harness 的审批模式映射成 ACP 的 `SessionModeState`，并决定新会话的初始模式。

【上下游】
- 上游：`server.py` 的 `new_session` / `load_session` / `set_session_mode`。
- 下游：`policy/approval_mode.py` 的配置默认值（经 `HostSnapshot.default_approval_mode` 传入）。

【`plan` 什么时候出现】
计划模式要靠表单让用户确认。客户端没声明 `elicitation.form` 时不放进
`availableModes`，`set_session_mode("plan")` 按未知模式拒绝，配置默认是 `plan`
时回退 `default`。声明了表单能力时，`plan`（先出计划）排在四个常规模式前面，
配置默认 `plan` 就保持 `plan`。
"""

from __future__ import annotations

from typing import Final, cast

from acp.schema import SessionMode, SessionModeState

from harness_agent.host.service_types import ApprovalModeName

_ROW = tuple[str, str, str]
"""（模式 id, 名称, 说明）。"""

_MODES: Final[tuple[_ROW, ...]] = (
    ("default", "逐项确认", "每个需要审批的操作都先询问"),
    (
        "auto-edit",
        "自动批准编辑",
        "工作区内的文件编辑与删除自动放行，命令和越界操作仍询问",
    ),
    ("auto", "自动判断", "规则与分类器先判断，拿不准才询问"),
    ("yolo", "全部放行", "不再询问，硬性安全底线仍然生效"),
)
"""没声明表单时对外的四个模式；顺序固定，客户端按这个顺序画切换器。"""

_PLAN: Final[_ROW] = ("plan", "先出计划", "先给出计划，确认后再执行")
"""只在客户端会画表单时排在最前面。"""

MODE_IDS: Final[tuple[str, ...]] = tuple(row[0] for row in _MODES)
"""四个常规模式 id。`plan` 不在这里，避免没声明表单的连接把它当成合法值。"""


def allowed_mode_ids(*, plan: bool = False) -> tuple[str, ...]:
    """当前连接能切换的模式 id。`plan` 只在会画表单时出现，并且排在最前。"""
    if plan:
        return ("plan", *MODE_IDS)
    return MODE_IDS


def default_mode(raw: str | None, *, plan: bool = False) -> ApprovalModeName:
    """把配置里的默认审批模式收成当前连接能用的模式。"""
    if raw == "plan":
        return "plan" if plan else "default"
    if raw not in MODE_IDS:
        return "default"
    return cast(ApprovalModeName, raw)


def mode_state(current: str, *, plan: bool = False) -> SessionModeState:
    """构造会话模式状态。当前项非法时回退 `default`。"""
    current_id = default_mode(current, plan=plan)
    rows = (_PLAN, *_MODES) if plan else _MODES
    return SessionModeState(
        current_mode_id=current_id,
        available_modes=[
            SessionMode(id=mode_id, name=name, description=description)
            for mode_id, name, description in rows
        ],
    )


__all__ = ["MODE_IDS", "allowed_mode_ids", "default_mode", "mode_state"]
