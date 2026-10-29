"""用量区分未知和零，恢复不能重复累计。"""

import pytest
from harness_agent.runtime.fusion.usage import aggregate_usage, price_usage
from harness_agent.runtime.execution_stream import (
    StreamSession,
    start_model_round,
    update_usage,
)
from harness_agent.runtime.model_usage import observed_calls


def test_all_calls_and_missing_cache_are_preserved():
    s = StreamSession("r")
    start_model_round(s)
    update_usage(
        s,
        {
            "input_tokens": 20,
            "output_tokens": 4,
            "input_token_details": {"cache_read": 0},
        },
    )
    update_usage(s, {"input_tokens": 10, "output_tokens": 2})
    start_model_round(s)
    update_usage(s, {"prompt_tokens": 30, "completion_tokens": 5})
    calls = observed_calls(s, 0)
    assert calls == [
        {"input_tokens": 20, "output_tokens": 4, "cached_input_tokens": 0},
        {"input_tokens": 30, "output_tokens": 5},
    ]
    data = aggregate_usage(None, "fast", calls)
    assert (
        data["calls"] == 2 and data["input_tokens"] == 50 and data["output_tokens"] == 9
    )
    assert data["complete"] is True and data["cache_complete"] is False
    assert data["cache_hit_rate"] is None
    assert observed_calls(s, len(s.usage_observations)) == []


def test_failure_without_usage_is_unknown_not_free():
    data = aggregate_usage(None, "fast", [{}])
    assert data["complete"] is False and data["cache_complete"] is False
    assert (
        price_usage(
            data,
            {
                "currency": "USD",
                "input_per_million": "10",
                "output_per_million": "20",
                "cached_input_per_million": "1",
            },
        )
        is None
    )


def test_price_uses_cache_discount_and_never_guesses_cache_price():
    data = aggregate_usage(
        None,
        "fast",
        [
            {
                "input_tokens": 1000000,
                "output_tokens": 100000,
                "cached_input_tokens": 500000,
            }
        ],
    )
    assert data["cache_hit_rate"] == 0.5
    price = {
        "currency": "USD",
        "input_per_million": "10",
        "output_per_million": "20",
        "cached_input_per_million": "1",
    }
    assert price_usage(data, price) == "7.5"
    assert price_usage(data, {**price, "cached_input_per_million": None}) is None
    assert (
        price_usage(
            aggregate_usage(
                None,
                "fast",
                [{"input_tokens": 1, "output_tokens": 1, "cached_input_tokens": 2}],
            ),
            price,
        )
        is None
    )


async def test_usage_is_durable_idempotent_and_cannot_revive_completed_task(tmp_path):
    from tests.runtime.test_fusion_service import setup

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        task = await store.complete_task(task.task_id, task.version)
        args = dict(
            role="lead",
            profile_id="pro",
            calls=[{"input_tokens": 12, "output_tokens": 3}],
        )
        updated = await store.record_usage(task.task_id, "usage-one", **args)
        again = await store.record_usage(task.task_id, "usage-one", **args)
        assert again.version == updated.version
        assert again.phase == "COMPLETED" and not again.active
        assert again.to_record()["usage"]["lead"]["input_tokens"] == 12
        assert (await store.latest("t")).to_record()["usage"] == again.to_record()[
            "usage"
        ]
        with pytest.raises(ValueError):
            await store.record_usage(
                task.task_id, "usage-one", **{**args, "calls": [{}]}
            )
    finally:
        await p.close()


def test_output_rollback_keeps_usage_facts_and_next_attempt_has_new_cursor():
    s = StreamSession("r")
    before = s.snapshot()
    start_model_round(s)
    update_usage(s, {"input_tokens": 9, "output_tokens": 2, "cached_tokens": 0})
    s.restore(before)
    assert observed_calls(s, 0) == [
        {"input_tokens": 9, "output_tokens": 2, "cached_input_tokens": 0}
    ]
    cursor = len(s.usage_observations)
    start_model_round(s)
    update_usage(s, {"input_tokens": 4, "output_tokens": 1, "cached_tokens": 0})
    assert observed_calls(s, cursor) == [
        {"input_tokens": 4, "output_tokens": 1, "cached_input_tokens": 0}
    ]


def test_estimate_saving_is_a_same_token_hypothesis_and_can_be_negative():
    from harness_agent.runtime.fusion.usage import usage_record

    data = aggregate_usage(
        None,
        "fast",
        [
            {
                "input_tokens": 1000000,
                "output_tokens": 100000,
                "cached_input_tokens": 500000,
            }
        ],
    )
    low = {
        "currency": "USD",
        "input_per_million": "1",
        "output_per_million": "2",
        "cached_input_per_million": "0.1",
    }
    high = {
        "currency": "USD",
        "input_per_million": "10",
        "output_per_million": "20",
        "cached_input_per_million": "1",
    }
    result = usage_record(
        {"lead": None, "sidekick": data}, {"lead": low, "sidekick": high}
    )
    assert result["estimate"]["sidekick_at_lead_price"] == "0.75"
    assert result["estimate"]["estimated_saving"] == "-6.75"
    assert (
        usage_record(
            {"sidekick": data}, {"lead": low, "sidekick": {**high, "currency": "CNY"}}
        )["estimate"]
        is None
    )


def test_diagnostic_usage_ledger_counts_every_model_call_in_one_graph_run():
    from harness_agent.runtime.managed_agent_executor import _round_usage

    s = StreamSession("r")
    start_model_round(s)
    update_usage(s, {"input_tokens": 20, "output_tokens": 4, "cached_tokens": 0})
    start_model_round(s)
    update_usage(s, {"input_tokens": 10, "output_tokens": 2, "cached_tokens": 0})
    assert _round_usage(s, {}, 0) == {
        "input_tokens": 30,
        "output_tokens": 6,
        "cached_input_tokens": 0,
    }
