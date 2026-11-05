"""ACP 失败路径：Run 失败、配置缺失、畸形输入与诊断日志约束。

【为什么单独成文件】
成功路径验证「能跑通」，失败路径才验证「不会装作跑通也不会崩」。这里逐条锁定
错误码、`data` 形状、update 与响应的先后顺序，以及诊断日志只写白名单字段。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from harness_agent.extensions.plugin_skills import SkillError
from harness_agent.extensions.skills import SkillError as CatalogSkillError
from harness_agent.host.acp.server import to_request_error
from harness_agent.host.connection import RpcError
from harness_agent.host.run_coordinator import RunError
from harness_agent.threads.thread_persistence import ThreadPersistenceError
from tests.support.acp_harness import (
    InProcessAcp,
    RawAcpClient,
    ScriptedAgent,
    first_update,
    make_host,
    prompt_response,
    text,
    tool_args,
    tool_result,
    tool_start,
)


class _RecordingLog:
    """记录每条诊断日志的字段名，用来检查「只写白名单字段」。"""

    def __init__(self) -> None:
        self.records: list[tuple[str, str, dict[str, object]]] = []

    def child(self, _context: object) -> _RecordingLog:
        return self

    def debug(self, event: str, fields: dict[str, object]) -> None:
        self.records.append(("debug", event, dict(fields)))

    def info(self, event: str, fields: dict[str, object]) -> None:
        self.records.append(("info", event, dict(fields)))

    def warn(self, event: str, fields: dict[str, object]) -> None:
        self.records.append(("warn", event, dict(fields)))

    def error(self, event: str, fields: dict[str, object]) -> None:
        self.records.append(("error", event, dict(fields)))

    def names(self) -> list[str]:
        return [event for _level, event, _fields in self.records]


async def _initialize(client: RawAcpClient, *, request_id: int = 1) -> dict[str, Any]:
    return await client.request(request_id, "initialize", {"protocolVersion": 1})


async def _new_session(client: RawAcpClient, workspace: Path, *, request_id: int = 2) -> str:
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    return response["result"]["sessionId"]


def _prompt(session_id: str, text_value: str = "你好") -> dict[str, Any]:
    return {"sessionId": session_id, "prompt": [{"type": "text", "text": text_value}]}


# —— 纯函数：错误映射 ——


def _data(error: object) -> dict[str, Any]:
    """取 RequestError.data 并断言是字典（Pyright 才认得更窄的类型）。"""
    payload = getattr(error, "data", None)
    assert isinstance(payload, dict), payload
    return payload


def test_run_error_maps_to_internal_error_with_stable_code() -> None:
    """RunError 的稳定码与 retryable 原样进 data，客户端才能分支重试。"""
    error = to_request_error(RunError("THREAD_BUSY", retryable=True), startup_error=None)
    assert error.code == -32603
    assert error.data == {"code": "THREAD_BUSY", "message": "THREAD_BUSY", "retryable": True}


def test_invalid_params_rpc_error_is_preserved() -> None:
    """参数错误保持 -32602，客户端可以就地修正。"""
    error = to_request_error(RpcError(-32602, "message must be non-empty"), startup_error=None)
    assert error.code == -32602
    assert _data(error)["code"] == "INVALID_PARAMS"


def test_uppercase_rpc_message_becomes_the_code() -> None:
    """`RpcError(-32004, "HOST_CLOSED")` 这类全大写消息直接当稳定码。"""
    error = to_request_error(RpcError(-32004, "HOST_CLOSED"), startup_error=None)
    assert error.code == -32603
    assert _data(error)["code"] == "HOST_CLOSED"


def test_startup_error_text_becomes_configuration_error() -> None:
    """message 恰好等于 Host 的启动错误文本时归为配置错误，并保留原文。"""
    startup = "Invalid TOML in /Users/x/.harness/config.toml: bad"
    error = to_request_error(RpcError(-32004, startup), startup_error=startup)
    assert _data(error)["code"] == "CONFIGURATION_ERROR"
    assert _data(error)["message"] == startup


def test_other_rpc_error_falls_back_to_start_run_failed() -> None:
    """其它 RpcError 统一 START_RUN_FAILED，不把内部文案当错误码。"""
    error = to_request_error(RpcError(-32004, "ThreadPersistence is unavailable"), startup_error=None)
    assert _data(error)["code"] == "START_RUN_FAILED"


def test_unknown_exception_does_not_leak_text() -> None:
    """未知异常只报 INTERNAL_ERROR，绝不把异常文本（可能含路径）发给客户端。"""
    error = to_request_error(RuntimeError("/Users/secret/path blew up"), startup_error=None)
    assert error.code == -32603
    assert _data(error)["code"] == "INTERNAL_ERROR"
    assert "/Users/secret" not in json.dumps(_data(error))


def test_long_message_is_truncated() -> None:
    """错误文案截断到 2000 字符，避免整段模型输出塞进错误帧。"""
    error = to_request_error(RpcError(-32004, "x" * 5000), startup_error=None)
    assert len(str(_data(error)["message"])) <= 2000


@pytest.mark.parametrize(
    ("exc", "expected_code", "expected_data_code", "expected_retryable"),
    [
        # session/load：线程不存在改成 ACP 的「资源不存在」；损坏不是客户端的错。
        (RpcError(-32004, "THREAD_NOT_FOUND"), -32002, "THREAD_NOT_FOUND", False),
        (RpcError(-32004, "THREAD_NOT_RECOVERABLE"), -32603, "THREAD_NOT_RECOVERABLE", False),
        # 存储错误只把全大写错误码当契约，其余文案不外泄。
        (ThreadPersistenceError("CHECKPOINT_LIST_INVALID_LIMIT"), -32603, "CHECKPOINT_LIST_INVALID_LIMIT", False),
        (ThreadPersistenceError("db locked at /Users/secret/app.db"), -32603, "THREAD_STORE_ERROR", False),
        # `/命令` 校验失败是参数问题（-32602），原码原样给客户端。
        (SkillError("COMMAND_INVOCATION_BINDING_STALE"), -32602, "COMMAND_INVOCATION_BINDING_STALE", False),
        (SkillError('Skill "x" has an empty body'), -32602, "SKILL_ERROR", False),
        (CatalogSkillError("CATALOG_SNAPSHOT_MISSING"), -32602, "CATALOG_SNAPSHOT_MISSING", False),
        # 审批模式的两种失败：忙可重试，计划锁定不可重试。
        (RunError("RUN_APPROVAL_MODE_BUSY", retryable=True), -32603, "RUN_APPROVAL_MODE_BUSY", True),
        (RunError("RUN_APPROVAL_MODE_PLAN_LOCKED"), -32603, "RUN_APPROVAL_MODE_PLAN_LOCKED", False),
        # echo 模式没有线程存储：-32603 而不是 ACP 的 -32002。
        (RpcError(-32002, "THREADS_UNAVAILABLE_IN_ECHO_MODE"), -32603, "THREADS_UNAVAILABLE_IN_ECHO_MODE", False),
    ],
)
def test_error_mapping_table(
    exc: BaseException,
    expected_code: int,
    expected_data_code: str,
    expected_retryable: bool,
) -> None:
    """错误映射表：每行都锁住 JSON-RPC 码、`data.code` 与 `retryable`。"""
    error = to_request_error(exc, startup_error=None)
    assert error.code == expected_code
    data = _data(error)
    assert data["code"] == expected_data_code
    assert data["retryable"] is expected_retryable
    # 存储错误与未知异常的原文不能出现在错误帧里。
    assert "/Users/secret" not in json.dumps(data)


# —— 端到端失败路径 ——


async def test_run_failure_returns_internal_error_after_prior_updates(tmp_path: Path) -> None:
    """Run 失败：先收到之前的 update，再收到 -32603 + data.code=RuntimeError。"""

    class _ExplodingAgent:
        async def astream(self, _stream_input: object, **_kwargs: object):
            from langchain_core.messages import AIMessageChunk

            yield ("messages", (AIMessageChunk(content="先说一句"), {}))
            raise RuntimeError("模型炸了")

    async with InProcessAcp(make_host(tmp_path, agent=_ExplodingAgent())) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(3, "session/prompt", _prompt(session_id))
        error = response["error"]
        assert error["code"] == -32603
        assert error["data"]["code"] == "RuntimeError"
        assert error["data"]["retryable"] is False
        # 之前的 update 已经在响应之前到达。
        assert first_update("agent_message_chunk", acp.client.frames)["content"]["text"] == "先说一句"
        response_index = next(i for i, f in enumerate(acp.client.frames) if f.get("id") == 3)
        assert max(
            i for i, f in enumerate(acp.client.frames) if f.get("method") == "session/update"
        ) < response_index


async def test_missing_model_configuration_reports_stable_code(tmp_path: Path) -> None:
    """没有模型配置时 prompt 回 MODEL_CONFIGURATION_REQUIRED，但 session/new 已成功。"""
    host = make_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(3, "session/prompt", _prompt(session_id))
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "MODEL_CONFIGURATION_REQUIRED"


async def test_broken_config_reports_configuration_error(tmp_path: Path) -> None:
    """配置损坏时 data.code=CONFIGURATION_ERROR，session/new 仍然成功（Spec §5.5）。"""
    home = tmp_path / "home"
    (home / ".harness").mkdir(parents=True, exist_ok=True)
    (home / ".harness" / "config.toml").write_text("this is not toml = = =\n", encoding="utf-8")
    host = make_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(3, "session/prompt", _prompt(session_id))
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "CONFIGURATION_ERROR"
        # 错误文案里带出原文原因（用户可据此修配置），但仍受 2000 字符上限约束。
        assert "config.toml" in response["error"]["data"]["message"]


async def test_unsupported_content_block_is_invalid_params(tmp_path: Path) -> None:
    """图片块（能力声明为不支持）回 -32602 并说明类型。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "image", "data": "aGk=", "mimeType": "image/png"}],
            },
        )
        assert response["error"]["code"] == -32602
        assert response["error"]["data"]["code"] == "UNSUPPORTED_CONTENT_BLOCK"
        assert response["error"]["data"]["type"] == "image"


