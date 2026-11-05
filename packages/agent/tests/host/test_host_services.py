"""AgentHost 服务面的直测：不经过 JSON-RPC dispatch，直接调用 AcpServer 会用的方法。

【这是做什么的？】
本文件从 0.8 开始逐步覆盖 §5.2 的服务方法。每个用例只调用服务方法本身，
断言它是「不依赖 ContextVar、不自己发帧、和 v3 路径共用同一份业务对象」的。
v3 外壳（`_handle_*`）的行为由 `test_v3_characterization.py` 兜住。

【上下游】
上游是 `AgentHost` 的公开服务方法与 `host/service_types.py` 的数据类；
下游只读 `RunCoordinator`、`ThreadPersistence` 和既有协作对象，不触碰 transport。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from tests.support.thread_fixtures import accept_thread


class _BlockingAgent:
    """让服务面测试能拿到一个稳定处于运行中的 Run。"""

    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def astream(self, *_args: Any, **_kwargs: Any):
        self.started.set()
        await asyncio.Event().wait()
        if False:  # pragma: no cover - 只为让它成为 async generator
            yield None


# ---------------------------------------------------------------------------
# 0.8 ensure_ready
# ---------------------------------------------------------------------------


async def test_ensure_ready_runs_resource_init_once(tmp_path: Path) -> None:
    """连续调用只跑一次技能目录刷新与配置加载，后续调用直接返回快照。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    catalog_calls: list[int] = []
    config_calls: list[int] = []
    original_catalog = host._refresh_skill_catalog_locked
    original_load = host._load_config

    async def spy_catalog(*args: Any, **kwargs: Any) -> Any:
        catalog_calls.append(1)
        return await original_catalog(*args, **kwargs)

    def spy_load() -> None:
        config_calls.append(1)
        original_load()

    host._refresh_skill_catalog_locked = spy_catalog  # type: ignore[method-assign]
    host._load_config = spy_load  # type: ignore[method-assign]

    await host.ensure_ready()
    await host.ensure_ready()
    assert catalog_calls == [1]
    assert config_calls == [1]
    assert host._resources_ready is True
    await host.close()


async def test_ensure_ready_concurrent_callers_share_one_init(tmp_path: Path) -> None:
    """并发调用共享同一次资源初始化，不会重复刷新目录。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    catalog_calls: list[int] = []
    original_catalog = host._refresh_skill_catalog_locked
    release = asyncio.Event()

    async def spy_catalog(*args: Any, **kwargs: Any) -> Any:
        catalog_calls.append(1)
        await release.wait()
        return await original_catalog(*args, **kwargs)

    host._refresh_skill_catalog_locked = spy_catalog  # type: ignore[method-assign]

    tasks = [asyncio.create_task(host.ensure_ready()) for _ in range(3)]
    await asyncio.sleep(0)
    release.set()
    snapshots = await asyncio.gather(*tasks)
    assert catalog_calls == [1]
    assert len(snapshots) == 3
    await host.close()


async def test_ensure_ready_returns_snapshot_with_commands_and_config_summary(
    tmp_path: Path,
) -> None:
    """快照带上命令列表、snapshot id、脱敏配置摘要与默认审批模式。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    snapshot = await host.ensure_ready()
    registry = host._require_skills()
    assert list(snapshot.agent_commands) == registry.agent_commands()
    assert snapshot.skills_snapshot_id == registry.snapshot_id
    assert snapshot.skills_snapshot["id"] == snapshot.skills_snapshot_id
    assert isinstance(snapshot.config_summary, dict)
    security = snapshot.config_summary["security"]
    assert isinstance(security, dict)
    assert security["mode"] == "local"
    assert snapshot.startup_error is None
    assert snapshot.default_approval_mode in {"auto", "default", "auto-edit", "plan", "yolo"}
    assert isinstance(snapshot.diagnostics, dict)
    await host.close()


async def test_ensure_ready_reports_startup_error_without_raising(tmp_path: Path) -> None:
    """配置损坏时 ensure_ready 仍成功返回，只把启动错误放进快照。"""
    from harness_agent.host.agent_host import AgentHost

    workspace = tmp_path / "workspace"
    project_config = workspace / ".harness" / "config.toml"
    project_config.parent.mkdir(parents=True)
    project_config.write_text("[config]\nversion = 1\n", encoding="utf-8")
    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=workspace,
    )
    snapshot = await host.ensure_ready()
    assert snapshot.config_summary is None
    assert snapshot.startup_error is not None
    assert "CONFIG" in snapshot.startup_error.upper()
    assert host._resources_ready is True
    await host.close()


async def test_ensure_ready_failure_leaves_flag_unset_and_is_retryable(
    tmp_path: Path,
) -> None:
    """初始化抛错时 `_resources_ready` 保持 False，下一次调用重新尝试并成功。"""
    from harness_agent.extensions.plugin_skills import SkillError
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    original_catalog = host._refresh_skill_catalog_locked
    attempts: list[int] = []

    async def flaky_catalog(*args: Any, **kwargs: Any) -> Any:
        attempts.append(1)
        if len(attempts) == 1:
            raise SkillError("SKILL_CATALOG_UNAVAILABLE")
        return await original_catalog(*args, **kwargs)

    host._refresh_skill_catalog_locked = flaky_catalog  # type: ignore[method-assign]

    with pytest.raises(SkillError):
        await host.ensure_ready()
    assert host._resources_ready is False

    snapshot = await host.ensure_ready()
    assert attempts == [1, 1]
    assert snapshot.skills_snapshot_id
    assert host._resources_ready is True
    await host.close()


