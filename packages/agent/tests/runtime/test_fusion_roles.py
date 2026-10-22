
from tests.runtime.test_agent_spec import _spec

from harness_agent.config.config import ModelProfile, ModelSettings
from harness_agent.runtime.execution_binding import SafeModelProfile
from harness_agent.runtime.fusion.profile import FrozenFusionProfile


def profile():
    lead = ModelProfile(
        "pro",
        ModelSettings("strong", "https://example.invalid", api_key="fake"),
        "test",
    )
    worker = ModelProfile(
        "fast",
        ModelSettings("cheap", "https://example.invalid", api_key="fake"),
        "test",
    )
    return FrozenFusionProfile(
        "duo",
        lead,
        worker,
        SafeModelProfile.from_profile(lead),
        SafeModelProfile.from_profile(worker),
        (),
        2,
        "a" * 64,
    )


def test_roles_use_distinct_models_and_original_write_scope(tmp_path):
    from harness_agent.runtime.fusion.roles import resolve_fusion_specs

    base = _spec(tmp_path)
    lead, worker = resolve_fusion_specs(base, profile())
    assert (
        lead.model_settings.name == "strong" and worker.model_settings.name == "cheap"
    )
    assert lead.agent_id == "fusion-lead" and worker.agent_id == "fusion-sidekick"
    assert lead.capability_view.filesystem_write is None
    assert (
        worker.capability_view.filesystem_write == base.capability_view.filesystem_write
    )
    assert {"fusion_delegate", "fusion_review_result", "ask_user"} <= set(
        lead.capability_view.tool_names
    )
    assert not {"execute", "write_file", "task", "memory_save", "write_todos"} & set(
        lead.capability_view.tool_names
    )
    assert {"execute", "edit_file", "fusion_submit_result"} <= set(
        worker.capability_view.tool_names
    )
    assert not {"task", "ask_user", "fusion_delegate", "write_todos"} & set(
        worker.capability_view.tool_names
    )
    assert not lead.tools and not worker.tools
    assert not lead.enable_memory and not worker.enable_skills
    assert lead.runtime_profile.profile_key != worker.runtime_profile.profile_key
    assert (
        resolve_fusion_specs(base, profile())[0].runtime_profile.profile_key
        == lead.runtime_profile.profile_key
    )


def test_control_tool_risks_and_real_approval():
    from harness_agent.policy.approval_policy import interrupt_on_for_approval_mode
    from harness_agent.policy.tool_risk import TOOL_KIND_MAP, ToolKind

    assert TOOL_KIND_MAP["fusion_delegate"] == ToolKind.AGENT
    assert TOOL_KIND_MAP["fusion_status"] == ToolKind.READ
    assert TOOL_KIND_MAP["fusion_submit_result"] == ToolKind.INTERACT
    for mode in ("default", "auto-edit", "auto"):
        policy = interrupt_on_for_approval_mode(mode)
        assert policy["fusion_delegate"] and policy["fusion_rework"]


def test_inspection_role_is_readonly_and_has_distinct_runtime_identity(tmp_path):
    from harness_agent.runtime.fusion.roles import resolve_fusion_specs

    base = _spec(tmp_path)
    ordinary, worker = resolve_fusion_specs(base, profile())
    inspector, unused = resolve_fusion_specs(base, profile(), inspection_only=True)
    assert inspector.runtime_profile.profile_key != ordinary.runtime_profile.profile_key
    assert (
        {"read_file", "fusion_status"}
        <= set(inspector.capability_view.tool_names)
        <= {
            "read_file",
            "ls",
            "glob",
            "grep",
            "lsp",
            "codebase_explore",
            "fusion_status",
        }
    )
    assert not inspector.enable_ask_user
    assert inspector.capability_view.filesystem_write is None
    assert str(tmp_path) in inspector.prompt
    assert str(tmp_path) in worker.prompt
    assert "虚拟" in worker.prompt and "find /" in worker.prompt
    assert unused.runtime_profile.profile_key == worker.runtime_profile.profile_key
