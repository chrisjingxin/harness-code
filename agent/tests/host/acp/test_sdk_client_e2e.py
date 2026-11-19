"""官方 SDK 客户端端到端：真实子进程跑完一轮 ACP 对话。

【为什么必须用官方客户端】
前面的测试都用裸行客户端，能验证线路字节，但不证明「一个真实的 ACP 客户端
能连上并正常使用」。这里用 `agent-client-protocol` 自带的 `spawn_agent_process`
起真实 `python -m harness_agent acp`，完成握手、建会话、发 prompt、收 update。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, cast

import pytest
from acp import spawn_agent_process
from acp.exceptions import RequestError
from acp.schema import (
    AcceptElicitationResponse,
    AgentMessageChunk,
    AllowedOutcome,
    AvailableCommandsUpdate,
    ClientCapabilities,
    CurrentModeUpdate,
    DeniedOutcome,
    ElicitationCapabilities,
    ElicitationFormCapabilities,
    PromptResponse,
    RequestPermissionResponse,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)

AGENT_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = AGENT_ROOT / "tests" / "support" / "acp_scripted_main.py"

PermissionPolicy = Callable[[Any, list[Any]], Awaitable[RequestPermissionResponse]]
"""权限请求回答策略：入参是（toolCall, options），出参是 SDK 的响应模型。"""


def _denied() -> RequestPermissionResponse:
    """客户端取消（用户关掉弹窗）。"""
    return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))


def _selected(option_id: str) -> RequestPermissionResponse:
    """客户端选了一个权限选项。"""
    return RequestPermissionResponse(
        outcome=AllowedOutcome(outcome="selected", option_id=option_id)
    )


def _policy(option_id: str) -> PermissionPolicy:
    """固定选某个选项的应答策略。"""

    async def respond(_tool_call: Any, _options: list[Any]) -> RequestPermissionResponse:
        return _selected(option_id)

    return respond


class _RecordingClient:
    """最小 ACP 客户端：记录 update，按注入的策略回答权限请求。"""

    def __init__(self, policy: PermissionPolicy | None = None) -> None:
        """`policy=None` 时一律回 cancelled（S1 的默认行为）。"""
        self.updates: list[Any] = []
        self.permission_requests: list[tuple[str, Any, list[Any]]] = []
        self.forms: list[tuple[str, Any]] = []
        self._policy = policy

    async def session_update(self, session_id: str, update: Any, **_kwargs: Any) -> None:
        """记录一条 session/update。"""
        self.updates.append(update)

    async def request_permission(
        self, session_id: str, tool_call: Any, options: list[Any], **_kwargs: Any
    ) -> RequestPermissionResponse:
        """记录权限请求，并按策略回答。"""
        self.permission_requests.append((session_id, tool_call, options))
        if self._policy is None:
            return _denied()
        return await self._policy(tool_call, options)

    async def read_text_file(self, session_id: str, path: str, **_kwargs: Any) -> Any:
        """S1 不使用客户端文件系统能力。"""
        raise AssertionError("agent must not read files through the client")

    async def write_text_file(
        self, session_id: str, path: str, content: str, **_kwargs: Any
    ) -> Any:
        """S1 不使用客户端文件系统能力。"""
        raise AssertionError("agent must not write files through the client")

    async def create_elicitation(self, message: str, mode: Any, **_kwargs: Any) -> AcceptElicitationResponse:
        """按表单字段回答：提问选「甲」，计划选批准。测的是协议，不是表单渲染。"""
        self.forms.append((message, mode))
        names = set(_form_properties(mode))
        if "decision" in names:
            content = {"decision": "approved", "feedback": ""}
        elif "q_0" in names:
            content = {"q_0": "甲"}
        else:
            raise AssertionError(f"unexpected form fields: {sorted(names)}")
        return AcceptElicitationResponse(action="accept", content=content)

    async def complete_elicitation(self, _elicitation_id: str, **_kwargs: Any) -> None:
        """表单结束通知。这条链路不靠它判断结果。"""

    def on_connect(self, _conn: object) -> None:
        """SDK 建立连接时回调；这里不需要额外状态。"""


def _child_env(home: Path) -> dict[str, str]:
    """构造子进程环境：隔离 HOME，注入包路径与 echo 模式。"""
    return {
        **os.environ,
        "HOME": str(home),
        "PYTHONPATH": str(AGENT_ROOT),
        "HARNESS_ECHO_MODE": "1",
    }


def _scenario_env(home: Path, scenario: str, workspace: Path) -> dict[str, str]:
    """构造跑真实场景的环境：**不开 echo**（echo 没有线程存储，也不能弹审批）。"""
    env = _child_env(home)
    env.pop("HARNESS_ECHO_MODE", None)
    env.update({"ACP_SCENARIO": scenario, "ACP_WORKSPACE": str(workspace)})
    return env


@contextlib.asynccontextmanager
async def _scenario_session(
    scenario: str,
    tmp_path: Path,
    client: _RecordingClient,
    *,
    capabilities: ClientCapabilities | None = None,
    unstable: bool = False,
) -> AsyncIterator[tuple[Any, Any, str, Path]]:
    """起场景子进程 → 握手 → 建会话；退出时断言进程以 0 退出。

    `unstable=True` 才接收 `elicitation/create`。官方 SDK 默认把这个方法当成
    未稳定协议，不打开时直接回 method not found，表单到不了测试客户端。
    """
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir(exist_ok=True)
    workspace.mkdir(exist_ok=True)
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=_scenario_env(home, scenario, workspace),
        cwd=str(workspace),
        use_unstable_protocol=unstable,
    ) as (connection, process):
        await connection.initialize(
            protocol_version=1, client_capabilities=capabilities
        )
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        yield connection, session, str(workspace), workspace
    # 上下文退出后 SDK 会关 stdin：进程必须在宽限期内以 0 退出，不能挂住。
    # 必须在 `async with` 之外等：块内 stdin 还开着，进程不会结束。
    await asyncio.wait_for(process.wait(), timeout=15)
    assert process.returncode == 0


def _texts(client: _RecordingClient) -> list[str]:
    """收集客户端收到的正文片段。"""
    return [
        update.content.text
        for update in client.updates
        if isinstance(update, AgentMessageChunk) and hasattr(update.content, "text")
    ]


def _statuses(client: _RecordingClient, card_id: str) -> list[str]:
    """收集某张工具卡的流转状态。"""
    return [
        update.status
        for update in client.updates
        if isinstance(update, ToolCallProgress)
        and update.tool_call_id == card_id
        and update.status is not None
    ]


def _form_properties(mode: Any) -> dict[str, Any]:
    """取出表单 schema 的字段表。模式对象和包一层的 root 都认。"""
    schema = getattr(mode, "requested_schema", None)
    if schema is None:
        schema = getattr(getattr(mode, "root", None), "requested_schema", None)
    properties = getattr(schema, "properties", None)
    return properties if isinstance(properties, dict) else {}


def _model_option(options: list[Any]) -> Any:
    """从配置项列表里取出 model。"""
    return next(item for item in options if item.id == "model")


def _all_frame_text(client: _RecordingClient, *extra: Any) -> str:
    """把客户端看到的更新、权限、表单和额外响应序列化，用来确认没有扩展字段。"""
    dumped: list[Any] = [
        update.model_dump(mode="json", by_alias=True) for update in client.updates
    ]
    dumped.extend(
        tool_call.model_dump(mode="json", by_alias=True)
        for _session_id, tool_call, _options in client.permission_requests
    )
    dumped.extend(
        {
            "message": message,
            "mode": mode.model_dump(mode="json", by_alias=True)
            if hasattr(mode, "model_dump")
            else str(mode),
        }
        for message, mode in client.forms
    )
    for item in extra:
        if hasattr(item, "model_dump"):
            dumped.append(item.model_dump(mode="json", by_alias=True))
    return json.dumps(dumped, ensure_ascii=False, default=str)



def test_sdk_version_is_pinned_release() -> None:
    """SDK 版本必须与设计文档锁定的一致；缺包或漂移都应当立刻失败。"""
    import importlib.metadata

    assert importlib.metadata.version("agent-client-protocol") == "0.12.1"


async def test_real_entrypoint_completes_one_round_through_sdk_client(tmp_path: Path) -> None:
    """真实入口：initialize → session/new → session/prompt → update + end_turn。"""
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    async with spawn_agent_process(
        # 测试客户端只实现本用例会走到的方法；`cast` 明确表示不满足完整 Client 协议。
        cast(Any, client),
        sys.executable,
        "-m",
        "harness_agent",
        "acp",
        env=_child_env(home),
        cwd=str(workspace),
    ) as (connection, process):
        init = await connection.initialize(protocol_version=1)
        assert init.protocol_version == 1
        assert init.agent_info is not None and init.agent_info.name == "harness-code"
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="你好")],
        )
        assert response.stop_reason == "end_turn"
        chunks = [update for update in client.updates if isinstance(update, AgentMessageChunk)]
        assert chunks, client.updates
        assert chunks[0].content.text == "你好"
        assert str(chunks[0].message_id).endswith(":m0")
        assert client.permission_requests == []
    # 上下文退出后 SDK 会关 stdin；进程必须在宽限期内以 0 退出，不能挂住。
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_host_scenario_streams_text_in_echo_mode(tmp_path: Path) -> None:
    """真实 Host 的 echo 场景：只有文字事件，走同一套 stdio 服务层。

    注意：echo 模式不产生工具事件，所以这里不断言工具卡；工具卡由下面的 `tools` 场景覆盖。
    """
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "host"}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="写点东西")],
        )
        assert response.stop_reason == "end_turn"
        chunks = [u for u in client.updates if isinstance(u, AgentMessageChunk)]
        assert chunks and chunks[0].content.text == "写点东西"
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_streams_tool_card_through_official_client(tmp_path: Path) -> None:
    """tools 场景：官方 SDK 客户端必须真的收到 tool_call → tool_call_update(completed) 再收到文字。

    Code Review 指出原用例在 echo 模式下 `tool_cards` 恒为空，断言是永真的。
    """
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "tools", "ACP_WORKSPACE": str(workspace)}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="读一下 note.txt")],
        )
        assert response.stop_reason == "end_turn"
        starts = [u for u in client.updates if isinstance(u, ToolCallStart)]
        progress = [u for u in client.updates if isinstance(u, ToolCallProgress)]
        assert len(starts) == 1, client.updates
        assert starts[0].kind == "read" and starts[0].status == "pending"
        assert starts[0].tool_call_id.endswith(":call_0")
        assert any(p.tool_call_id == starts[0].tool_call_id and p.status == "completed" for p in progress)
        texts = [u.content.text for u in client.updates if isinstance(u, AgentMessageChunk)]
        assert "读完了" in texts
        # 工具卡必须出现在最终文字之前：客户端按到达顺序渲染。
        order = [type(u).__name__ for u in client.updates]
        assert order.index("ToolCallStart") < order.index("AgentMessageChunk")
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_stub_block_scenario_cancels_and_exits_cleanly(tmp_path: Path) -> None:
    """block 场景（传输层 stub，不是真实 AcpServer）：cancel 后拿到 cancelled，进程正常退出。

    名字不再声称「恢复」：取消后再发 prompt 的恢复由 `test_server_cancel.py` 用真实
    AcpServer 覆盖。"""
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "block"}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        task = asyncio.create_task(
            connection.prompt(
                session_id=session.session_id,
                prompt=[TextContentBlock(type="text", text="长时间任务")],
            )
        )
        # 等到第一条 update，确认 prompt 已被处理。
        for _ in range(400):
            if client.updates:
                break
            await asyncio.sleep(0.01)
        assert client.updates
        await connection.cancel(session_id=session.session_id)
        response = await asyncio.wait_for(task, timeout=20)
        assert response.stop_reason == "cancelled"
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


@pytest.mark.skipif(os.name == "nt", reason="POSIX 专用入口")
async def test_real_entrypoint_exits_two_for_bad_arguments(tmp_path: Path) -> None:
    """`acp` 后跟多余参数：spawn 成功但进程以 2 退出，不进入协议循环。"""
    home = tmp_path / "home"
    home.mkdir()
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "harness_agent",
        "acp",
        "--cwd",
        str(tmp_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=_child_env(home),
        cwd=str(tmp_path),
    )
    assert process.stdin is not None
    process.stdin.close()
    stderr = await asyncio.wait_for(process.stderr.read(), timeout=20)  # type: ignore[union-attr]
    await asyncio.wait_for(process.wait(), timeout=20)
    assert process.returncode == 2
    assert "Usage" in stderr.decode("utf-8", "replace")


# —— 2.8：真实子进程 + 官方 SDK 客户端的完整场景 ——


async def test_sdk_client_rejects_a_tool_once(tmp_path: Path) -> None:
    """拒绝一次：`stopReason=end_turn`，工具卡最终 `failed`，权限请求挂在已有卡片上。"""
    client = _RecordingClient(_policy("reject"))
    async with _scenario_session("approval", tmp_path, client) as (connection, session, _ws, _root):
        response: PromptResponse = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="跑测试")],
        )
    assert response.stop_reason == "end_turn"
    starts = [update for update in client.updates if isinstance(update, ToolCallStart)]
    assert len(starts) == 1, client.updates
    card_id = starts[0].tool_call_id
    assert client.permission_requests, client.updates
    _session_id, tool_call, options = client.permission_requests[0]
    assert tool_call.tool_call_id == card_id
    assert [option.option_id for option in options] == [
        "approve_once",
        "approve_thread",
        "approve_project",
        "reject",
    ]
    assert _statuses(client, card_id)[-1] == "failed"
    assert "已拒绝" in _texts(client)
    # 没声明 `_meta.harnessCode`：整条连接任何一帧都不含该字样。
    assert "harnessCode" not in _all_frame_text(client)


async def test_sdk_client_allows_a_tool_once(tmp_path: Path) -> None:
    """允许一次：卡片 `in_progress` → `completed`，随后出现正文。"""
    client = _RecordingClient(_policy("approve_once"))
    async with _scenario_session("approval", tmp_path, client) as (connection, session, _ws, _root):
        response: PromptResponse = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="跑测试")],
        )
    assert response.stop_reason == "end_turn"
    starts = [update for update in client.updates if isinstance(update, ToolCallStart)]
    assert len(starts) == 1, client.updates
    card_id = starts[0].tool_call_id
    assert _statuses(client, card_id)[-2:] == ["in_progress", "completed"]
    assert "批准后继续" in _texts(client)
    assert "harnessCode" not in _all_frame_text(client)


@pytest.mark.parametrize(
    ("option_id", "expected_text", "expected_status"),
    [("allow_session", "信任已登记", "completed"), ("deny", "已拒绝信任", "failed")],
)
async def test_sdk_client_grants_directory_trust(
    tmp_path: Path, option_id: str, expected_text: str, expected_status: str
) -> None:
    """目录授权：允许 → 信任卡片 `completed`；拒绝 → `failed`；分支文案不同。"""
    client = _RecordingClient(_policy(option_id))
    async with _scenario_session("trust", tmp_path, client) as (connection, session, _ws, _root):
        response: PromptResponse = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="看看外部目录")],
        )
    assert response.stop_reason == "end_turn"
    assert client.permission_requests, client.updates
    _session_id, tool_call, options = client.permission_requests[0]
    assert tool_call.tool_call_id.startswith("trust:")
    # 写工具 → `edit`（§4.2 的类别规则）。
    assert tool_call.kind == "edit"
    assert [option.option_id for option in options] == ["allow_session", "deny"]
    assert _statuses(client, tool_call.tool_call_id) == [expected_status]
    assert expected_text in _texts(client)


async def test_sdk_client_runs_slash_command(tmp_path: Path) -> None:
    """`/命令`：命令列表里有插件命令，`/名称 参数` 的 prompt 正常完成。"""
    client = _RecordingClient()
    async with _scenario_session("commands", tmp_path, client) as (connection, session, _ws, _root):
        names: list[str] = []
        for _ in range(300):
            names = [
                command.name
                for update in client.updates
                if isinstance(update, AvailableCommandsUpdate)
                for command in update.available_commands
            ]
            if names:
                break
            await asyncio.sleep(0.01)
        assert any(name.endswith(":audit") for name in names), names
        name = next(name for name in names if name.endswith(":audit"))
        response: PromptResponse = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text=f"/{name} 这些文件")],
        )
    assert response.stop_reason == "end_turn"
    assert "命令完成" in _texts(client)


async def test_sdk_client_lists_and_loads_a_session(tmp_path: Path) -> None:
    """列出并恢复会话：先回放历史，再返回带四个模式的响应。"""
    client = _RecordingClient()
    async with _scenario_session("history", tmp_path, client) as (connection, session, ws, _root):
        listing = await connection.list_sessions(cwd=ws)
        loaded = await connection.load_session(
            cwd=ws, session_id="history-seed", mcp_servers=[]
        )
    assert [item.session_id for item in listing.sessions] == ["history-seed"]
    assert listing.sessions[0].title == "先看一眼"
    assert "next_cursor" not in listing.model_fields_set or listing.next_cursor is None
    assert loaded.modes is not None
    assert [mode.id for mode in loaded.modes.available_modes] == [
        "default",
        "auto-edit",
        "auto",
        "yolo",
    ]
    # 回放在响应之前到达：客户端在 load 返回时就已收齐三类历史。
    # session/new 后的命令表总推送与回放无关，先剔掉再核对回放三类。
    replay_updates = [
        update
        for update in client.updates
        if type(update).__name__ != "AvailableCommandsUpdate"
    ]
    kinds = [type(update).__name__ for update in replay_updates]
    assert kinds == ["UserMessageChunk", "AgentMessageChunk", "ToolCallStart"]
    assert replay_updates[0].message_id == "history-seed:h0"
    assert replay_updates[2].tool_call_id == "history-seed:h2"


async def test_sdk_client_cancels_while_approval_is_pending(tmp_path: Path) -> None:
    """审批挂起时中途取消：`prompt` 返回 `cancelled`，进程正常退出。"""
    release = asyncio.Event()

    async def policy(_tool_call: Any, _options: list[Any]) -> RequestPermissionResponse:
        await release.wait()
        return _denied()

    client = _RecordingClient(policy)
    async with _scenario_session("approval", tmp_path, client) as (
        connection,
        session,
        _ws,
        _root,
    ):
        task = asyncio.create_task(
            connection.prompt(
                session_id=session.session_id,
                prompt=[TextContentBlock(type="text", text="跑测试")],
            )
        )
        for _ in range(600):
            if client.permission_requests:
                break
            await asyncio.sleep(0.01)
        assert client.permission_requests
        await connection.cancel(session_id=session.session_id)
        release.set()
        response = await asyncio.wait_for(task, timeout=20)
    assert response.stop_reason == "cancelled"


async def test_sdk_client_negotiates_extension(tmp_path: Path) -> None:
    """声明扩展：握手回报能力，审批带 `_meta.harnessCode.approval`，完成响应带 `run`。"""
    client = _RecordingClient(_policy("approve_once"))
    capabilities = ClientCapabilities(
        field_meta={
            "harnessCode": {"version": 1, "capabilities": ["approval", "runSummary"]}
        }
    )
    async with _scenario_session(
        "approval", tmp_path, client, capabilities=capabilities
    ) as (connection, session, _ws, _root):
        response: PromptResponse = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="跑测试")],
        )
    assert client.permission_requests, client.updates
    _session_id, tool_call, _options = client.permission_requests[0]
    approval = tool_call.field_meta["harnessCode"]["approval"]
    assert approval["type"] == "approval"
    assert approval["requestId"]
    assert response.field_meta is not None
    run_summary = response.field_meta["harnessCode"]["run"]
    assert isinstance(run_summary.get("duration_ms"), int)


def _form_capabilities() -> ClientCapabilities:
    """只声明会画表单，不声明 `_meta.harnessCode`。"""
    return ClientCapabilities(
        elicitation=ElicitationCapabilities(form=ElicitationFormCapabilities())
    )


async def _prompt(connection: Any, session_id: str, content: str) -> PromptResponse:
    """发一轮用户文本。"""
    return await connection.prompt(
        session_id=session_id,
        prompt=[TextContentBlock(type="text", text=content)],
    )


async def test_sdk_client_without_extensions_walks_question_plan_model_cancel_and_resume(
    tmp_path: Path,
) -> None:
    """不声明扩展、但声明 elicitation.form：提问、计划、切模型、取消、resume 都能走完。

    出站帧里不能出现 harnessCode。扩展只加显示，不参与这条必需流程。
    """
    client = _RecordingClient()
    async with _scenario_session(
        "journey",
        tmp_path,
        client,
        capabilities=_form_capabilities(),
        unstable=True,
    ) as (connection, session, _ws, workspace):
        mode_ids = [mode.id for mode in session.modes.available_modes]
        assert "plan" in mode_ids
        mode_before_plan = session.modes.current_mode_id
        asked = await _prompt(connection, session.session_id, "请提问")
        assert asked.stop_reason == "end_turn"
        assert client.forms, "提问必须走出表单"
        await connection.set_session_mode(mode_id="plan", session_id=session.session_id)
        planned = await _prompt(connection, session.session_id, "请出计划")
        assert planned.stop_reason == "end_turn"
        changed = await connection.set_config_option(
            config_id="model", session_id=session.session_id, value="slow"
        )
        assert _model_option(changed.config_options).current_value == "slow"
        blocking = asyncio.create_task(_prompt(connection, session.session_id, "请卡住"))
        for _ in range(600):
            if "开始卡住" in _texts(client):
                break
            await asyncio.sleep(0.01)
        assert "开始卡住" in _texts(client)
        await connection.cancel(session_id=session.session_id)
        cancelled = await asyncio.wait_for(blocking, timeout=20)
        assert cancelled.stop_reason == "cancelled"
        before_resume = len(client.updates)
        resumed = await connection.resume_session(cwd=str(workspace), session_id=session.session_id)
    assert "已回答：甲" in _texts(client)
    assert "计划approved" in _texts(client)
    mode_updates = [
        mode.current_mode_id for mode in client.updates if isinstance(mode, CurrentModeUpdate)
    ]
    assert mode_updates[-1] == mode_before_plan
    profiles = (workspace / "run-profiles.txt").read_text(encoding="utf-8").splitlines()
    assert profiles[-1] == "slow"
    assert resumed.modes is not None
    replay = client.updates[before_resume:]
    assert replay
    assert all(isinstance(update, AvailableCommandsUpdate) for update in replay)
    assert "harnessCode" not in _all_frame_text(client, session, asked, planned, changed, cancelled, resumed)


async def test_sdk_client_without_forms_refuses_plan_and_still_switches_cancels_and_resumes(
    tmp_path: Path,
) -> None:
    """什么能力都不声明：提问不会挂起，计划模式被拒绝，切模型、取消、resume 仍能走完。

    没声明 elicitation.form 时不提供计划模式，提问也不会交给用户填。
    这两步按「明确拒绝」走完，而不是停在一张出不来的表单上。
    """
    client = _RecordingClient()
    async with _scenario_session("journey", tmp_path, client) as (
        connection,
        session,
        _ws,
        workspace,
    ):
        mode_ids = [mode.id for mode in session.modes.available_modes]
        assert "plan" not in mode_ids
        asked = await _prompt(connection, session.session_id, "请提问")
        assert asked.stop_reason == "end_turn"
        assert client.forms == []
        with pytest.raises(RequestError) as raised:
            await connection.set_session_mode(mode_id="plan", session_id=session.session_id)
        assert raised.value.data["code"] == "UNKNOWN_MODE"
        changed = await connection.set_config_option(
            config_id="model", session_id=session.session_id, value="slow"
        )
        assert _model_option(changed.config_options).current_value == "slow"
        blocking = asyncio.create_task(_prompt(connection, session.session_id, "请卡住"))
        for _ in range(600):
            if "开始卡住" in _texts(client):
                break
            await asyncio.sleep(0.01)
        assert "开始卡住" in _texts(client)
        await connection.cancel(session_id=session.session_id)
        cancelled = await asyncio.wait_for(blocking, timeout=20)
        assert cancelled.stop_reason == "cancelled"
        before_resume = len(client.updates)
        resumed = await connection.resume_session(cwd=str(workspace), session_id=session.session_id)
    assert any("当前客户端不支持提问" in text for text in _texts(client))
    profiles = (workspace / "run-profiles.txt").read_text(encoding="utf-8").splitlines()
    assert profiles[-1] == "slow"
    assert resumed.modes is not None
    assert "plan" not in [mode.id for mode in resumed.modes.available_modes]
    replay = client.updates[before_resume:]
    assert replay
    assert all(isinstance(update, AvailableCommandsUpdate) for update in replay)
    assert "harnessCode" not in _all_frame_text(client, session, asked, changed, cancelled, resumed)