async def test_second_v3_initialize_does_not_rerun_resource_init(tmp_path: Path) -> None:
    """第二条连接的 v3 initialize 只做协商，不再触发资源初始化。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames: list[dict[str, Any]] = []

    async def capture(message: dict[str, Any]) -> None:
        frames.append(message)

    host.send = capture
    params = {
        "protocol": {"major": 3, "min_minor": 0, "max_minor": 8},
        "client": {"name": "test", "version": "0.1.0", "kind": "test"},
        "capabilities": {"requests": ["threads.read"], "handles": []},
    }
    await host.dispatch({"jsonrpc": "2.0", "method": "initialize", "params": params, "id": "init-1"})

    calls: list[int] = []
    original_catalog = host._refresh_skill_catalog_locked

    async def spy_catalog(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return await original_catalog(*args, **kwargs)

    host._refresh_skill_catalog_locked = spy_catalog  # type: ignore[method-assign]

    second_frames: list[dict[str, Any]] = []

    async def send_second(message: dict[str, Any]) -> None:
        second_frames.append(message)

    second = host.create_connection(send_second, role="owner")
    await host.dispatch_connection(
        second,
        {"jsonrpc": "2.0", "method": "initialize", "params": params, "id": "init-2"},
    )
    assert calls == []
    assert second_frames[-1]["result"]["skills_snapshot"]["id"]
    await host.close()


async def test_agent_host_exposes_workspace_property(tmp_path: Path) -> None:
    """AcpServer 校验 session/new 的 cwd 时只读这个只读属性。"""
    from harness_agent.host.agent_host import AgentHost

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=workspace,
    )
    assert host.workspace == workspace.resolve()
    await host.close()


# ---------------------------------------------------------------------------
# 0.9 连接、watch、交互
# ---------------------------------------------------------------------------


async def test_open_connection_marks_initialized_and_applies_ceiling(
    tmp_path: Path,
) -> None:
    """open_connection 直接产出可用的已初始化连接：minor 满值、能力取交集。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.protocol.generated import PROTOCOL_MINOR

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        frames.append(message)

    conn = host.open_connection(
        send,
        enabled_capabilities=["run.cancel", "threads.read", "host.attach"],
        interaction_handles=["approval", "question"],
        capability_ceiling=["run.cancel", "threads.read"],
    )
    assert conn.initialized is True
    assert conn.protocol_minor == PROTOCOL_MINOR
    assert conn.enabled_capabilities == {"run.cancel", "threads.read"}
    assert conn.interaction_handles == {"approval", "question"}
    assert conn.role == "owner"
    assert host._connections[conn.connection_id] is conn
    await host.close()


async def test_open_connection_rejects_unknown_handle_and_missing_sender(
    tmp_path: Path,
) -> None:
    """未知 handle 与缺失 sender 都是编程错误，直接抛 ValueError。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    with pytest.raises(ValueError):
        host.open_connection(
            send,
            enabled_capabilities=[],
            interaction_handles=["not-a-handle"],
        )
    with pytest.raises(ValueError):
        host.open_connection(  # type: ignore[arg-type]
            None,
            enabled_capabilities=[],
            interaction_handles=[],
        )
    # 失败路径不能留下半成品连接。
    assert list(host._connections) == [host._owner_connection.connection_id]
    await host.close()


async def test_open_connection_does_not_register_attachment_or_change_lease_holder(
    tmp_path: Path,
) -> None:
    """ACP 连接不参与 attachment 与控制权转移：lease holder 始终是 owner。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    before = host._control_lease.status()
    conn = host.open_connection(
        send, enabled_capabilities=["run.cancel"], interaction_handles=[]
    )
    after = host._control_lease.status()
    assert after.state == before.state == "owner"
    assert after.holder.connection_id == host._owner_connection.connection_id
    assert after.holder.attachment_id is None
    assert host._control_lease._attachments == {}
    assert conn.connection_id != after.holder.connection_id
    await host.close()


async def test_watch_thread_registers_without_reading_history(tmp_path: Path) -> None:
    """watch_thread 只登记订阅；线程尚未落库也能成功（session/new 场景）。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    conn = host.open_connection(
        send, enabled_capabilities=["threads.read"], interaction_handles=[]
    )
    host.watch_thread(conn, "not-yet-persisted")
    assert conn.watched_threads == {"not-yet-persisted"}
    assert host._thread_persistence is None
    await host.close()


async def test_open_and_watch_thread_is_atomic_and_rejects_busy_thread(
    tmp_path: Path,
) -> None:
    """历史读失败时不登记 watch；线程繁忙时直接 THREAD_BUSY 且不登记。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.host.run_coordinator import RunError

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    conn = host.open_connection(
        send, enabled_capabilities=["threads.read"], interaction_handles=[]
    )
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "watch-ok", "历史")

    opened = await host.open_and_watch_thread(conn, "watch-ok")
    thread_payload = opened["thread"]
    assert isinstance(thread_payload, dict)
    assert thread_payload["thread_id"] == "watch-ok"
    assert conn.watched_threads == {"watch-ok"}

    # 读取失败（线程不存在）时不得留下观察关系。
    with pytest.raises(RpcError) as missing:
        await host.open_and_watch_thread(conn, "missing-thread")
    assert missing.value.code == -32004
    assert conn.watched_threads == {"watch-ok"}

    # 维护中（等效于有活动 Run）的线程被拒绝，且同样不登记。
    maintenance = host._run_coordinator.idle_thread("busy-thread")
    await maintenance.__aenter__()
    try:
        with pytest.raises(RunError) as busy:
            await host.open_and_watch_thread(conn, "busy-thread")
        assert busy.value.code == "THREAD_BUSY"
    finally:
        await maintenance.__aexit__(None, None, None)
    assert conn.watched_threads == {"watch-ok"}
    await host.close()


async def test_unwatch_thread_reports_removed(tmp_path: Path) -> None:
    """unwatch_thread 返回是否真的删掉了一条订阅。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    conn = host.open_connection(
        send, enabled_capabilities=["threads.read"], interaction_handles=[]
    )
    host.watch_thread(conn, "thread-a")
    assert host.unwatch_thread(conn, "thread-a") is True
    assert host.unwatch_thread(conn, "thread-a") is False
    await host.close()


async def test_resolve_interaction_resolved_expired_invalid(tmp_path: Path) -> None:
    """服务版 resolve_interaction 返回三态，且只在合法结果上完成 Future。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.runtime.interactions import InteractionRequest

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    conn = host.open_connection(
        send, enabled_capabilities=[], interaction_handles=["approval"]
    )
    loop = asyncio.get_running_loop()

    async def register(request_id: str) -> asyncio.Future[object]:
        future: asyncio.Future[object] = loop.create_future()
        conn.pending_requests[request_id] = future
        conn.interaction_specs[request_id] = InteractionRequest(
            request_id=request_id,
            type="approval",
            payload={"interrupt_id": request_id, "description": "", "requests": [], "decisions": []},
            interrupt_id=request_id,
        )
        return future

    future = await register("req-ok")
    assert host.resolve_interaction(conn, "req-ok", {"decision": "approve_once"}) == "resolved"
    assert future.result() == {"decision": "approve_once"}

    assert host.resolve_interaction(conn, "req-unknown", {"decision": "reject"}) == "expired"

    future = await register("req-invalid")
    assert host.resolve_interaction(conn, "req-invalid", {"decision": "bogus"}) == "invalid"
    with pytest.raises(RpcError) as invalid:
        future.result()
    assert invalid.value.code == -32602

    # 已完成/已移除的请求不能再次恢复。
    assert host.resolve_interaction(conn, "req-ok", {"decision": "reject"}) == "expired"
    await host.close()


