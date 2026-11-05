"""v3 行为特征化测试：重构前先固化「现有可观察行为」，供 0.8 到 0.12 抽取服务面时对照。

【这是做什么的？】
本文件只在现有生产代码上读取和断言，不改任何实现。它覆盖 AgentHost 的 v3 JSON-RPC
面里最容易被「抽服务方法」这一步改坏的五类不变量：

1. run.start 的响应先于第一个事件（客户端依赖这个顺序渲染）；
2. 取消只有一个终态事件，之后同一条 Thread 能立刻受理新 Run；
3. 连接断开时，它拥有的 Run 被取消、挂起审批的 Future 被清空并降级为默认拒绝；
4. 审批 fail-closed 矩阵：能力未声明、连接已关闭、超时、客户端结果不合法，都按保守拒绝；
5. 初始化门槛矩阵、run.start 前置校验顺序与副作用、initialize 响应形状、资源只初始化一次；
6. threads.watch / commands.bind / 对端 response 三个小矩阵。

【上下游】
上游是测试直接调用 `AgentHost.dispatch` / `dispatch_connection`，与真实 stdio 循环共用同一条
`_dispatch_current` 校验链；下游只读 `AgentHost` 的公开与既有私有 seam（`send`、`create_connection`、
`_run_coordinator._interaction_port`）。0.8 之后新增的服务方法必须保持这里断言的全部行为。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from tests.support.thread_fixtures import accept_thread

# ---------------------------------------------------------------------------
# 共享工具：与 tests/host/test_server.py 的帧构造保持一致，但独立定义避免互相耦合。
# ---------------------------------------------------------------------------


def _request(method: str, params: dict[str, Any], request_id: str) -> dict[str, Any]:
    """构造最小 JSON-RPC request，形状与 stdio wire 完全一致。"""
    return {"jsonrpc": "2.0", "method": method, "params": params, "id": request_id}


def _initialize_params(
    capabilities: list[str] | None = None,
    *,
    handles: list[str] | None = None,
    max_minor: int = 8,
) -> dict[str, Any]:
    """构造 initialize 参数；handles 显式传入，避免从 capability 名字反推。"""
    return {
        "protocol": {"major": 3, "min_minor": 0, "max_minor": max_minor},
        "client": {"name": "characterization", "version": "0.1.0", "kind": "test"},
        "capabilities": {
            "requests": list(capabilities or []),
            "handles": list(handles or []),
        },
    }


async def _attach_owner_frames(host: Any) -> list[dict[str, Any]]:
    """把 owner 的 stdout seam 替换成捕获列表，并原样返回该列表。"""
    frames: list[dict[str, Any]] = []

    async def capture(message: dict[str, Any]) -> None:
        frames.append(message)

    host.send = capture
    return frames


async def _capture_owner(
    host: Any,
    capabilities: list[str] | None = None,
    *,
    handles: list[str] | None = None,
    max_minor: int = 8,
) -> list[dict[str, Any]]:
    """捕获 owner 帧并完成一次 initialize。"""
    frames = await _attach_owner_frames(host)
    await host.dispatch(
        _request(
            "initialize",
            _initialize_params(capabilities, handles=handles, max_minor=max_minor),
            "init",
        )
    )
    return frames


async def _wait_for(
    frames: list[dict[str, Any]],
    predicate: Any,
    *,
    skip: int = 0,
    attempts: int = 400,
) -> dict[str, Any]:
    """轮询等待第 skip+1 个匹配帧；超时带上已收帧便于定位。"""
    for _ in range(attempts):
        matched = [frame for frame in frames if predicate(frame)]
        if len(matched) > skip:
            return matched[skip]
        await asyncio.sleep(0.01)
    raise AssertionError(f"Timed out; received: {frames}")


def _event_types(frames: list[dict[str, Any]]) -> list[str]:
    """按到达顺序列出事件类型。"""
    return [frame["params"]["type"] for frame in frames if frame.get("method") == "event"]


def _event_count(frames: list[dict[str, Any]], event_type: str) -> int:
    """统计某类事件出现次数，用于断言「恰好一个终态事件」。"""
    return sum(1 for frame in frames if frame.get("params", {}).get("type") == event_type)


def _frame_index(frames: list[dict[str, Any]], predicate: Any) -> int:
    """返回第一个匹配帧的下标；没有就抛断言错误。"""
    for index, frame in enumerate(frames):
        if predicate(frame):
            return index
    raise AssertionError(f"Frame not found; received: {frames}")


class _BlockingAgent:
    """保持一个可观察的 active Run，直到测试取消它。"""

    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def astream(self, *_args: Any, **_kwargs: Any):
        self.started.set()
        await asyncio.Event().wait()
        if False:  # pragma: no cover - 只为让它成为 async generator
            yield None


# ---------------------------------------------------------------------------
# 1. run.start 的响应先于事件，且事件序号单调。
# ---------------------------------------------------------------------------


async def test_run_start_response_precedes_first_event(tmp_path: Path) -> None:
    """响应帧下标必须小于第一个 run.started 事件帧，事件序号从 1 连续递增。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, ["run.multithread"])
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "hello"},
                "thread_id": "order-thread",
                "run_id": "order-run",
            },
            "order-start",
        )
    )
    await _wait_for(frames, lambda f: f.get("params", {}).get("type") == "run.completed")

    response_index = _frame_index(frames, lambda f: f.get("id") == "order-start")
    first_event_index = _frame_index(
        frames, lambda f: f.get("params", {}).get("type") == "run.started"
    )
    assert response_index < first_event_index
    sequences = [
        frame["params"]["sequence"] for frame in frames if frame.get("method") == "event"
    ]
    assert sequences == list(range(1, len(sequences) + 1))
    await host.close()


