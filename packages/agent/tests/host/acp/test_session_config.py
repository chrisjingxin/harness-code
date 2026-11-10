"""S4 会话配置、用量、Compose 阶段和文件内联。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from harness_agent.host.acp.server import _prompt_usage
from harness_agent.host.acp.tool_display import PathLocator
from harness_agent.host.acp.translate import RunTranslator
from harness_agent.host.connection import RpcError
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    make_host,
    make_persistent_host,
    primary_path_resolver,
    prompt_response,
    text,
)


def _write_model_config(home: Path) -> None:
    """一份只用于目录展示的模型配置，不发起真实请求。"""
    config_dir = home / ".harness"
    config_dir.mkdir(parents=True)
    (config_dir / "config.toml").write_text(
        """
[config]
version = 1

[models]
default_profile = "fast"

[models.profiles.fast]
provider = "openai-compatible"
provider_label = "fast"
model = "fake-model"
base_url = "http://127.0.0.1:9/v1"
api_key = "fake-key"
context_window_tokens = 32000

[models.profiles.slow]
provider = "openai-compatible"
provider_label = "slow"
model = "other-model"
base_url = "http://127.0.0.1:9/v1"
api_key = "fake-key"
context_window_tokens = 32000
""".strip()
        + "\n",
        encoding="utf-8",
    )


def _option(options: list[dict[str, Any]], option_id: str) -> dict[str, Any]:
    """按 id 取出一条 configOption。"""
    return next(item for item in options if item["id"] == option_id)


async def _initialize(client: Any) -> None:
    response = await client.request(
        1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )
    assert "result" in response, response


async def test_echo_session_offers_workflow_without_a_model(tmp_path: Path) -> None:
    """回声模式没有模型目录，配置项里只剩工作流。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
        )
        options = created["result"]["configOptions"]
        assert [item["id"] for item in options] == ["workflow"]
        assert _option(options, "workflow")["currentValue"] == "build"
        unknown = await acp.client.request(
            3,
            "session/set_config_option",
            {"sessionId": created["result"]["sessionId"], "configId": "model", "value": "fast"},
        )
        assert unknown["error"]["data"]["code"] == "UNKNOWN_CONFIG_OPTION"