async def test_fail_interaction_sets_exception_and_adapter_returns_default_reject(
    tmp_path: Path,
) -> None:
    """fail_interaction 让适配器按 fail-closed 得到默认拒绝；已过期返回 False。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef
    from harness_agent.runtime.interactions import InteractionRequest

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        frames.append(message)

    conn = host.open_connection(
        send, enabled_capabilities=[], interaction_handles=["approval"]
    )
    task = asyncio.create_task(
        host._run_coordinator._interaction_port.request(
            ConnectionRef(conn.connection_id),
            RunRef(thread_id="fail-thread", run_id="fail-run"),
            InteractionRequest(
                request_id="fail-req",
                type="approval",
                payload={"interrupt_id": "fail-req", "description": "", "requests": [], "decisions": []},
                interrupt_id="fail-req",
            ),
        )
    )
    for _ in range(200):
        if frames:
            break
        await asyncio.sleep(0.01)
    assert frames[0]["method"] == "interaction.approval"

    assert host.fail_interaction(conn, "fail-req", RpcError(-32004, "peer said no")) is True
    result = await asyncio.wait_for(task, timeout=2)
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert host.fail_interaction(conn, "fail-req", RpcError(-32004, "again")) is False
    await host.close()


async def test_close_connection_for_service_connection_cancels_runs_and_fails_pending(
    tmp_path: Path,
) -> None:
    """服务连接关闭：取消它拥有的 Run 并清空挂起交互，不影响 owner。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.host.run_coordinator import (
        ConnectionRef,
        StartRun,
        UserRunInput,
    )

    class BlockingAgent:
        def __init__(self) -> None:
            self.started = asyncio.Event()

        async def astream(self, *_args: Any, **_kwargs: Any):
            self.started.set()
            await asyncio.Event().wait()
            if False:  # pragma: no cover
                yield None

    agent = BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )

    async def send(message: dict[str, Any]) -> None:
        del message

    conn = host.open_connection(
        send, enabled_capabilities=["run.cancel"], interaction_handles=[]
    )
    # 直接经 Coordinator 受理，避免 0.9 阶段依赖尚未抽取的 run.start 服务方法。
    execution = await host._run_coordinator.start(
        StartRun(
            mode="build",
            thread_id="svc-thread",
            run_id="svc-run",
            input=UserRunInput(message="slow"),
            connection_id=conn.connection_id,
        ),
        ConnectionRef(conn.connection_id),
        allow_multithread=True,
    )
    assert execution.accepted is True
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    future = asyncio.get_running_loop().create_future()
    conn.pending_requests["svc-req"] = future
    await host.close_connection(conn)

    assert conn.closed is True
    assert conn.pending_requests == {}
    assert conn.interaction_specs == {}
    with pytest.raises(RpcError) as failed:
        future.result()
    assert failed.value.code == -32004
    assert await host._run_coordinator.is_active("svc-thread") is False
    assert host._owner_connection.closed is False
    await host.close()


# ---------------------------------------------------------------------------
# 0.10 bind_commands 与 start_run
# ---------------------------------------------------------------------------


def _open(host: Any) -> tuple[Any, list[dict[str, Any]]]:
    """建立一条服务连接并返回 (conn, 它收到的帧)。"""

    async def send(message: dict[str, Any]) -> None:
        frames.append(message)

    frames: list[dict[str, Any]] = []
    conn = host.open_connection(
        send,
        enabled_capabilities=["run.multithread", "run.cancel", "threads.read"],
        interaction_handles=["approval"],
    )
    return conn, frames


def _user_request(**overrides: Any) -> Any:
    """构造一个最小 user 输入的服务层请求。"""
    from harness_agent.host.run_coordinator import UserRunInput
    from harness_agent.host.service_types import StartRunRequest

    payload: dict[str, Any] = {
        "thread_id": "svc-thread",
        "run_id": "svc-run",
        "mode": "build",
        "input": UserRunInput("hello"),
    }
    payload.update(overrides)
    return StartRunRequest(**payload)


async def test_start_run_delivers_events_to_connection_sender_without_dispatch(
    tmp_path: Path,
) -> None:
    """直接调用 start_run：事件经该连接的 sender 推出，不经过 JSON-RPC dispatch。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)

    accepted = await host.start_run(conn, _user_request())
    assert accepted.thread_id == "svc-thread"
    assert accepted.run_id == "svc-run"
    assert accepted.accepted is True
    for _ in range(400):
        if any(frame.get("params", {}).get("type") == "run.completed" for frame in frames):
            break
        await asyncio.sleep(0.01)
    events = [frame["params"]["type"] for frame in frames if frame.get("method") == "event"]
    assert events[-1] == "run.completed"
    assert all(frame.get("jsonrpc") == "2.0" for frame in frames)
    await host.close()


async def test_start_run_calls_on_accepted_before_first_event(tmp_path: Path) -> None:
    """on_accepted 必须在第一个事件之前被 await。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)
    order: list[str] = []

    async def on_accepted(accepted: Any) -> None:
        order.append(f"accepted:{accepted.run_id}")

    original_send = conn.sender
    assert original_send is not None

    async def send(message: dict[str, Any]) -> None:
        if message.get("method") == "event":
            order.append("event")
        await original_send(message)

    conn.sender = send

    await host.start_run(conn, _user_request(), on_accepted=on_accepted)
    assert order[0] == "accepted:svc-run"
    await host.close()


async def test_start_run_on_accepted_failure_prevents_title_and_fanout(
    tmp_path: Path,
) -> None:
    """回调抛错时不排标题、不起扇出，Run 也不会收到任何事件。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)
    title_calls: list[str] = []
    original_schedule = host._schedule_thread_title_autogen

    def spy_schedule(**kwargs: Any) -> None:
        title_calls.append(kwargs["thread_id"])
        original_schedule(**kwargs)

    host._schedule_thread_title_autogen = spy_schedule  # type: ignore[method-assign]

    async def fail(accepted: Any) -> None:
        del accepted
        raise RuntimeError("respond failed")

    with pytest.raises(RuntimeError):
        await host.start_run(conn, _user_request(), on_accepted=fail)
    assert title_calls == []
    assert host._run_event_tasks == set()
    assert frames == []
    await host.close()


async def test_start_run_requires_models_select_before_any_side_effect(
    tmp_path: Path,
) -> None:
    """缺 models.select 时在 undo 收敛与 git 检查点之前失败。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.threads.thread_persistence import _user_record_id

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    conn, _frames = _open(host)
    conn.enabled_capabilities.discard("models.select")
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "svc-thread", "第一轮", run_id="svc-run-0")
    await store.set_thread_reverted_turn("svc-thread", _user_record_id("svc-run-0"))

    checkpoint_calls: list[tuple[str, str]] = []
    original_checkpoint = host._record_workspace_git_checkpoint

    async def spy_checkpoint(thread_id: str, run_id: str) -> None:
        checkpoint_calls.append((thread_id, run_id))
        await original_checkpoint(thread_id, run_id)

    host._record_workspace_git_checkpoint = spy_checkpoint  # type: ignore[method-assign]

    with pytest.raises(RpcError) as error:
        await host.start_run(
            conn,
            _user_request(requested_primary_profile="pro"),
        )
    assert error.value.code == -32002
    assert error.value.message == "MODELS_SELECT_CAPABILITY_REQUIRED"
    assert await store.get_thread_revert_state("svc-thread") is not None
    assert checkpoint_calls == []
    await host.close()


