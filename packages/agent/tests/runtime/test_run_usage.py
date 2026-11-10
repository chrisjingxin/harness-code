"""每轮模型请求用量的去重、完整性与冻结测试。"""

from harness_agent.runtime.run_usage import RunUsage


def test_callback_records_final_usage_once_and_missing_attempt():
    from uuid import uuid4
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, LLMResult
    from harness_agent.runtime.run_usage import UsageCallback

    usage = RunUsage()
    callback = UsageCallback(usage)
    invocation = uuid4()
    callback.on_chat_model_start({}, [[]], run_id=invocation)
    response = LLMResult(generations=[[ChatGeneration(message=AIMessage(content="ok", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}))]])
    callback.on_llm_end(response, run_id=invocation)
    callback.on_llm_end(response, run_id=invocation)
    callback.on_chat_model_start({}, [[]], run_id=uuid4())
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=20, input_complete=False, output_complete=False)


def test_sums_requests_without_counting_duplicate_reports():
    usage = RunUsage()
    usage.start("one")
    usage.finish("one", {"input_tokens": 100, "output_tokens": 20})
    usage.finish("one", {"input_tokens": 100, "output_tokens": 20})
    usage.start("two")
    usage.finish("two", {"input_tokens": 150, "output_tokens": 30})
    assert usage.snapshot() == dict(input_tokens=250, output_tokens=50, input_complete=True, output_complete=True)


def test_unknown_partial_zero_and_conflicting_reports():
    usage = RunUsage()
    assert usage.snapshot()["input_tokens"] == 0
    usage.start("one")
    assert usage.snapshot()["input_tokens"] is None
    usage.finish("one", {"input_tokens": 0, "output_tokens": 20})
    usage.start("two")
    usage.finish("two", {"output_tokens": 30})
    assert usage.snapshot() == dict(input_tokens=0, output_tokens=50, input_complete=False, output_complete=True)
    usage.finish("one", {"input_tokens": 99, "output_tokens": 20})
    assert usage.snapshot()["input_complete"] is False
    assert usage.snapshot()["input_tokens"] == 0
    assert usage.snapshot()["output_complete"] is True


def test_callback_accepts_message_response_metadata_when_usage_metadata_missing():
    from types import SimpleNamespace
    from harness_agent.runtime.run_usage import UsageCallback
    usage = RunUsage()
    callback = UsageCallback(usage)
    callback.on_chat_model_start({}, [[]], run_id="one")
    response = SimpleNamespace(generations=[[SimpleNamespace(message=SimpleNamespace(response_metadata={"token_usage": {"prompt_tokens": 100, "completion_tokens": 20}}))]], llm_output=None)
    callback.on_llm_end(response, run_id="one")
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=20, input_complete=True, output_complete=True)


def test_invalid_values_and_late_reports_do_not_forge_totals():
    usage = RunUsage()
    usage.start("one")
    usage.finish("one", {"input_tokens": True, "output_tokens": -1})
    frozen = usage.freeze()
    assert frozen == dict(input_tokens=None, output_tokens=None, input_complete=False, output_complete=False)
    usage.finish("one", {"input_tokens": 100, "output_tokens": 20})
    usage.start("late")
    assert usage.snapshot() == frozen


def test_cache_is_subset_of_input_and_only_reported_when_complete():
    usage = RunUsage()
    usage.start("one")
    usage.finish("one", {"input_tokens": 100, "output_tokens": 20, "cached_tokens": 80})
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=20, input_complete=True, output_complete=True, cached_tokens=80)
    usage.start("two")
    usage.finish("two", {"input_tokens": 50, "output_tokens": 10})
    assert usage.snapshot()["input_tokens"] == 150
    assert "cached_tokens" not in usage.snapshot()


def test_callback_normalizes_cache_and_zero_without_double_counting():
    from types import SimpleNamespace
    from harness_agent.runtime.run_usage import UsageCallback
    usage = RunUsage()
    callback = UsageCallback(usage)
    callback.on_chat_model_start({}, [[]], run_id="one")
    callback.on_llm_end(SimpleNamespace(generations=[], llm_output={"token_usage": {
        "prompt_tokens": 100, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 80},
    }}), run_id="one")
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=0, input_complete=True, output_complete=True, cached_tokens=80)


def test_provider_output_rollback_does_not_erase_actual_request_usage():
    from harness_agent.runtime.execution_stream import StreamSession
    session = StreamSession(run_id="root")
    before = session.snapshot()
    session.usage_collector.start("attempt")
    session.usage_collector.finish("attempt", {"input_tokens": 100, "output_tokens": 20})
    session.restore(before)
    assert session.usage == {"input_tokens": 100, "output_tokens": 20}


def test_real_langchain_callback_path_sums_two_model_invocations():
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from harness_agent.runtime.run_usage import UsageCallback
    usage = RunUsage()
    model = GenericFakeChatModel(messages=iter([
        AIMessage(content="first", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120, "input_token_details": {"cache_read": 80}}),
        AIMessage(content="second", usage_metadata={"input_tokens": 150, "output_tokens": 30, "total_tokens": 180, "input_token_details": {"cache_read": 100}}),
    ]))
    callback = UsageCallback(usage)
    for text in ("one", "two"):
        model.invoke([HumanMessage(content=text)], config={"callbacks": [callback]})
    assert usage.freeze() == dict(input_tokens=250, output_tokens=50, input_complete=True, output_complete=True, cached_tokens=180)