async def test_model_catalog_and_next_run_profile(tmp_path: Path) -> None:
    """模型项目录来自配置；set_config_option 只改下一轮的 requested_primary_profile。"""
    _write_model_config(tmp_path / "home")
    host = make_persistent_host(tmp_path)
    calls: list[Any] = []

    async def spy(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        calls.append(request)
        raise RpcError(-32010, "MODEL_CONFIGURATION_REQUIRED")

    host.start_run = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        assert "result" in created, created
        session_id = created["result"]["sessionId"]
        model = _option(created["result"]["configOptions"], "model")
        assert model["currentValue"] == "fast"
        assert model["category"] == "model"
        fast = next(item for item in model["options"] if item["value"] == "fast")
        assert fast["name"] == "fake-model"
        assert fast["description"] == "fast"
        bad = await acp.client.request(
            3,
            "session/set_config_option",
            {"sessionId": session_id, "configId": "model", "value": "missing"},
        )
        assert bad["error"]["data"]["code"] == "INVALID_CONFIG_VALUE"
        changed = await acp.client.request(
            4,
            "session/set_config_option",
            {"sessionId": session_id, "configId": "model", "value": "slow"},
        )
        assert _option(changed["result"]["configOptions"], "model")["currentValue"] == "slow"
        update = next(
            frame
            for frame in acp.client.frames
            if frame.get("method") == "session/update"
            and frame["params"]["update"]["sessionUpdate"] == "config_option_update"
        )
        assert _option(update["params"]["update"]["configOptions"], "model")["currentValue"] == "slow"
        failed = await acp.client.request(
            5,
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": "下一轮"}]},
        )
        assert failed["error"]["data"]["code"] == "MODEL_CONFIGURATION_REQUIRED"
    assert calls[0].requested_primary_profile == "slow"
    assert calls[0].mode == "build"


class _BlockOnce:
    """第一轮一直停着，之后的轮次立刻回一句。用来区分「正在跑」和「下一轮」。"""

    def __init__(self) -> None:
        self._calls = 0

    async def astream(self, stream_input: object = None, **_kwargs: object):
        self._calls += 1
        if self._calls == 1:
            await asyncio.Event().wait()
        yield text("好")


async def test_workflow_change_during_a_run_applies_to_the_next_prompt(tmp_path: Path) -> None:
    """运行中把工作流改成 compose，只影响下一轮。"""
    host = make_host(tmp_path, agent=_BlockOnce())
    calls: list[Any] = []
    original = host.start_run

    async def spy(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        calls.append(request)
        return await original(connection, request, on_accepted=on_accepted)

    host.start_run = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        session_id = created["result"]["sessionId"]
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": "先跑着"}],
                },
            }
        )
        for _ in range(50):
            if calls:
                break
            await asyncio.sleep(0.02)
        assert calls, "第一轮还没进入 start_run"
        changed = await acp.client.request(
            4,
            "session/set_config_option",
            {"sessionId": session_id, "configId": "workflow", "value": "compose"},
        )
        assert _option(changed["result"]["configOptions"], "workflow")["currentValue"] == "compose"
        invalid = await acp.client.request(
            5,
            "session/set_config_option",
            {"sessionId": session_id, "configId": "workflow", "value": "direct_shell"},
        )
        assert invalid["error"]["data"]["code"] == "INVALID_CONFIG_VALUE"
        await acp.client.notify("session/cancel", {"sessionId": session_id})
        cancelled = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(cancelled).stop_reason == "cancelled"
        response = await acp.client.request(
            7,
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": "下一轮"}]},
        )
        # 这台测试 Host 没有 Compose 适配器。错误码本身说明第二轮已经按 compose 提交。
        assert response["error"]["data"]["code"] == "COMPOSE_ADAPTER_NOT_READY"
    assert [call.mode for call in calls] == ["build", "compose"]


def test_compose_progress_becomes_a_plan_and_usage_dedupes(tmp_path: Path) -> None:
    """Compose 阶段映射成 plan；相同用量不重复发。"""
    translator = RunTranslator("run-1", PathLocator(primary_path_resolver(tmp_path)))
    plan = translator.feed(
        {
            "type": "compose.progress",
            "payload": {
                "status": "active",
                "stages": [
                    {"id": "requirement", "state": "confirmed"},
                    {"id": "implement", "state": "current"},
                    {"id": "review", "state": "failed"},
                    {"id": "custom", "state": "pending"},
                ],
            },
        }
    )
    entries = plan.updates[0].entries
    assert [(entry.content, entry.status) for entry in entries] == [
        ("需求", "completed"),
        ("实现", "in_progress"),
        ("检视（失败）", "completed"),
        ("custom", "pending"),
    ]
    summary = translator.feed(
        {"type": "compose.summary", "payload": {"status": "done", "text": "阶段结束"}}
    )
    assert summary.updates[0].message_id == "run-1:compose-summary"
    assert summary.updates[0].content.text == "阶段结束"
    first = translator.feed(
        {
            "type": "context.updated",
            "payload": {"estimated_tokens": 10, "context_window_tokens": 100},
        }
    )
    assert first.updates[0].used == 10
    assert first.updates[0].size == 100
    again = translator.feed(
        {
            "type": "context.updated",
            "payload": {"estimated_tokens": 10, "context_window_tokens": 100},
        }
    )
    assert again.updates == []
    assert "context.updated" not in translator.ignored_types