# ---------------------------------------------------------------------------
# 2. 取消：单一终态，且同一条 Thread 立刻可以受理新 Run。
# ---------------------------------------------------------------------------


async def test_cancel_emits_one_terminal_event_and_releases_thread(tmp_path: Path) -> None:
    """取消只产生一个 run.cancelled，之后同一 thread 接受新的 run_id。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, ["run.cancel", "run.multithread"])
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "slow"},
                "thread_id": "cancel-thread",
                "run_id": "cancel-run-1",
            },
            "cancel-start-1",
        )
    )
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    await host.dispatch(
        _request(
            "run.cancel",
            {"thread_id": "cancel-thread", "run_id": "cancel-run-1"},
            "cancel-1",
        )
    )
    cancel_frame = await _wait_for(frames, lambda f: f.get("id") == "cancel-1")
    assert cancel_frame["result"] == {"cancelled": True, "run_id": "cancel-run-1"}
    await _wait_for(frames, lambda f: _event_count(frames, "run.cancelled") == 1)
    # 终态事件是排他的：不会同时出现 completed / failed。
    assert _event_count(frames, "run.completed") == 0
    assert _event_count(frames, "run.failed") == 0

    agent.started.clear()
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "again"},
                "thread_id": "cancel-thread",
                "run_id": "cancel-run-2",
            },
            "cancel-start-2",
        )
    )
    restarted = await _wait_for(frames, lambda f: f.get("id") == "cancel-start-2")
    assert restarted["result"]["accepted"] is True
    assert restarted["result"]["run_id"] == "cancel-run-2"
    await host.close()


# ---------------------------------------------------------------------------
# 3. 断连：Run 被取消、挂起审批清空、适配器拿到默认拒绝。
# ---------------------------------------------------------------------------


async def test_close_connection_cancels_run_and_fails_pending_approval(
    tmp_path: Path,
) -> None:
    """连接关闭后，它拥有的 Run 被取消，挂起审批 Future 清空且降级为默认拒绝。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef
    from harness_agent.runtime.interactions import InteractionRequest

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    await _attach_owner_frames(host)
    await host.dispatch(_request("initialize", _initialize_params(["run.cancel"]), "owner-init"))

    connection_frames: list[dict[str, Any]] = []

    async def send_connection(message: dict[str, Any]) -> None:
        connection_frames.append(message)

    # run.start 是受控操作，必须先登记 attachment 并取得 control permit，
    # 否则会被 CONTROL_NOT_HOLDER 拦截而根本不会启动 Run。
    connection = host.create_connection(send_connection, attachment_id="att-disconnect")
    await host.dispatch_connection(
        connection,
        _request(
            "initialize",
            _initialize_params(
                ["host.control", "run.cancel"], handles=["approval"]
            ),
            "conn-init",
        ),
    )
    await host.dispatch_connection(
        connection, _request("host.control.acquire", {}, "conn-acquire")
    )
    await host.dispatch_connection(
        connection,
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "slow"},
                "thread_id": "disconnect-thread",
                "run_id": "disconnect-run",
            },
            "conn-start",
        ),
    )
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    # 模拟一个正在等客户端点击的审批：适配器登记 Future 后一定会收到请求帧。
    pending = asyncio.create_task(
        host._run_coordinator._interaction_port.request(
            ConnectionRef(connection.connection_id),
            RunRef(thread_id="disconnect-thread", run_id="disconnect-run"),
            InteractionRequest(
                request_id="approval-pending",
                type="approval",
                payload={"interrupt_id": "approval-pending", "description": "", "requests": [], "decisions": []},
                interrupt_id="approval-pending",
            ),
        )
    )
    await _wait_for(
        connection_frames, lambda f: f.get("method") == "interaction.approval"
    )
    assert "approval-pending" in connection.pending_requests

    await host.close_connection(connection)
    result = await asyncio.wait_for(pending, timeout=2)

    assert connection.closed is True
    assert connection.pending_requests == {}
    assert connection.interaction_specs == {}
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert await host._run_coordinator.is_active("disconnect-thread") is False
    await host.close()