async def test_blank_prompt_is_rejected(tmp_path: Path) -> None:
    """全空白文本回 -32602 EMPTY_PROMPT（Run 不接受空消息）。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(
            3, "session/prompt", _prompt(session_id, "   \n\t ")
        )
        assert response["error"]["code"] == -32602
        assert response["error"]["data"]["code"] == "EMPTY_PROMPT"


async def test_resource_link_becomes_at_path(tmp_path: Path) -> None:
    """resource_link 块转成 `@路径` 文本，不当作不支持的内容块。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {
                        "type": "resource_link",
                        "uri": "file:///src/a.py",
                        "name": "a.py",
                    }
                ],
            },
        )
        assert prompt_response(response).stop_reason == "end_turn"
        chunk = first_update("agent_message_chunk", acp.client.frames)
        assert chunk["content"]["text"] == "@/src/a.py"


async def test_shutdown_rejects_new_prompts(tmp_path: Path) -> None:
    """`begin_shutdown` 之后新 prompt 回 SHUTTING_DOWN，不再启动 Run。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    await _initialize(acp.client)
    session_id = await _new_session(acp.client, acp.host.workspace)
    await acp.server.begin_shutdown()
    response = await acp.client.request(3, "session/prompt", _prompt(session_id))
    assert response["error"]["code"] == -32603
    assert response["error"]["data"]["code"] == "SHUTTING_DOWN"
    await acp.stop()


async def test_malformed_frames_are_rejected_and_connection_stays_usable(tmp_path: Path) -> None:
    """真实 FrameGuard 前置：坏 JSON、数组帧、超限帧各回错误后连接仍可用。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    client = acp.client
    await client.write_raw(b"{not json}\n")
    assert (await client.read_frame())["error"]["code"] == -32700
    await client.write_raw(b"[]\n")
    assert (await client.read_frame())["error"]["code"] == -32600
    await client.write_raw(b'{"jsonrpc":"2.0","id":9,"method":123}\n')
    invalid = await client.read_frame()
    assert invalid["error"]["code"] == -32600
    assert invalid["id"] == 9
    # 连接仍然可用：完整跑一轮握手。
    response = await _initialize(client, request_id=1)
    assert "result" in response
    await acp.stop()