def test_prompt_usage_maps_cached_tokens_and_skips_missing_usage() -> None:
    """usage 缺字段按 0；缓存看三个别名；没有 usage 就不编造。"""
    usage = _prompt_usage({"usage": {"input_tokens": 3, "cached_input_tokens": 2, "output_tokens": True}})
    assert usage is not None
    assert usage.input_tokens == 3
    assert usage.output_tokens == 0
    assert usage.cached_read_tokens == 2
    assert usage.total_tokens == 3
    assert _prompt_usage({"duration_ms": 1}) is None
    assert _prompt_usage(None) is None


async def test_echo_prompt_response_carries_usage(tmp_path: Path) -> None:
    """完成的一轮把 usage 放进响应，不依赖 runSummary 扩展。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
        )
        response = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": created["result"]["sessionId"],
                "prompt": [{"type": "text", "text": "你好"}],
            },
        )
        parsed = prompt_response(response)
        assert parsed.stop_reason == "end_turn"
        assert parsed.usage is not None
        assert parsed.usage.input_tokens == 0
        assert parsed.usage.output_tokens == 0


async def test_authorized_file_is_inlined_for_the_model_only(tmp_path: Path) -> None:
    """根内文件进入模型正文，Transcript 消息仍是原文加路径。"""
    sample = tmp_path / "ws" / "sample.py"
    host = make_host(tmp_path, agent=ScriptedAgent([text("引用了")]))
    sample.write_text("print('hi')\n", encoding="utf-8")
    calls: list[Any] = []
    original = host.start_run

    async def spy(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        calls.append(request)
        return await original(connection, request, on_accepted=on_accepted)

    host.start_run = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        response = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": created["result"]["sessionId"],
                "prompt": [
                    {
                        "type": "resource_link",
                        "uri": sample.as_uri(),
                        "name": "sample.py",
                    },
                    {"type": "text", "text": "解释一下"},
                ],
            },
        )
        assert prompt_response(response).stop_reason == "end_turn"
    message = calls[0].input.message
    model_message = calls[0].input.model_message
    assert "print('hi')" not in message
    assert str(sample) in message
    assert "解释一下" in message
    assert model_message is not None
    assert "print('hi')" in model_message
    assert "[Attached Context:" in model_message
    assert "```python" in model_message


async def test_embedded_text_inlines_and_blob_is_rejected(tmp_path: Path) -> None:
    """客户端已经带来的文本不再读盘；blob 仍然不支持。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    calls: list[Any] = []
    original = host.start_run

    async def spy(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        calls.append(request)
        return await original(connection, request, on_accepted=on_accepted)

    host.start_run = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        session_id = created["result"]["sessionId"]
        ok = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {
                        "type": "resource",
                        "resource": {"uri": "memory://note", "text": "客户端正文"},
                    },
                    {"type": "text", "text": "看这段"},
                ],
            },
        )
        assert prompt_response(ok).stop_reason == "end_turn"
        rejected = await acp.client.request(
            4,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "resource", "resource": {"uri": "memory://bin", "blob": "YQ=="}}
                ],
            },
        )
        assert rejected["error"]["data"]["code"] == "UNSUPPORTED_CONTENT_BLOCK"
    assert "客户端正文" in calls[0].input.model_message
    assert "客户端正文" not in calls[0].input.message


async def test_oversized_file_stays_a_placeholder(tmp_path: Path) -> None:
    """达到 10 KB 的文件不把正文塞进模型输入。"""
    sample = tmp_path / "ws" / "big.txt"
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    sample.write_bytes(b"a" * (10 * 1024))
    calls: list[Any] = []
    original = host.start_run

    async def spy(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        calls.append(request)
        return await original(connection, request, on_accepted=on_accepted)

    host.start_run = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": created["result"]["sessionId"],
                "prompt": [
                    {"type": "resource_link", "uri": sample.as_uri(), "name": "big.txt"},
                    {"type": "text", "text": "看看"},
                ],
            },
        )
    model_message = calls[0].input.model_message
    assert "too large to inline" in model_message
    assert "a" * 100 not in model_message
    assert "a" * 100 not in calls[0].input.message