# ---------------------------------------------------------------------------
# 4. 审批 fail-closed 矩阵。
# ---------------------------------------------------------------------------


def _approval_request(request_id: str) -> Any:
    """构造一个审批类交互请求；payload 不参与 fail-closed 判定。"""
    from harness_agent.runtime.interactions import InteractionRequest

    return InteractionRequest(
        request_id=request_id,
        type="approval",
        payload={
            "interrupt_id": request_id,
            "description": "",
            "requests": [],
            "decisions": ["approve_once", "reject"],
        },
        interrupt_id=request_id,
    )


def _directory_trust_request(request_id: str) -> Any:
    """构造目录信任交互请求，默认值必须是 deny。"""
    from harness_agent.runtime.interactions import InteractionRequest

    return InteractionRequest(
        request_id=request_id,
        type="directory_trust",
        payload={
            "interrupt_id": request_id,
            "directory": "outside-dir",
            "target_path": "outside-dir/a.txt",
            "tool_name": "read_file",
            "access": "read",
            "shadows_workspace": False,
            "decisions": ["allow_session", "deny"],
        },
        interrupt_id=request_id,
    )


async def test_approval_fails_closed_when_handle_not_declared(tmp_path: Path) -> None:
    """未声明 approval handle 时不发任何反向请求，直接返回 reject。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], handles=[])

    result = await host._run_coordinator._interaction_port.request(
        ConnectionRef(host._owner_connection.connection_id),
        RunRef(thread_id="fc-thread", run_id="fc-run"),
        _approval_request("fc-undeclared"),
    )
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert not any(
        str(frame.get("method", "")).startswith("interaction.") for frame in frames
    )
    await host.close()


async def test_approval_fails_closed_when_connection_closed(tmp_path: Path) -> None:
    """连接已关闭时不再向已断开通道写帧，返回 reject。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    await _attach_owner_frames(host)
    await host.dispatch(_request("initialize", _initialize_params([]), "owner-init"))

    connection_frames: list[dict[str, Any]] = []

    async def send_connection(message: dict[str, Any]) -> None:
        connection_frames.append(message)

    connection = host.create_connection(send_connection, role="owner")
    connection.interaction_handles = {"approval"}
    connection.closed = True

    result = await host._run_coordinator._interaction_port.request(
        ConnectionRef(connection.connection_id),
        RunRef(thread_id="fc-thread", run_id="fc-run"),
        _approval_request("fc-closed"),
    )
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert connection_frames == []
    await host.close()


async def test_approval_fails_closed_on_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """客户端不回应时按 INTERACTION_TIMEOUT_MS 超时并返回默认拒绝。"""
    from harness_agent.host import connection as connection_module
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    monkeypatch.setattr(connection_module, "INTERACTION_TIMEOUT_MS", 50)
    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    await _attach_owner_frames(host)
    await host.dispatch(_request("initialize", _initialize_params([]), "owner-init"))

    connection_frames: list[dict[str, Any]] = []

    async def send_connection(message: dict[str, Any]) -> None:
        connection_frames.append(message)

    connection = host.create_connection(send_connection, role="owner")
    connection.interaction_handles = {"approval"}

    result = await host._run_coordinator._interaction_port.request(
        ConnectionRef(connection.connection_id),
        RunRef(thread_id="fc-thread", run_id="fc-run"),
        _approval_request("fc-timeout"),
    )
    assert [frame["method"] for frame in connection_frames] == [
        "interaction.approval"
    ]
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert connection.pending_requests == {}
    await host.close()


