"""让测试用 LangGraph fake 按真实请求边界报告用量 callback。"""

from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

from harness_agent.runtime.run_usage import UsageCallback


@contextmanager
def model_request(config):
    """fake 只转发最终消息，不对 Token 自行求和或提供另一条生产统计路径。"""
    callbacks = [callback for callback in config.get("callbacks", []) if isinstance(callback, UsageCallback)]
    run_id = uuid4()
    for callback in callbacks:
        callback.on_chat_model_start({}, [[]], run_id=run_id)
    result = {"message": None}
    try:
        yield result
    except BaseException as error:
        response = SimpleNamespace(generations=[[SimpleNamespace(message=result["message"])]], llm_output={})
        for callback in callbacks:
            callback.on_llm_error(error, run_id=run_id, response=response)
        raise
    else:
        response = SimpleNamespace(generations=[[SimpleNamespace(message=result["message"])]], llm_output={})
        for callback in callbacks:
            callback.on_llm_end(response, run_id=run_id)
