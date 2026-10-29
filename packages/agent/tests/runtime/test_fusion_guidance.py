from harness_agent.runtime.fusion.guidance import detect_stagnation, next_action


def test_repeated_failure_requires_two_distinct_consecutive_rounds():
    a = {"round": 1, "unresolved": [" 缺少   测试 "], "checks": []}
    b = {"round": 2, "unresolved": ["缺少 测试"], "checks": []}
    assert detect_stagnation(a, b)["kind"] == "repeated_unresolved"
    assert detect_stagnation(a, a) is None
    assert detect_stagnation(a, {**b, "round": 3}) is None
    assert detect_stagnation(a, {**b, "unresolved": ["其他问题"]}) is None


def test_check_failure_advice_is_not_a_permission_or_completion_decision():
    a = {
        "round": 1,
        "unresolved": [],
        "checks": [{"plan_id": "unit", "exit_code": 1, "summary": "assert a == b"}],
    }
    b = {**a, "round": 2}
    hint = detect_stagnation(a, b)
    assert hint["kind"] == "repeated_check_failure"
    assert "换" in hint["message"]
    assert (
        detect_stagnation(
            a,
            {
                **b,
                "checks": [
                    {"plan_id": "unit", "exit_code": 0, "summary": "assert a == b"}
                ],
            },
        )
        is None
    )
    assert "fusion_delegate" in next_action("READY", 0, None)
    assert "fusion_rework" in next_action("WAITING_USER", 1, None)
    assert "停止" in next_action("OUTCOME_UNKNOWN", 1, None)


async def test_repeated_blocked_reports_show_advice_without_changing_rework_limit(
    tmp_path,
):
    from types import SimpleNamespace
    from tests.runtime.test_fusion_service import setup

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)

    async def blocked(context, task, message):
        await service.submit_result(
            SimpleNamespace(**{**vars(ctx), "fusion_role": "sidekick"}),
            status="blocked",
            summary="环境不具备",
            unresolved=["缺少工具"],
        )

    service.worker = blocked
    try:
        first = await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        assert "stagnation" not in first
        second = await service.rework(
            ctx, feedback="换方案再做", allowed_paths=[], reason=""
        )
        assert second["phase"] == "WAITING_USER" and second["round"] == 2
        assert second["stagnation"]["kind"] == "repeated_unresolved"
        assert not second["ticket_id"] and second["verification"] == "unverified"
        assert service.profile_provider(task.task_id).max_rework_rounds == 2
    finally:
        await p.close()


async def test_same_round_recheck_clears_advice_when_failure_is_gone(tmp_path):
    from tests.runtime.test_fusion_service import setup
    from harness_agent.runtime.fusion.guidance import record_round_outcome

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        failure = {
            "round": 2,
            "unresolved": [],
            "checks": [{"plan_id": "unit", "exit_code": 1, "summary": "same failure"}],
        }
        task = await store.update(
            task.task_id,
            task.version,
            data={
                "round": 2,
                "last_round_outcome": failure,
                "stagnation": {
                    "kind": "repeated_check_failure",
                    "round": 2,
                    "message": "换策略",
                },
            },
        )
        current = await record_round_outcome(
            store,
            task,
            {"unresolved": []},
            [{"plan_id": "unit", "exit_code": 0, "summary": "ok"}],
        )
        assert not current.data.get("stagnation")
        assert "stagnation" not in current.to_record()
    finally:
        await p.close()