async def test_directory_trust_fails_closed_to_deny(tmp_path: Path) -> None:
    """目录信任未声明 handle 时的默认值是 deny，不是 reject。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    await _capture_owner(host, [], handles=[])

    result = await host._run_coordinator._interaction_port.request(
        ConnectionRef(host._owner_connection.connection_id),
        RunRef(thread_id="fc-thread", run_id="fc-run"),
        _directory_trust_request("dt-undeclared"),
    )
    assert result.value == {"decision": "deny"}
    assert result.expired is True
    await host.close()


async def test_approval_fails_closed_on_invalid_client_result(tmp_path: Path) -> None:
    """客户端回了 schema 不合法结果时不发错误帧，Future 以 RpcError 失败并降级为拒绝。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], handles=["approval"])

    pending = asyncio.create_task(
        host._run_coordinator._interaction_port.request(
            ConnectionRef(host._owner_connection.connection_id),
            RunRef(thread_id="fc-thread", run_id="fc-run"),
            _approval_request("fc-invalid"),
        )
    )
    await _wait_for(frames, lambda f: f.get("method") == "interaction.approval")
    future = host._owner_connection.pending_requests["fc-invalid"]
    await host.dispatch(
        {"jsonrpc": "2.0", "id": "fc-invalid", "result": {"decision": "bogus"}}
    )
    # 结果不合法时只让 Future 失败，不回错误帧。
    assert [frame for frame in frames if "error" in frame] == []
    with pytest.raises(Exception) as excinfo:
        await asyncio.wait_for(asyncio.shield(future), timeout=1)
    assert "Invalid interaction response" in str(excinfo.value)

    result = await asyncio.wait_for(pending, timeout=2)
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    await host.close()


# ---------------------------------------------------------------------------
# 5. 初始化门槛与能力门槛矩阵。
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("run.start", {"mode": "build", "input": {"kind": "user", "message": "x"}, "thread_id": "t", "run_id": "r"}),
        ("run.cancel", {"thread_id": "t", "run_id": "r"}),
        ("threads.list", {}),
        ("commands.bind", {"snapshot_id": "s", "bindings": []}),
    ],
)
async def test_pre_initialize_calls_are_rejected_with_same_code(
    tmp_path: Path, method: str, params: dict[str, Any]
) -> None:
    """未 initialize 时四个入口都返回 -32000 且文案一致。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _attach_owner_frames(host)
    await host.dispatch(_request(method, params, "pre-init"))
    error = frames[-1]["error"]
    assert error["code"] == -32000
    assert error["message"] == "initialize must be the first request"
    await host.close()


async def test_initialize_capability_gate_matrix(tmp_path: Path) -> None:
    """缺 capability 时按入口返回不同稳定码；models.select 缺失在 undo 收敛前拦截。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], handles=[])

    await host.dispatch(
        _request("run.cancel", {"thread_id": "t", "run_id": "r"}, "cap-cancel")
    )
    await host.dispatch(_request("threads.list", {}, "cap-threads"))
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "x"},
                "thread_id": "t",
                "run_id": "r",
                "model_selection": {"primary_profile": "pro"},
            },
            "cap-models",
        )
    )
    messages = {
        frame["id"]: frame["error"]["message"]
        for frame in frames
        if "error" in frame
    }
    assert messages["cap-cancel"] == "CAPABILITY_REQUIRED"
    # threads.* 先在 _dispatch_current 的 OPERATION_CAPABILITIES 表上被拦，
    # 所以稳定码是通用的 CAPABILITY_REQUIRED 而不是 handler 内的专用码。
    assert messages["cap-threads"] == "CAPABILITY_REQUIRED"
    assert messages["cap-models"] == "MODELS_SELECT_CAPABILITY_REQUIRED"
    await host.close()


async def test_old_minor_is_rejected_before_handler(tmp_path: Path) -> None:
    """协商到 v5 / v7 的连接分别在 commands.bind / run.set_approval_mode 上被拦截。"""
    from harness_agent.host.agent_host import AgentHost

    for max_minor, method, params in (
        (5, "commands.bind", {"snapshot_id": "s", "bindings": []}),
        (7, "run.set_approval_mode", {"thread_id": "t", "run_id": "r", "approval_mode": "auto"}),
    ):
        host = AgentHost(
            allow_echo=True,
            config_home=tmp_path / f"home-{max_minor}",
            workspace=tmp_path / "workspace",
        )
        frames = await _capture_owner(host, ["run.approval_mode"], max_minor=max_minor)
        await host.dispatch(_request(method, params, "minor-gate"))
        error = frames[-1]["error"]
        assert error["code"] == -32003
        assert error["message"] == "PROTOCOL_MINOR_REQUIRED"
        assert error["data"]["details"]["negotiated_minor"] == max_minor
        await host.close()