async def test_start_run_converges_pending_code_undo_before_accepting(
    tmp_path: Path,
) -> None:
    """code 模式 undo 的挂起标记在受理前被清掉。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.threads.thread_persistence import _user_record_id

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    conn, _frames = _open(host)
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "svc-thread", "第一轮", run_id="svc-run-0")
    await store.set_thread_reverted_turn(
        "svc-thread", _user_record_id("svc-run-0"), undo_mode="code"
    )

    with pytest.raises(RpcError) as start_error:
        # 没有模型配置时 Run 会在 Coordinator 里失败；重点是受理前的收敛已完成。
        await host.start_run(conn, _user_request())
    assert start_error.value.code == -32004
    assert await store.get_thread_revert_state("svc-thread") is None
    await host.close()


async def test_start_run_converges_pending_conversation_undo_before_accepting(
    tmp_path: Path,
) -> None:
    """conversation 模式 undo 会把该 turn 之后的历史物理截断后才受理新 Run。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.threads.thread_persistence import (
        TranscriptAppend,
        _user_record_id,
    )

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    conn, _frames = _open(host)
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "svc-thread", "第一轮", run_id="svc-run-0")
    await accept_thread(store, "svc-thread", "第二轮", run_id="svc-run-1")
    await store.append_transcript(
        TranscriptAppend(
            thread_id="svc-thread",
            record_id="run:svc-run-1:assistant:1",
            kind="assistant",
            content="第二轮回答",
            run_id="svc-run-1",
        )
    )
    await store.set_thread_reverted_turn("svc-thread", _user_record_id("svc-run-0"))

    with pytest.raises(RpcError):
        await host.start_run(conn, _user_request())
    records = await store.load_transcript("svc-thread")
    record_ids = [record.record_id for record in records]
    assert "run:svc-run-1:assistant:1" not in record_ids
    await host.close()


async def test_start_run_records_git_checkpoint_only_for_user_input(
    tmp_path: Path,
) -> None:
    """只有 user 输入会在受理前记录 git 检查点；goal 输入不会。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError
    from harness_agent.host.run_coordinator import GoalProposalRunInput

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    conn, _frames = _open(host)
    conn.enabled_capabilities.update({"goal.manage"})
    conn.interaction_handles.update({"goal"})
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "svc-thread", "第一轮", run_id="svc-run-0")
    calls: list[str] = []

    async def spy_checkpoint(thread_id: str, run_id: str) -> None:
        calls.append(run_id)
        del thread_id

    host._record_workspace_git_checkpoint = spy_checkpoint  # type: ignore[method-assign]

    with pytest.raises(RpcError):
        await host.start_run(conn, _user_request(run_id="svc-run-user"))
    assert calls == ["svc-run-user"]

    with pytest.raises(RpcError):
        await host.start_run(
            conn,
            _user_request(
                run_id="svc-run-goal",
                input=GoalProposalRunInput("goal-req"),
            ),
        )
    assert calls == ["svc-run-user"]
    await host.close()


async def test_start_run_schedules_title_autogen_once_per_thread(
    tmp_path: Path,
) -> None:
    """只有 user 输入会触发标题自动生成，且每条线程一次。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import GoalProposalRunInput

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)
    conn.enabled_capabilities.update({"goal.manage"})
    conn.interaction_handles.update({"goal"})
    calls: list[tuple[str, str]] = []
    original_schedule = host._schedule_thread_title_autogen

    def spy_schedule(**kwargs: Any) -> None:
        calls.append((kwargs["thread_id"], kwargs["user_message"]))
        original_schedule(**kwargs)

    host._schedule_thread_title_autogen = spy_schedule  # type: ignore[method-assign]

    await host.start_run(conn, _user_request())
    assert calls == [("svc-thread", "hello")]

    await host.start_run(
        conn,
        _user_request(
            thread_id="svc-goal-thread",
            run_id="svc-goal-run",
            input=GoalProposalRunInput("goal-req"),
        ),
    )
    assert calls == [("svc-thread", "hello")]
    await host.close()


async def test_start_run_maps_config_errors_to_rpc_error_minus_32004(
    tmp_path: Path,
) -> None:
    """Coordinator 受理时的 ConfigError 统一映射成 -32004。"""
    from harness_agent.config.config import ConfigError
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)

    async def fail_start(*_args: Any, **_kwargs: Any) -> Any:
        raise ConfigError("MODEL_CONFIGURATION_REQUIRED")

    host._run_coordinator.start = fail_start  # type: ignore[method-assign]

    with pytest.raises(RpcError) as error:
        await host.start_run(conn, _user_request())
    assert error.value.code == -32004
    await host.close()


