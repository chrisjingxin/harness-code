"""把具体操作建议放在工具状态中，提示重复失败但不改变权限或验收。"""

from __future__ import annotations

from typing import Mapping


def _normalized(value: object) -> str:
    return " ".join(str(value).split())


def detect_stagnation(
    previous: Mapping[str, object] | None, current: Mapping[str, object]
) -> dict[str, object] | None:
    """只比较相邻的两轮；重复读同一报告不能触发。"""
    if not previous or current["round"] != previous["round"] + 1:
        return None
    kind = None
    unresolved = sorted(
        _normalized(value)
        for value in current.get("unresolved", [])
        if _normalized(value)
    )
    old = sorted(
        _normalized(value)
        for value in previous.get("unresolved", [])
        if _normalized(value)
    )
    if unresolved and unresolved == old:
        kind = "repeated_unresolved"
    old_checks = {
        (item["plan_id"], _normalized(item.get("summary", "")))
        for item in previous.get("checks", [])
        if item.get("exit_code") not in (0, None)
        and _normalized(item.get("summary", ""))
    }
    if any(
        (item["plan_id"], _normalized(item.get("summary", ""))) in old_checks
        for item in current.get("checks", [])
        if item.get("exit_code") not in (0, None)
    ):
        kind = "repeated_check_failure"
    if not kind:
        return None
    return {
        "kind": kind,
        "round": current["round"],
        "message": "连续两轮出现相同失败，请换一种实现或检查策略，集中反馈后再返工；若缺少信息，请向用户具体说明阻塞。此提示不代表已耗尽轮次，也不授予额外权限。",
    }


def next_action(phase: str, revision: int, reason: str | None) -> str:
    """返回当前可执行步骤，避免 Lead 背诵所有状态的恢复方法。"""
    if phase == "OUTCOME_UNKNOWN":
        return "结果尚未确认：可以只读核查。必须确认相关操作停止并记录凭据后才能恢复，不能反复派单。"
    if phase == "WAITING_RESOURCE":
        return "Host 正在自动排队，可用后继续；不要重复派单或结束其他正常任务。"
    if phase in ("COMPLETED", "CANCELLED"):
        return "本任务已结束，请如实说明结果。新修改应由新的任务处理。"
    if phase == "REVIEWING":
        return "读取当前 ticket_id 和 requirements，逐项用 file:相对路径 或 check:检查ID 审阅；测试有改动时填写 test_review_reason。其他源码变化可能产生新票据，以最新状态为准。"
    if not revision:
        return "无需改码可用 fusion_finish_direct。先调查可用 fusion_explore；需要实施时用 fusion_delegate 首次派单，allowed_paths 用项目相对路径，新文件无需先创建。"
    if reason == "resource_wait_paused":
        return (
            "原请求排队已暂停；无新修改的“继续等待”恢复原请求。新反馈先核实再更新任务。"
        )
    return "先用 fusion_status 找回当前任务单。后续修改使用 fusion_rework；原范围可留空 allowed_paths，真正扩大范围才需 reason。没有票据也不能重复首次派单。"


async def record_round_outcome(
    store: object,
    task: object,
    report: Mapping[str, object],
    checks: list[dict[str, object]],
) -> object:
    """保存上一轮比较材料，状态只公开提示，不公开失败正文。"""
    current = {
        "round": task.data["round"],
        "unresolved": report.get("unresolved", []),
        "checks": [
            {
                "plan_id": item["plan_id"],
                "exit_code": item.get("exit_code"),
                "summary": item.get("summary", ""),
            }
            for item in checks
        ],
    }
    previous = task.data.get("last_round_outcome")
    # 同轮检查可能因其他源码变动重跑，不把它当成两个独立实施轮次。
    if previous and previous["round"] == current["round"]:
        hint = task.data.get("stagnation") if current == previous else None
    else:
        hint = detect_stagnation(previous, current)
    return await store.update(
        task.task_id,
        task.version,
        data={"last_round_outcome": current, "stagnation": hint},
    )