# ---------------------------------------------------------------------------
# 6. run.start 前置顺序与副作用。
# ---------------------------------------------------------------------------


async def test_run_start_rejects_blank_message_with_minus_32602(tmp_path: Path) -> None:
    """只含空白的消息在解析后立刻被拒，错误码 -32602。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, ["run.multithread"])
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "   "},
                "thread_id": "blank-thread",
                "run_id": "blank-run",
            },
            "blank-start",
        )
    )
    error = frames[-1]["error"]
    assert error["code"] == -32602
    assert error["message"] == "message must be non-empty"
    await host.close()


async def test_goal_run_requires_goal_manage_capability(tmp_path: Path) -> None:
    """goal 输入缺少 goal.manage 时返回 CAPABILITY_REQUIRED，不进入 Run。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], handles=["goal"])
    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "goal_proposal", "request_id": "goal-req"},
                "thread_id": "goal-thread",
                "run_id": "goal-run",
            },
            "goal-start",
        )
    )
    error = frames[-1]["error"]
    assert error["code"] == -32002
    assert error["message"] == "CAPABILITY_REQUIRED"
    await host.close()


async def test_models_select_check_precedes_undo_convergence_and_checkpoint(
    tmp_path: Path,
) -> None:
    """缺 models.select 时在 undo 收敛和 git 检查点之前就失败，Thread 状态不变。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.threads.thread_persistence import _user_record_id

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    frames = await _capture_owner(host, ["threads.read"])
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "guard-thread", "第一轮", run_id="guard-run-1")
    await store.set_thread_reverted_turn("guard-thread", _user_record_id("guard-run-1"))

    checkpoint_calls: list[tuple[str, str]] = []
    original_checkpoint = host._record_workspace_git_checkpoint

    async def spy_checkpoint(thread_id: str, run_id: str) -> None:
        checkpoint_calls.append((thread_id, run_id))
        await original_checkpoint(thread_id, run_id)

    host._record_workspace_git_checkpoint = spy_checkpoint  # type: ignore[method-assign]

    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "第二轮"},
                "thread_id": "guard-thread",
                "run_id": "guard-run-2",
                "model_selection": {"primary_profile": "pro"},
            },
            "guard-start",
        )
    )
    error = frames[-1]["error"]
    assert error["code"] == -32002
    assert error["message"] == "MODELS_SELECT_CAPABILITY_REQUIRED"
    assert await store.get_thread_revert_state("guard-thread") is not None
    assert checkpoint_calls == []
    await host.close()


async def test_new_run_clears_code_mode_revert_marker(tmp_path: Path) -> None:
    """code 模式 undo 之后受理新 Run 会清掉 reverted 标记（哪怕 Run 随后因配置失败）。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.threads.thread_persistence import _user_record_id

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    await _capture_owner(host, ["threads.read"])
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "undo-thread", "第一轮", run_id="undo-run-1")
    await store.set_thread_reverted_turn(
        "undo-thread",
        _user_record_id("undo-run-1"),
        undo_mode="code",
    )

    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "第二轮"},
                "thread_id": "undo-thread",
                "run_id": "undo-run-2",
            },
            "undo-start",
        )
    )
    assert await store.get_thread_revert_state("undo-thread") is None
    await host.close()