async def test_bind_commands_success_and_each_error_code(tmp_path: Path) -> None:
    """bind_commands 直接调用时同样四种校验错误 + 成功路径。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)
    registry = host._require_skills()
    fake_commands = [
        {"id": "cmd-a", "name": "alpha", "description": "", "argument_hint": None, "requested_skill_id": "cmd-a", "plugin_id": "p"},
        {"id": "cmd-b", "name": "beta", "description": "", "argument_hint": None, "requested_skill_id": "cmd-b", "plugin_id": "p"},
    ]
    registry.agent_commands = lambda: list(fake_commands)  # type: ignore[method-assign]

    async def fresh_registry(*_args: Any, **_kwargs: Any) -> Any:
        return registry

    host._refresh_control_plane_catalog = fresh_registry  # type: ignore[method-assign]
    snapshot_id = registry.snapshot_id

    with pytest.raises(RpcError) as mismatch:
        await host.bind_commands(conn, "other-snapshot", [])
    assert mismatch.value.message == "COMMAND_BINDING_SNAPSHOT_MISMATCH"

    with pytest.raises(RpcError) as duplicate_id:
        await host.bind_commands(
            conn,
            snapshot_id,
            [("cmd-a", "alpha"), ("cmd-a", "gamma")],
        )
    assert duplicate_id.value.message == "COMMAND_BINDING_DUPLICATE_ID"

    with pytest.raises(RpcError) as duplicate_name:
        await host.bind_commands(
            conn,
            snapshot_id,
            [("cmd-a", "alpha"), ("cmd-b", "Alpha")],
        )
    assert duplicate_name.value.message == "COMMAND_BINDING_DUPLICATE_NAME"

    with pytest.raises(RpcError) as unknown_id:
        await host.bind_commands(
            conn,
            snapshot_id,
            [("cmd-a", "alpha"), ("cmd-x", "beta")],
        )
    assert unknown_id.value.message == "COMMAND_BINDING_UNKNOWN_ID"

    with pytest.raises(RpcError) as set_mismatch:
        await host.bind_commands(conn, snapshot_id, [("cmd-a", "alpha")])
    assert set_mismatch.value.message == "COMMAND_BINDING_SET_MISMATCH"

    await host.bind_commands(
        conn,
        snapshot_id,
        [("cmd-a", "alpha"), ("cmd-b", "beta")],
    )
    assert conn.command_binding_snapshot_id == snapshot_id
    assert dict(conn.command_bindings) == {"cmd-a": "alpha", "cmd-b": "beta"}

    with pytest.raises(RpcError) as already_set:
        await host.bind_commands(conn, snapshot_id, [])
    assert already_set.value.message == "COMMAND_BINDING_ALREADY_SET"
    await host.close()


async def test_service_methods_ignore_ambient_connection_context(tmp_path: Path) -> None:
    """环境 ContextVar 指向另一条连接时，效果仍落在传入的 conn 上。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    target, _target_frames = _open(host)
    other, other_frames = _open(host)
    other.enabled_capabilities.discard("threads.read")

    token = host._connection_context.set(other)
    try:
        host.watch_thread(target, "ambient-thread")
        assert host.unwatch_thread(target, "ambient-thread") is True
        accepted = await host.start_run(target, _user_request())
    finally:
        host._connection_context.reset(token)

    assert accepted.accepted is True
    assert other.watched_threads == set()
    assert target.watched_threads == set()
    assert other_frames == []
    await host.close()


# ---------------------------------------------------------------------------
# 0.11 取消、审批模式、线程列表
# ---------------------------------------------------------------------------


async def test_cancel_run_rejects_non_owner_connection(tmp_path: Path) -> None:
    """只有发起该 Run 的连接能取消；别的连接得到 RUN_NOT_OWNER。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import RunError

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    owner, _owner_frames = _open(host)
    other, _other_frames = _open(host)

    await host.start_run(owner, _user_request())
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    with pytest.raises(RunError) as error:
        await host.cancel_run(other, "svc-thread", "svc-run")
    assert error.value.code == "RUN_NOT_OWNER"
    await host.close()


async def test_cancel_run_returns_cancelled_and_single_terminal_event(
    tmp_path: Path,
) -> None:
    """服务版取消返回 cancelled 结果，事件流里只出现一个 run.cancelled。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)

    await host.start_run(conn, _user_request())
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    result = await host.cancel_run(conn, "svc-thread", "svc-run")
    assert result.cancelled is True
    assert result.run_id == "svc-run"
    for _ in range(400):
        cancelled = [
            frame
            for frame in frames
            if frame.get("params", {}).get("type") == "run.cancelled"
        ]
        if cancelled:
            break
        await asyncio.sleep(0.01)
    types = [frame["params"]["type"] for frame in frames if frame.get("method") == "event"]
    assert types.count("run.cancelled") == 1
    assert "run.completed" not in types
    assert "run.failed" not in types
    await host.close()


async def test_set_approval_mode_revision_is_monotonic(tmp_path: Path) -> None:
    """连续切档时 revision 单调递增，返回值即服务端实际状态。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)
    await host.start_run(conn, _user_request())
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    first = await host.set_approval_mode(conn, "svc-thread", "svc-run", "auto-edit")
    second = await host.set_approval_mode(conn, "svc-thread", "svc-run", "yolo")
    assert first.approval_mode == "auto-edit"
    assert second.approval_mode == "yolo"
    assert second.revision > first.revision
    assert (second.thread_id, second.run_id) == ("svc-thread", "svc-run")
    await host.close()


async def test_set_approval_mode_busy_while_interaction_pending(tmp_path: Path) -> None:
    """正在等审批时切档被拒绝为 RUN_APPROVAL_MODE_BUSY（可重试）。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunError, RunRef
    from harness_agent.runtime.interactions import InteractionRequest

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)
    await host.start_run(conn, _user_request())
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    run_state = host._run_coordinator._runs["svc-thread"]
    # 直接构造「正在等审批」的状态（生产路径由 RunCoordinator 在请求交互时写入）。
    run_state.pending_interactions.add("pending-approval")

    with pytest.raises(RunError) as error:
        await host.set_approval_mode(conn, "svc-thread", "svc-run", "auto")
    assert error.value.code == "RUN_APPROVAL_MODE_BUSY"
    assert error.value.retryable is True
    assert frames == []
    del ConnectionRef, RunRef, InteractionRequest
    await host.close()


async def test_list_threads_returns_summaries_for_current_workspace_only(
    tmp_path: Path,
) -> None:
    """服务版 list_threads 只返回当前 workspace 的线程，且遵守 limit。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    other_project = tmp_path / "other"
    other_project.mkdir()

    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    _conn, _frames = _open(host)
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "thread-a", "A")
    await accept_thread(store, "thread-b", "B")

    other = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=other_project,
    )
    other_store = await other._ensure_thread_persistence()
    await accept_thread(other_store, "thread-other", "Other")

    summaries = await host.list_threads(10)
    assert {summary.thread_id for summary in summaries} == {"thread-a", "thread-b"}
    assert len(await host.list_threads(1)) == 1
    await other.close()
    await host.close()


async def test_list_threads_in_echo_mode_raises_threads_unavailable(
    tmp_path: Path,
) -> None:
    """回声模式没有 Thread 存储，服务版 list_threads 直接报专用错误码。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    with pytest.raises(RpcError) as error:
        await host.list_threads(5)
    assert error.value.code == -32002
    assert error.value.message == "THREADS_UNAVAILABLE_IN_ECHO_MODE"
    await host.close()


