"""ACP 会话模式表：四个对外审批模式与默认值回退。

【这是做什么的？】
把 Harness 的审批模式（`default` / `auto-edit` / `auto` / `yolo`）映射成 ACP 的
`SessionModeState`，并决定新会话的初始模式。

【上下游】
- 上游：`server.py` 的 `new_session` / `load_session` / `set_session_mode`。
- 下游：`policy/approval_mode.py` 的配置默认值（经 `HostSnapshot.default_approval_mode` 传入）。

【为什么没有 `plan`】
`plan` 依赖「确认计划」这种交互，ACP 没有标准形态（登记为 GAP-02）。把它放进
`availableModes` 只会让客户端给出一个永远无法正常工作的开关，所以永不暴露；
`set_session_mode("plan")` 按未知模式拒绝。配置默认是 `plan` 时回退 `default`。
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
"""对外暴露的四个模式；顺序固定，客户端按这个顺序画切换器。"""

MODE_IDS: Final[tuple[str, ...]] = tuple(row[0] for row in _MODES)
"""合法模式 id；`set_session_mode` 用它拒绝未知值与 `plan`。"""


def default_mode(raw: str | None) -> ApprovalModeName:
    """把配置里的默认审批模式收成对外模式；`plan` 与未知值回退 `default`。"""
    if raw == "plan" or raw not in MODE_IDS:
        return "default"
    return cast(ApprovalModeName, raw)


def mode_state(current: str) -> SessionModeState:
    """构造会话模式状态：四项固定列表 + 当前项（非法值回退 `default`）。"""
    current_id = default_mode(current)
    return SessionModeState(
        current_mode_id=current_id,
        available_modes=[
            SessionMode(id=mode_id, name=name, description=description)
            for mode_id, name, description in _MODES
        ],
    )


__all__ = ["MODE_IDS", "default_mode", "mode_state"]