async def test_title_autogen_starts_after_response_and_only_once(tmp_path: Path) -> None:
    """标题自动生成在响应之后才调度；同一线程只调度一次。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, ["run.multithread"])
    scheduled_at: list[int] = []
    scheduled_threads: list[str] = []
    original_schedule = host._schedule_thread_title_autogen

    def spy_schedule(**kwargs: Any) -> None:
        scheduled_at.append(len(frames))
        scheduled_threads.append(kwargs["thread_id"])
        original_schedule(**kwargs)

    host._schedule_thread_title_autogen = spy_schedule  # type: ignore[method-assign]

    await host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "起名"},
                "thread_id": "title-thread",
                "run_id": "title-run-1",
            },
            "title-start-1",
        )
    )
    await _wait_for(frames, lambda f: f.get("params", {}).get("type") == "run.completed")
    assert scheduled_threads == ["title-thread"]
    # 调度发生时，run.start 的响应帧已经在捕获列表里。
    assert any(
        frame.get("id") == "title-start-1" for frame in frames[: scheduled_at[0]]
    )

    # 直接再调度一次，验证去重保护：同一 thread 只登记一次。
    ran: list[str] = []

    async def fake_autogen(**kwargs: Any) -> None:
        ran.append(kwargs["thread_id"])

    host._task_marker = True  # type: ignore[attr-defined]
    host._thread_persistence_enabled = lambda: True  # type: ignore[method-assign]
    host._run_thread_title_autogen = fake_autogen  # type: ignore[method-assign]
    original_schedule(
        thread_id="title-thread",
        user_message="起名",
        requested_profile_id=None,
        owner_connection_id=host._owner_connection.connection_id,
    )
    original_schedule(
        thread_id="title-thread",
        user_message="起名",
        requested_profile_id=None,
        owner_connection_id=host._owner_connection.connection_id,
    )
    await asyncio.gather(*tuple(host._title_autogen_tasks), return_exceptions=True)
    # 两次直接调度只有一个真正起名：去重集合拦住了第二次。
    assert ran == ["title-thread"]
    assert host._title_autogen_started == {"title-thread"}
    await host.close()


# ---------------------------------------------------------------------------
# 7. initialize 响应形状与资源只初始化一次。
# ---------------------------------------------------------------------------


async def test_initialize_response_golden_keys_and_single_resource_init(
    tmp_path: Path,
) -> None:
    """initialize 响应键集合固定；第二条连接 initialize 不会重跑资源初始化。"""
    from harness_agent.host.agent_host import AgentHost

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=workspace,
    )
    frames = await _capture_owner(host, ["threads.read"])
    result = frames[-1]["result"]
    assert set(result) == {
        "protocol",
        "server",
        "connection",
        "capabilities",
        "agent_commands",
        "skills_snapshot",
        "skill_diagnostics",
        "limits",
        "diagnostics",
        "config_summary",
        "startup_error",
    }
    assert result["protocol"] == {"major": 3, "minor": 8}
    assert result["server"]["name"] == "za38-agent"
    assert set(result["connection"]) == {"id", "role", "project"}
    assert result["connection"]["role"] == "owner"
    assert set(result["connection"]["project"]) == {"id", "label"}
    assert set(result["capabilities"]) == {"available", "enabled", "handles"}
    assert set(result["limits"]) == {"max_frame_bytes", "max_tool_payload_bytes"}
    assert set(result["skills_snapshot"]) == {"id", "count"}
    assert result["skills_snapshot"]["id"] == result["skills_snapshot"]["id"]
    assert result["startup_error"] is None

    catalog_calls: list[int] = []
    mcp_calls: list[int] = []
    original_catalog = host._refresh_skill_catalog_locked
    original_mcp = host._connect_mcp_servers

    async def spy_catalog(*args: Any, **kwargs: Any) -> Any:
        catalog_calls.append(1)
        return await original_catalog(*args, **kwargs)

    async def spy_mcp(*args: Any, **kwargs: Any) -> Any:
        mcp_calls.append(1)
        return await original_mcp(*args, **kwargs)

    host._refresh_skill_catalog_locked = spy_catalog  # type: ignore[method-assign]
    host._connect_mcp_servers = spy_mcp  # type: ignore[method-assign]

    second_frames: list[dict[str, Any]] = []

    async def send_second(message: dict[str, Any]) -> None:
        second_frames.append(message)

    second = host.create_connection(send_second, role="owner")
    await host.dispatch_connection(
        second,
        _request("initialize", _initialize_params(["threads.read"]), "init-2"),
    )
    assert catalog_calls == []
    assert mcp_calls == []
    assert second_frames[-1]["result"]["connection"]["id"] == second.connection_id
    await host.close()


async def test_second_initialize_on_same_connection_is_rejected(tmp_path: Path) -> None:
    """同一连接第二次 initialize 返回 -32000，且不重跑资源。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, ["threads.read"])
    await host.dispatch(_request("initialize", _initialize_params(["threads.read"]), "init-2"))
    error = frames[-1]["error"]
    assert error["code"] == -32000
    assert error["message"] == "Peer is already initialized"
    await host.close()


# ---------------------------------------------------------------------------
# 8. threads.watch / commands.bind / 对端 response 三个小矩阵。
# ---------------------------------------------------------------------------