async def test_open_thread_not_found_raises_rpc_error_minus_32004(
    tmp_path: Path,
) -> None:
    """不存在的线程在读历史时映射成 -32004 / THREAD_NOT_FOUND。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.connection import RpcError

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    with pytest.raises(RpcError) as error:
        await host.open_thread("missing-thread")
    assert error.value.code == -32004
    assert error.value.message == "THREAD_NOT_FOUND"
    await host.close()


# ---------------------------------------------------------------------------
# 0.12 服务面与 v3 路径的共享状态（同一 RunCoordinator）
# ---------------------------------------------------------------------------


def _initialize_frame(request_id: str = "v3-init") -> dict[str, Any]:
    """构造一个直接走 dispatch 的 v3 initialize 帧。"""
    return {
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocol": {"major": 3, "min_minor": 0, "max_minor": 8},
            "client": {"name": "v3", "version": "0.1.0", "kind": "test"},
            "capabilities": {
                "requests": ["run.cancel", "run.multithread", "threads.read"],
                "handles": [],
            },
        },
        "id": request_id,
    }


async def test_service_and_v3_paths_share_one_run_coordinator(tmp_path: Path) -> None:
    """服务路径与 dispatch 路径打到同一个 RunCoordinator.start / cancel。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    starts: list[str] = []
    cancels: list[str] = []
    original_start = host._run_coordinator.start
    original_cancel = host._run_coordinator.cancel

    async def spy_start(command: Any, owner: Any, *, allow_multithread: bool = False) -> Any:
        starts.append(command.run_id)
        return await original_start(command, owner, allow_multithread=allow_multithread)

    async def spy_cancel(ref: Any, requester: Any) -> Any:
        cancels.append(ref.run_id)
        return await original_cancel(ref, requester)

    host._run_coordinator.start = spy_start  # type: ignore[method-assign]
    host._run_coordinator.cancel = spy_cancel  # type: ignore[method-assign]

    service_conn, _service_frames = _open(host)
    await host.start_run(service_conn, _user_request(thread_id="svc-t", run_id="svc-r"))
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    v3_frames: list[dict[str, Any]] = []

    async def capture(message: dict[str, Any]) -> None:
        v3_frames.append(message)

    host.send = capture
    await host.dispatch(_initialize_frame())
    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "method": "run.start",
            "params": {
                "mode": "build",
                "input": {"kind": "user", "message": "v3"},
                "thread_id": "v3-t",
                "run_id": "v3-r",
            },
            "id": "v3-start",
        }
    )
    assert starts == ["svc-r", "v3-r"]

    await host.cancel_run(service_conn, "svc-t", "svc-r")
    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "method": "run.cancel",
            "params": {"thread_id": "v3-t", "run_id": "v3-r"},
            "id": "v3-cancel",
        }
    )
    assert cancels == ["svc-r", "v3-r"]
    await host.close()


async def test_run_started_by_v3_can_be_cancelled_through_service(tmp_path: Path) -> None:
    """v3 受理的 Run 能被服务方法取消。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames: list[dict[str, Any]] = []

    async def capture(message: dict[str, Any]) -> None:
        frames.append(message)

    host.send = capture
    await host.dispatch(_initialize_frame())
    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "method": "run.start",
            "params": {
                "mode": "build",
                "input": {"kind": "user", "message": "v3"},
                "thread_id": "v3-t",
                "run_id": "v3-r",
            },
            "id": "v3-start",
        }
    )
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    result = await host.cancel_run(host._owner_connection, "v3-t", "v3-r")
    assert result.cancelled is True
    # 取消返回只代表已登记取消请求；Run 的终态收敛在后台任务里完成。
    for _ in range(400):
        if await host._run_coordinator.is_active("v3-t") is False:
            break
        await asyncio.sleep(0.01)
    assert await host._run_coordinator.is_active("v3-t") is False
    await host.close()


async def test_run_started_by_service_can_be_cancelled_through_v3_run_cancel(
    tmp_path: Path,
) -> None:
    """服务方法受理的 Run 能被 v3 run.cancel 取消（owner 连接发起时）。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    frames: list[dict[str, Any]] = []

    async def capture(message: dict[str, Any]) -> None:
        frames.append(message)

    host.send = capture
    await host.dispatch(_initialize_frame())
    await host.start_run(host._owner_connection, _user_request(thread_id="svc-t", run_id="svc-r"))
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "method": "run.cancel",
            "params": {"thread_id": "svc-t", "run_id": "svc-r"},
            "id": "v3-cancel",
        }
    )
    assert any(frame.get("id") == "v3-cancel" for frame in frames)
    for _ in range(400):
        if await host._run_coordinator.is_active("svc-t") is False:
            break
        await asyncio.sleep(0.01)
    assert await host._run_coordinator.is_active("svc-t") is False
    await host.close()


async def test_service_started_run_blocks_second_connection_with_thread_busy(
    tmp_path: Path,
) -> None:
    """一个连接跑着 Run 时，另一条连接对同一 thread 得到 THREAD_BUSY。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    first, _first_frames = _open(host)
    second, _second_frames = _open(host)

    await host.start_run(first, _user_request(thread_id="shared-t", run_id="run-1"))
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    from harness_agent.host.run_coordinator import RunError

    with pytest.raises(RunError) as error:
        await host.start_run(second, _user_request(thread_id="shared-t", run_id="run-2"))
    assert error.value.code == "THREAD_BUSY"
    await host.close()


async def test_second_run_on_same_connection_hits_connection_run_busy_without_multithread(
    tmp_path: Path,
) -> None:
    """没有 run.multithread 时，同一连接不能同时跑两个 thread。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import RunError

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)
    conn.enabled_capabilities.discard("run.multithread")

    await host.start_run(conn, _user_request(thread_id="t-1", run_id="run-1"))
    await asyncio.wait_for(agent.started.wait(), timeout=2)

    with pytest.raises(RunError) as error:
        await host.start_run(conn, _user_request(thread_id="t-2", run_id="run-2"))
    assert error.value.code == "CONNECTION_RUN_BUSY"
    await host.close()