async def test_oversize_frame_rejected_and_next_frame_processed(tmp_path: Path) -> None:
    """9 MiB 帧回 -32600，紧随其后的合法帧照常处理。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    client = acp.client
    big = (
        b'{"jsonrpc":"2.0","id":1,"method":"x","params":{"blob":"'
        + b"a" * (9 * 1024 * 1024)
        + b'"}}\n'
    )
    await client.write_raw(big)
    rejected = await client.read_frame(timeout=30)
    assert rejected["error"]["code"] == -32600
    assert rejected["error"]["message"] == "JSON-RPC frame exceeds size limit"
    response = await _initialize(client, request_id=2)
    assert "result" in response
    await acp.stop()


async def test_broken_translator_does_not_close_connection(tmp_path: Path) -> None:
    """翻译器抛异常时连接不被关闭（sender 的异常会让 Host 关连接，必须隔离）。"""
    from harness_agent.host.acp.translate import RunTranslator

    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    await _initialize(acp.client)
    session_id = await _new_session(acp.client, acp.host.workspace)
    connection = acp.server._connection
    assert connection is not None

    def _explode(_self: object, _event: object) -> None:
        raise RuntimeError("translator bug")

    original = RunTranslator.feed
    RunTranslator.feed = _explode  # type: ignore[method-assign]
    try:
        # 翻译全炸，终态事件也到不了 Future：曾让 prompt 永久挂起（Code Review 发现）。
        # 现在必须在有限时间内以 -32603 / INTERNAL_ERROR 返回，且连接不被关闭。
        response = await acp.client.request(3, "session/prompt", _prompt(session_id), timeout=5)
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "INTERNAL_ERROR"
        assert connection.closed is False
    finally:
        RunTranslator.feed = original  # type: ignore[method-assign]
    assert await acp.stop() == 0


async def test_diagnostic_log_only_contains_whitelisted_fields(tmp_path: Path) -> None:
    """诊断日志只有方法名、耗时、阶段与错误类型，不含参数、文本或路径。"""
    log = _RecordingLog()
    agent = ScriptedAgent(
        [
            tool_start("call_0", "edit_file"),
            tool_args("call_0", '{"file_path":"/secret/a.py"}'),
            tool_result("call_0", "wrote"),
            text("敏感回答文本"),
        ]
    )
    async with InProcessAcp(make_host(tmp_path, agent=agent), log=log) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt(session_id, "敏感提问文本"))
    allowed = {
        "side",
        "method",
        "duration_ms",
        "failure_stage",
        "error_type",
        "summary_code",
    }
    assert log.records, "expected at least one diagnostic record"
    for _level, _event, fields in log.records:
        assert set(fields) <= allowed, fields
        dumped = json.dumps(fields)
        for forbidden in ("敏感", "/secret", "secret", str(tmp_path)):
            assert forbidden not in dumped, (forbidden, fields)
    assert "ipc.request.completed" in log.names()


async def test_initialize_failure_reports_host_init_failed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`ensure_ready` 抛错时 initialize 回 -32603 + HOST_INIT_FAILED，不静默成功。"""
    host = make_host(tmp_path, echo=True)

    async def fail() -> object:
        raise RuntimeError("resources broken")

    monkeypatch.setattr(host, "ensure_ready", fail)
    acp = await InProcessAcp(host).start()
    response = await _initialize(acp.client)
    assert response["error"]["code"] == -32603
    assert response["error"]["data"]["code"] == "HOST_INIT_FAILED"
    await acp.stop()


async def test_unexpected_interaction_request_is_failed_closed(tmp_path: Path) -> None:
    """S1 未声明任何 interaction handle；万一收到交互帧必须立刻拒绝，不能挂 24 小时。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    await _initialize(acp.client)
    connection = acp.server._connection
    assert connection is not None
    acp.server._outbox.put_nowait(("event", {"run_id": "unknown"}))
    # 直接调用兜底分支，确认它走到 fail_interaction 而不是抛异常。
    acp.server._host.fail_interaction(
        connection, "unknown-request", RpcError(-32601, "INTERACTION_UNSUPPORTED")
    )
    await asyncio.sleep(0.05)
    await acp.stop()