async def test_threads_watch_returns_history_then_registers_watch(tmp_path: Path) -> None:
    """watch 返回历史并登记观察；活动线程返回 THREAD_BUSY；unwatch 回报 removed。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    frames = await _capture_owner(host, ["threads.read"])
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "watch-thread", "历史消息")

    await host.dispatch(
        _request("threads.watch", {"thread_id": "watch-thread"}, "watch")
    )
    watched = frames[-1]["result"]
    assert watched["thread"]["thread_id"] == "watch-thread"
    assert watched["messages"][0]["content"] == "历史消息"
    assert "watch-thread" in host._owner_connection.watched_threads

    await host.dispatch(
        _request("threads.unwatch", {"thread_id": "watch-thread"}, "unwatch")
    )
    assert frames[-1]["result"] == {"removed": True}
    await host.dispatch(
        _request("threads.unwatch", {"thread_id": "watch-thread"}, "unwatch-again")
    )
    assert frames[-1]["result"] == {"removed": False}
    await host.close()

    # 活动线程的 THREAD_BUSY 必须在登记 watch 之前发生；使用注入的阻塞 Agent
    # 才能稳定拿到一个可观察的 active Run。
    agent = _BlockingAgent()
    busy_host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home-busy",
        workspace=project,
    )
    busy_frames = await _capture_owner(busy_host, ["threads.read"])
    await busy_host.dispatch(
        _request(
            "run.start",
            {
                "mode": "build",
                "input": {"kind": "user", "message": "slow"},
                "thread_id": "busy-thread",
                "run_id": "busy-run",
            },
            "busy-start",
        )
    )
    await asyncio.wait_for(agent.started.wait(), timeout=2)
    await busy_host.dispatch(
        _request("threads.watch", {"thread_id": "busy-thread"}, "watch-busy")
    )
    busy_error = busy_frames[-1]["error"]
    assert busy_error["data"]["code"] == "THREAD_BUSY"
    await busy_host.close()


async def test_thread_summary_only_reaches_threads_read_owner_or_watcher(
    tmp_path: Path,
) -> None:
    """thread.summary 只发给有 threads.read 且是 owner 或 watcher 的连接。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    frames = await _capture_owner(host, ["threads.read"], max_minor=9)
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "summary-thread", "标题来源")

    watcher_frames: list[dict[str, Any]] = []
    observer_frames: list[dict[str, Any]] = []

    async def send_watcher(message: dict[str, Any]) -> None:
        watcher_frames.append(message)

    async def send_observer(message: dict[str, Any]) -> None:
        observer_frames.append(message)

    watcher = host.create_connection(send_watcher, role="owner")
    observer = host.create_connection(send_observer, role="owner")
    await host.dispatch_connection(
        watcher,
        _request(
            "initialize",
            _initialize_params(["threads.read"], max_minor=9),
            "watch-init",
        ),
    )
    await host.dispatch_connection(
        watcher, _request("threads.watch", {"thread_id": "summary-thread"}, "watch")
    )
    await host.dispatch_connection(
        observer, _request("initialize", _initialize_params([]), "observer-init")
    )
    await host.dispatch(
        _request(
            "threads.set_title",
            {"thread_id": "summary-thread", "title": "新标题"},
            "set-title",
        )
    )
    await _wait_for(watcher_frames, lambda f: f.get("method") == "thread.summary")
    owner_summaries = [f for f in frames if f.get("method") == "thread.summary"]
    assert owner_summaries[0]["params"]["title"] == "新标题"
    assert [f for f in observer_frames if f.get("method") == "thread.summary"] == []
    await host.close()