async def test_multithread_capability_on_service_connection_allows_parallel_threads(
    tmp_path: Path,
) -> None:
    """声明了 run.multithread 的连接可以并行跑多条 thread。"""
    from harness_agent.host.agent_host import AgentHost

    agent = _BlockingAgent()
    host = AgentHost(
        agent=agent,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, _frames = _open(host)

    await host.start_run(conn, _user_request(thread_id="p-1", run_id="run-1"))
    await asyncio.wait_for(agent.started.wait(), timeout=2)
    accepted = await host.start_run(conn, _user_request(thread_id="p-2", run_id="run-2"))
    assert accepted.accepted is True
    assert await host._run_coordinator.is_active("p-1") is True
    assert await host._run_coordinator.is_active("p-2") is True
    await host.close()


_SERVICE_METHODS = (
    "ensure_ready",
    "open_connection",
    "bind_commands",
    "start_run",
    "watch_thread",
    "open_thread",
    "open_and_watch_thread",
    "unwatch_thread",
    "resolve_interaction",
    "fail_interaction",
    "cancel_run",
    "set_approval_mode",
    "list_threads",
)

_FORBIDDEN_SERVICE_CALLS = frozenset(
    {
        "_current_connection",
        "send_response",
        "send_error",
        "send_notification",
        "_connection_context",
    }
)
_FORBIDDEN_AMBIENT_HELPERS = frozenset(
    {
        "_connection_capabilities",
        "_connection_handles",
        "_connection_watches",
    }
)


_SERVICE_HELPERS = (
    "_prepare_run",
    "_schedule_thread_title_autogen",
    "_record_workspace_git_checkpoint",
    "_fanout_run_execution",
    "_host_snapshot",
)


def test_service_methods_do_not_reference_ambient_connection_helpers() -> None:
    """AST 扫描服务方法体：不许读 ContextVar、不许自己发帧。

    「不依赖 ContextVar」由机器检查，而不是靠人记住。允许调用带参数的
    `_connection_handles(conn)` 这类辅助方法，但禁止无参调用（那会退回环境读取）。
    """
    import ast
    import inspect

    from harness_agent.host.agent_host import AgentHost

    source = inspect.getsource(AgentHost)
    tree = ast.parse(source)
    host_class = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "AgentHost"
    )
    methods = {
        node.name: node
        for node in host_class.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    problems: list[str] = []
    # 服务方法调用的私有辅助同样不许读环境连接：Code Review 指出只扫方法体会漏掉
    # 「以后在辅助方法里加 _current_connection()」的回归。
    for name in (*_SERVICE_METHODS, *_SERVICE_HELPERS):
        method = methods.get(name)
        assert method is not None, f"{name} 不存在"
        for node in ast.walk(method):
            if isinstance(node, ast.Call):
                func = node.func
                attr = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                if attr in _FORBIDDEN_SERVICE_CALLS:
                    problems.append(f"{name}: 调用了 {attr}()")
                if attr in _FORBIDDEN_AMBIENT_HELPERS and not node.args:
                    problems.append(f"{name}: 无参调用了 {attr}()")
            if isinstance(node, ast.Attribute) and node.attr in {"_connection_context"}:
                problems.append(f"{name}: 读取了 {node.attr}")
    assert problems == [], problems


def test_agent_host_satisfies_host_service_port() -> None:
    """AgentHost 必须实现 HostServicePort 列出的全部成员，且同步/异步、参数种类与必填性一致。

    只比对「方法存在 + 参数名存在」会放过把 async 改成同步、把 keyword-only 改成位置参数、
    给实现多加一个必填参数这类破坏调用方的改动，所以这里逐项比对。
    """
    import inspect

    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.service_types import HostServicePort

    members = [
        name
        for name in vars(HostServicePort)
        if not name.startswith("_")
    ]
    assert members, "HostServicePort 不应为空"
    missing: list[str] = []
    mismatched: list[str] = []
    for name in members:
        port_member = inspect.getattr_static(HostServicePort, name)
        implementation = inspect.getattr_static(AgentHost, name, None)
        if implementation is None:
            missing.append(name)
            continue
        if isinstance(port_member, property):
            if not isinstance(implementation, property):
                mismatched.append(f"{name}: 应为 property")
            continue
        if isinstance(port_member, staticmethod):
            if not isinstance(implementation, staticmethod):
                mismatched.append(f"{name}: 应为 staticmethod")
            port_function = port_member.__func__
            actual_function = implementation.__func__ if isinstance(implementation, staticmethod) else implementation
        else:
            port_function = port_member
            actual_function = implementation
        if inspect.iscoroutinefunction(port_function) != inspect.iscoroutinefunction(actual_function):
            mismatched.append(f"{name}: 同步/异步不一致")
        port_params = {
            parameter.name: parameter
            for parameter in inspect.signature(port_function).parameters.values()
            if parameter.name != "self"
        }
        actual_params = {
            parameter.name: parameter
            for parameter in inspect.signature(actual_function).parameters.values()
            if parameter.name != "self"
        }
        for parameter_name, parameter in port_params.items():
            actual = actual_params.get(parameter_name)
            if actual is None:
                mismatched.append(f"{name}: 缺少参数 {parameter_name}")
            elif actual.kind != parameter.kind:
                mismatched.append(f"{name}.{parameter_name}: 参数种类 {actual.kind} != {parameter.kind}")
        for parameter_name, parameter in actual_params.items():
            if parameter_name in port_params:
                continue
            if parameter.default is inspect.Parameter.empty and parameter.kind not in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            ):
                mismatched.append(f"{name}: 实现多了必填参数 {parameter_name}")
    assert missing == [], missing
    assert mismatched == [], mismatched


async def test_service_connection_sender_receives_v3_event_frames_in_order(
    tmp_path: Path,
) -> None:
    """服务连接的 sender 收到 v3 形状事件帧，sequence 单调递增。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)

    await host.start_run(conn, _user_request())
    for _ in range(400):
        if any(frame.get("params", {}).get("type") == "run.completed" for frame in frames):
            break
        await asyncio.sleep(0.01)
    events = [frame for frame in frames if frame.get("method") == "event"]
    assert [event["params"]["sequence"] for event in events] == list(
        range(1, len(events) + 1)
    )
    assert events[-1]["params"]["type"] == "run.completed"
    await host.close()


async def test_service_connection_receives_thread_summary_only_with_threads_read(
    tmp_path: Path,
) -> None:
    """thread.summary 只发给声明了 threads.read 的服务连接。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    reader, reader_frames = _open(host)
    silent, silent_frames = _open(host)
    silent.enabled_capabilities.discard("threads.read")

    store = await host._ensure_thread_persistence()
    await accept_thread(store, "summary-svc", "标题来源")
    host.watch_thread(reader, "summary-svc")

    await host._broadcast_thread_summary(
        "summary-svc",
        {"thread_id": "summary-svc", "title": "新标题"},
        owner_connection_id=host._owner_connection.connection_id,
    )
    assert [frame["method"] for frame in reader_frames] == ["thread.summary"]
    assert silent_frames == []
    await host.close()


