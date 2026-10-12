from dataclasses import replace
import pytest
from harness_agent.host.run_coordinator import StartRun, UserRunInput
from harness_agent.protocol.generated import RunStartParams


def test_run_request_accepts_explicit_fusion_profile_and_fingerprint_changes():
    params = RunStartParams.model_validate(
        {
            "thread_id": "t",
            "run_id": "r",
            "mode": "build",
            "input": {"kind": "user", "message": "修改"},
            "fusion_profile_id": "duo",
        }
    )
    assert params.fusion_profile_id == "duo"
    start = StartRun("t", "r", "build", UserRunInput("修改"), fusion_profile_id="duo")
    assert start.fingerprint() != replace(start, fusion_profile_id=None).fingerprint()


@pytest.mark.parametrize(
    "minor,mode,kind,model,approval",
    [
        (10, "build", "user", None, None),
        (11, "compose", "user", None, None),
        (11, "build", "goal_proposal", None, None),
        (11, "build", "user", "other", None),
        (11, "build", "user", None, "plan"),
    ],
)
def test_invalid_fusion_ingress_rejected_before_side_effects(
    minor, mode, kind, model, approval
):
    from harness_agent.runtime.fusion.tools import validate_fusion_ingress

    with pytest.raises(ValueError):
        validate_fusion_ingress(
            profile_id="duo",
            protocol_minor=minor,
            mode=mode,
            input_kind=kind,
            requested_skill=None,
            requested_primary_profile=model,
            approval_mode=approval,
            capabilities={"fusion.manage"},
        )


def test_valid_fusion_does_not_depend_on_experimental_delegation():
    from harness_agent.runtime.fusion.tools import validate_fusion_ingress

    validate_fusion_ingress(
        profile_id="duo",
        protocol_minor=11,
        mode="build",
        input_kind="user",
        requested_skill=None,
        requested_primary_profile=None,
        approval_mode="default",
        capabilities={"fusion.manage"},
    )


async def make_host(tmp_path, *, handles=()):
    from harness_agent.host.agent_host import AgentHost

    config = tmp_path / "trusted.toml"
    config.write_text("""
[config]
version=1
[models]
default_profile="fast"
[models.profiles.pro]
provider="openai-compatible"
model="strong-test"
base_url="https://example.invalid/v1"
api_key_env="TEST_FUSION_LEAD"
[models.profiles.fast]
provider="openai-compatible"
model="cheap-test"
base_url="https://example.invalid/v1"
api_key_env="TEST_FUSION_WORKER"
[fusion.profiles.duo]
lead_profile_id="pro"
sidekick_profile_id="fast"
""")
    host = AgentHost(
        allow_echo=False,
        config_path=str(config),
        config_home=tmp_path.parent / (tmp_path.name + "-home"),
        workspace=tmp_path,
    )

    async def send(frame):
        pass

    host.send = send
    await host.dispatch(
        {
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {
                "protocol": {"major": 3, "min_minor": 0, "max_minor": 11},
                "client": {"name": "test", "version": "1", "kind": "test"},
                "capabilities": {
                    "requests": ["fusion.read", "fusion.manage"],
                    "handles": list(handles),
                },
            },
        }
    )
    return host


async def test_host_preparation_selects_actual_lead_and_sidekick_specs(tmp_path):
    host = await make_host(tmp_path)
    try:
        persistence = await host._ensure_thread_persistence()
        prepared = await host._prepare_run(
            StartRun(
                "t",
                "r",
                "build",
                UserRunInput("保持兼容，修改实现"),
                fusion_profile_id="duo",
            ),
            persistence,
        )
        assert prepared.fusion_binding is not None
        assert prepared.execution_binding.actual_primary.profile_id == "pro"
        lead = host._resolved_agent_specs[prepared.agent_engine_profile.profile_key]
        worker = host._resolved_agent_specs[
            prepared.fusion_binding.sidekick_profile_key
        ]
        assert lead.agent_id == "fusion-lead" and worker.agent_id == "fusion-sidekick"
        assert worker.model_profile_id == "fast" and worker.capability_view.allows_tool(
            "edit_file"
        )
        assert not lead.capability_view.allows_tool("edit_file")
        assert not prepared.experimental_delegation
        await prepared.snapshot_reservation.release()
        if prepared.code_index_lease is not None:
            await prepared.code_index_lease.release()
    finally:
        await host.close()


async def test_active_fusion_blocks_ordinary_run_and_profile_switch(tmp_path):
    host = await make_host(tmp_path)
    try:
        persistence = await host._ensure_thread_persistence()
        first = await host._prepare_run(
            StartRun("t", "r", "build", UserRunInput("修改"), fusion_profile_id="duo"),
            persistence,
        )
        await first.snapshot_reservation.release()
        with pytest.raises(ValueError, match="FUSION_TASK_CONFLICT"):
            await host._prepare_run(
                StartRun("t", "r2", "build", UserRunInput("普通修改")), persistence
            )
    finally:
        await host.close()


@pytest.fixture(autouse=True)
def fake_credentials(monkeypatch):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake-pro")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake-fast")


async def test_host_rejects_remote_fusion_before_creating_task(tmp_path):
    host = await make_host(tmp_path)
    try:
        from harness_agent.config.config import ExecutionSettings

        host._load_config()
        host._config = replace(
            host._config,
            execution=replace(host._config.execution, sandbox_enabled=True),
        )
        host._load_config = lambda: None
        persistence = await host._ensure_thread_persistence()
        with pytest.raises(ValueError, match="FUSION_SNAPSHOT_UNAVAILABLE"):
            await host._prepare_run(
                StartRun(
                    "t", "r", "build", UserRunInput("修改"), fusion_profile_id="duo"
                ),
                persistence,
            )
        assert await persistence.fusion_state_store().active("t") is None
    finally:
        await host.close()


async def test_fusion_events_never_sent_to_old_protocol_watcher(tmp_path):
    from harness_agent.host.connection import ProtocolConnection
    from harness_agent.host.run_coordinator import AgentEvent, ConnectionRef

    host = await make_host(tmp_path)
    received = []

    async def send(frame):
        received.append(frame)

    old = ProtocolConnection(
        "old",
        "observer",
        sender=send,
        initialized=True,
        protocol_minor=10,
        watched_threads={"t"},
    )
    host._connections[old.connection_id] = old
    try:
        event = AgentEvent(
            "e",
            "run.started",
            "t",
            "r",
            1,
            1,
            {"resumed": False, "mode": "build"},
            "root-r",
            "fusion-lead",
        )
        await host._fanout_agent_event(ConnectionRef("stdio"), event, minimum_minor=11)
        assert not received
    finally:
        await host.close()