async def test_commands_bind_error_code_matrix(tmp_path: Path) -> None:
    """commands.bind 的成功与六种失败各有稳定错误码。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], max_minor=8)
    snapshot_id = next(
        frame["result"]["skills_snapshot"]["id"]
        for frame in frames
        if frame.get("id") == "init"
    )

    # 注入两条 command record，让 duplicate / unknown / set-mismatch 有可区分的语义。
    registry = host._require_skills()
    fake_commands = [
        {"id": "cmd-a", "name": "alpha", "description": "", "argument_hint": None, "requested_skill_id": "cmd-a", "plugin_id": "p"},
        {"id": "cmd-b", "name": "beta", "description": "", "argument_hint": None, "requested_skill_id": "cmd-b", "plugin_id": "p"},
    ]
    registry.agent_commands = lambda: list(fake_commands)  # type: ignore[method-assign]
    registry.snapshot_id = snapshot_id

    async def fresh_registry(*_args: Any, **_kwargs: Any) -> Any:
        return registry

    host._refresh_control_plane_catalog = fresh_registry  # type: ignore[method-assign]

    def bind(request_id: str, snapshot: str, bindings: list[dict[str, Any]]) -> dict[str, Any]:
        return _request(
            "commands.bind",
            {"snapshot_id": snapshot, "bindings": bindings},
            request_id,
        )

    await host.dispatch(bind("bind-mismatch", "other-snapshot", []))
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_SNAPSHOT_MISMATCH"

    await host.dispatch(
        bind(
            "bind-dup-id",
            snapshot_id,
            [{"id": "cmd-a", "name": "alpha"}, {"id": "cmd-a", "name": "gamma"}],
        )
    )
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_DUPLICATE_ID"

    await host.dispatch(
        bind(
            "bind-dup-name",
            snapshot_id,
            [{"id": "cmd-a", "name": "alpha"}, {"id": "cmd-b", "name": "Alpha"}],
        )
    )
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_DUPLICATE_NAME"

    await host.dispatch(
        bind(
            "bind-unknown-id",
            snapshot_id,
            [{"id": "cmd-a", "name": "alpha"}, {"id": "cmd-x", "name": "beta"}],
        )
    )
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_UNKNOWN_ID"

    await host.dispatch(
        bind("bind-set-mismatch", snapshot_id, [{"id": "cmd-a", "name": "alpha"}])
    )
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_SET_MISMATCH"

    await host.dispatch(
        bind(
            "bind-ok",
            snapshot_id,
            [{"id": "cmd-a", "name": "alpha"}, {"id": "cmd-b", "name": "beta"}],
        )
    )
    assert frames[-1]["result"] == {"snapshot_id": snapshot_id, "accepted": True}

    await host.dispatch(bind("bind-again", snapshot_id, []))
    assert frames[-1]["error"]["message"] == "COMMAND_BINDING_ALREADY_SET"
    await host.close()


async def test_peer_response_matrix(tmp_path: Path) -> None:
    """对端 response：非字符串 id 报错；未知 id 过期；client error 让 Future 失败；合法结果恢复。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames = await _capture_owner(host, [], handles=["approval"])

    # (a) id 不是字符串 → -32600。
    await host.dispatch({"jsonrpc": "2.0", "id": 7, "result": {"decision": "reject"}})
    assert frames[-1]["error"]["code"] == -32600
    assert frames[-1]["error"]["message"] == "Response id must be a string"

    # (b) 未知 id → -32004 / REQUEST_EXPIRED。
    await host.dispatch(
        {"jsonrpc": "2.0", "id": "unknown-request", "result": {"decision": "reject"}}
    )
    assert frames[-1]["error"]["code"] == -32004
    assert frames[-1]["error"]["message"] == "REQUEST_EXPIRED"

    # (b2) 未知 id 的 error / 缺 result / 格式错误的 error，也必须回 REQUEST_EXPIRED。
    # 重构前 future 检查在分支判断之前，三种形状都会得到过期通知；
    # 这是 Code Review 发现的行为回归，用例固定它。
    for index, shape in enumerate(
        (
            {"error": {"code": -32000, "message": "client said no"}},
            {},
            {"error": "not-a-dict"},
        )
    ):
        before = len(frames)
        await host.dispatch(
            {"jsonrpc": "2.0", "id": f"unknown-shape-{index}", **shape}
        )
        assert len(frames) == before + 1, shape
        assert frames[-1]["id"] == f"unknown-shape-{index}", shape
        assert frames[-1]["error"]["code"] == -32004, shape
        assert frames[-1]["error"]["message"] == "REQUEST_EXPIRED", shape

    async def start_pending(request_id: str) -> tuple[asyncio.Task[Any], asyncio.Future[Any]]:
        task = asyncio.create_task(
            host._run_coordinator._interaction_port.request(
                ConnectionRef(host._owner_connection.connection_id),
                RunRef(thread_id="peer-thread", run_id="peer-run"),
                _approval_request(request_id),
            )
        )
        await _wait_for(frames, lambda f: f.get("id") == request_id)
        return task, host._owner_connection.pending_requests[request_id]

    # (c) client error → Future 以 RpcError 失败，适配器 downgrade 为拒绝。
    pending, future = await start_pending("peer-error")
    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "id": "peer-error",
            "error": {"code": -32000, "message": "client said no"},
        }
    )
    with pytest.raises(Exception) as excinfo:
        await asyncio.wait_for(asyncio.shield(future), timeout=1)
    assert "client said no" in str(excinfo.value)
    assert (await asyncio.wait_for(pending, timeout=2)).value == {"decision": "reject"}

    # (d) 合法结果 → Future 正常恢复。
    pending, future = await start_pending("peer-ok")
    await host.dispatch(
        {"jsonrpc": "2.0", "id": "peer-ok", "result": {"decision": "approve_once"}}
    )
    result = await asyncio.wait_for(pending, timeout=2)
    assert result.value == {"decision": "approve_once"}
    assert result.expired is False
    assert await asyncio.wait_for(asyncio.shield(future), timeout=1) == {
        "decision": "approve_once"
    }
    await host.close()