async def test_interaction_request_reaches_service_sender_and_resolve_completes_it(
    tmp_path: Path,
) -> None:
    """交互请求经服务连接 sender 推出，resolve_interaction 完成 Future。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef
    from harness_agent.runtime.interactions import InteractionRequest

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)
    task = asyncio.create_task(
        host._run_coordinator._interaction_port.request(
            ConnectionRef(conn.connection_id),
            RunRef(thread_id="svc-t", run_id="svc-r"),
            InteractionRequest(
                request_id="svc-approval",
                type="approval",
                payload={
                    "interrupt_id": "svc-approval",
                    "description": "",
                    "requests": [],
                    "decisions": ["approve_once", "reject"],
                },
                interrupt_id="svc-approval",
            ),
        )
    )
    for _ in range(200):
        if frames:
            break
        await asyncio.sleep(0.01)
    assert frames[0]["method"] == "interaction.approval"
    assert frames[0]["id"] == "svc-approval"

    state = host.resolve_interaction(conn, "svc-approval", {"decision": "approve_once"})
    assert state == "resolved"
    result = await asyncio.wait_for(task, timeout=2)
    assert result.value == {"decision": "approve_once"}
    assert result.expired is False
    await host.close()


async def test_undeclared_handle_yields_default_without_sending_frame(
    tmp_path: Path,
) -> None:
    """服务连接没声明 approval handle 时不发帧，直接按默认拒绝返回。"""
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.host.run_coordinator import ConnectionRef, RunRef
    from harness_agent.runtime.interactions import InteractionRequest

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    conn, frames = _open(host)
    conn.interaction_handles.discard("approval")

    result = await host._run_coordinator._interaction_port.request(
        ConnectionRef(conn.connection_id),
        RunRef(thread_id="svc-t", run_id="svc-r"),
        InteractionRequest(
            request_id="svc-undeclared",
            type="approval",
            payload={"interrupt_id": "svc-undeclared", "description": "", "requests": [], "decisions": []},
            interrupt_id="svc-undeclared",
        ),
    )
    assert result.value == {"decision": "reject"}
    assert result.expired is True
    assert frames == []
    await host.close()


async def test_open_thread_and_list_thread_roundtrip_with_real_persistence(
    tmp_path: Path,
) -> None:
    """open_thread 与 list_threads 对同一条真实持久化线程结果一致。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "roundtrip-thread", "历史内容")

    opened = await host.open_thread("roundtrip-thread")
    thread_payload = opened["thread"]
    assert isinstance(thread_payload, dict)
    assert thread_payload["thread_id"] == "roundtrip-thread"
    messages = opened["messages"]
    assert isinstance(messages, list)
    first_message = messages[0]
    assert isinstance(first_message, dict)
    assert first_message["content"] == "历史内容"

    summaries = await host.list_threads(10)
    assert [summary.thread_id for summary in summaries] == ["roundtrip-thread"]
    await host.close()


async def test_session_new_style_watch_then_title_summary_arrives(
    tmp_path: Path,
) -> None:
    """session/new 场景：线程还没落库先 watch，落库并起名后能收到 thread.summary。"""
    from harness_agent.host.agent_host import AgentHost

    project = tmp_path / "project"
    project.mkdir()
    host = AgentHost(
        allow_echo=False,
        config_home=tmp_path / "home",
        workspace=project,
    )
    conn, frames = _open(host)
    host.watch_thread(conn, "new-session-thread")
    assert conn.watched_threads == {"new-session-thread"}

    store = await host._ensure_thread_persistence()
    await accept_thread(store, "new-session-thread", "新会话")
    await host._broadcast_thread_summary(
        "new-session-thread",
        {"thread_id": "new-session-thread", "title": "自动起名"},
        owner_connection_id=host._owner_connection.connection_id,
    )
    assert [frame["method"] for frame in frames] == ["thread.summary"]
    assert frames[0]["params"]["title"] == "自动起名"
    await host.close()


# ---------------------------------------------------------------------------
# Code Review 补充：ContextVar 残留与代码索引
# ---------------------------------------------------------------------------


async def test_connection_handles_for_reads_registered_connection_not_ambient(
    tmp_path: Path,
) -> None:
    """`_prepare_run` 用连接身份查 handles：不读 ContextVar，连接回收后返回空集。"""
    import inspect

    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    async def send(_message: dict[str, Any]) -> None:
        return None

    interactive = host.open_connection(
        send, enabled_capabilities=["run.cancel"], interaction_handles=["approval", "question"]
    )
    silent = host.open_connection(
        send, enabled_capabilities=["run.cancel"], interaction_handles=["approval"]
    )

    token = host._connection_context.set(silent)
    try:
        # 环境连接是 silent，但按身份查询必须得到 interactive 自己的 handles。
        assert "question" in host._connection_handles_for(interactive.connection_id)
        assert "question" not in host._connection_handles_for(silent.connection_id)
    finally:
        host._connection_context.reset(token)
    assert host._connection_handles_for(None) == set()
    assert host._connection_handles_for("no-such-connection") == set()

    # 源码级防护：_prepare_run 必须继续按 command.connection_id 查，不能退回环境读取。
    source = inspect.getsource(AgentHost._prepare_run)
    assert "_connection_handles_for(command.connection_id)" in source
    assert "self._connection_handles()" not in source
    await host.close()


class _FakeCodeIndexManager:
    """记录 start() 调用次数；可配置前 N 次失败。"""

    def __init__(self, fail_first: int = 0) -> None:
        self.start_calls = 0
        self._fail_first = fail_first

    async def start(self) -> None:
        self.start_calls += 1
        if self.start_calls <= self._fail_first:
            raise RuntimeError("CODE_INDEX_START_FAILED")


async def test_ensure_ready_starts_code_index_manager_when_configured(
    tmp_path: Path,
) -> None:
    """配置开启代码索引时，每次 ensure_ready 都尝试启动 Manager（幂等）；关闭时不构造。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    manager = _FakeCodeIndexManager()
    host._code_index_configured = lambda: True  # type: ignore[method-assign]
    host._ensure_code_index_manager = lambda: manager  # type: ignore[method-assign]

    await host.ensure_ready()
    await host.ensure_ready()
    assert manager.start_calls == 2

    disabled = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home2",
        workspace=tmp_path / "workspace2",
    )
    built: list[int] = []
    disabled._ensure_code_index_manager = lambda: built.append(1)  # type: ignore[method-assign]
    await disabled.ensure_ready()
    assert built == []
    await host.close()
    await disabled.close()


async def test_ensure_ready_code_index_start_failure_keeps_resources_ready(
    tmp_path: Path,
) -> None:
    """Manager 启动失败只让这一次调用失败：资源已就绪、MCP 任务已起，下次再尝试启动。"""
    from harness_agent.host.agent_host import AgentHost

    host = AgentHost(
        allow_echo=True,
        config_home=tmp_path / "home",
        workspace=tmp_path / "workspace",
    )
    manager = _FakeCodeIndexManager(fail_first=1)
    host._code_index_configured = lambda: True  # type: ignore[method-assign]
    host._ensure_code_index_manager = lambda: manager  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="CODE_INDEX_START_FAILED"):
        await host.ensure_ready()
    assert host._resources_ready is True
    assert host._mcp_connect_task is not None

    snapshot = await host.ensure_ready()
    assert manager.start_calls == 2
    assert snapshot.skills_snapshot_id
    await host.close()
