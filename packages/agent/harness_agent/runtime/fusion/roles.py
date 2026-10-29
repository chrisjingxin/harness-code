"""分别从用户原始权限派生双模型角色，模型和能力共同参与 Profile 身份。"""

from __future__ import annotations

from dataclasses import replace

from harness_agent.extensions.mcp import build_mcp_snapshot
from harness_agent.policy.capability_policy import EffectiveCapabilityView
from harness_agent.runtime.agent_engine_profile import component_fingerprint
from harness_agent.runtime.agent_spec import ResolvedAgentSpec
from harness_agent.runtime.fusion.profile import FrozenFusionProfile

from harness_agent.runtime.fusion.prompts import (
    LEAD_PROMPT,
    WORKER_PROMPT,
    INSPECTION_PROMPT,
    EXPLORATION_PROMPT,
)

READ_TOOLS = frozenset({"ls", "read_file", "glob", "grep", "lsp", "codebase_explore"})
LEAD_CONTROLS = frozenset(
    {
        "fusion_finish_direct",
        "fusion_delegate",
        "fusion_explore",
        "fusion_rework",
        "fusion_review_result",
        "fusion_status",
    }
)
WORKER_CONTROLS = frozenset({"fusion_submit_result", "fusion_status"})


def resolve_fusion_specs(
    base_spec: ResolvedAgentSpec,
    frozen: FrozenFusionProfile,
    *,
    inspection_only: bool = False,
) -> tuple[ResolvedAgentSpec, ResolvedAgentSpec]:
    """两角色各自与原始权限求交，Sidekick 不继承 Lead 的只读限制。"""
    specs = []
    for role in ("lead", "sidekick"):
        lead = role == "lead"
        model = frozen.lead_profile if lead else frozen.sidekick_profile
        safe = frozen.lead if lead else frozen.sidekick
        names = set(base_spec.capability_view.tool_names) & (
            READ_TOOLS
            | (
                {"ask_user"}
                if lead
                else {"execute", "write_file", "edit_file", "delete_file"}
            )
        )
        controls = set(LEAD_CONTROLS if lead else WORKER_CONTROLS)
        if lead and inspection_only:
            names.discard("ask_user")
            controls = {"fusion_status"}
        if lead and not base_spec.capability_view.allows_tool("task"):
            controls -= {"fusion_delegate", "fusion_rework", "fusion_explore"}
        view = EffectiveCapabilityView(
            tuple(sorted(names | controls)),
            (),
            (),
            base_spec.capability_view.filesystem_read,
            None if lead else base_spec.capability_view.filesystem_write,
            None if lead else base_spec.capability_view.shell_commands,
            base_spec.effective_policy.fingerprint,
        )
        identity = {
            "version": 1,
            "role": role,
            "profile": frozen.config_fingerprint,
            "view": view.fingerprint,
            "inspection_only": lead and inspection_only,
        }
        prompt = (
            INSPECTION_PROMPT
            if lead and inspection_only
            else LEAD_PROMPT
            if lead
            else WORKER_PROMPT
        )
        append = frozen.lead_prompt_append if lead else frozen.sidekick_prompt_append
        if append:
            prompt += "\n团队补充要求（不得扩大硬权限）：\n" + append
        prompt += f"\nexecute 的实际工作目录：{base_spec.workspace}。文件工具的 / 仅映射到这个目录。"
        specs.append(
            replace(
                base_spec,
                role="primary" if lead else "delegate",
                agent_id=f"fusion-{role}",
                model_profile_id=model.profile_id,
                model_settings=model.settings,
                model_view=safe,
                definition_fingerprint=component_fingerprint(
                    {"fusion": role, "version": 1}
                ),
                capability_view=view,
                tools=(),
                mcp_snapshot=build_mcp_snapshot([], revision="fusion-v1"),
                prompt=prompt,
                interactive=base_spec.interactive if lead else False,
                tool_view_fingerprint=view.fingerprint,
                skill_view_fingerprint=component_fingerprint({"skills": False}),
                middleware_fingerprint=component_fingerprint(identity),
                prompt_template_fingerprint=component_fingerprint({"prompt": prompt}),
                pinned=False,
                enable_memory=False,
                enable_skills=False,
                enable_ask_user=lead and not inspection_only,
                goal_backed=False,
            )
        )
    return specs[0], specs[1]


def resolve_exploration_spec(
    worker: ResolvedAgentSpec, frozen: FrozenFusionProfile
) -> ResolvedAgentSpec:
    """从已求交的 Worker 权限再缩成只读；独立身份避免复用写入图。"""
    view = replace(
        worker.capability_view,
        tool_names=tuple(
            sorted(
                (set(worker.capability_view.tool_names) & READ_TOOLS)
                | {"fusion_status"}
            )
        ),
        filesystem_write=None,
        shell_commands=None,
    )
    prompt = EXPLORATION_PROMPT + f"\n实际项目目录：{worker.workspace}。"
    if frozen.sidekick_prompt_append:
        prompt += "\n团队补充要求（不得扩大硬权限）：\n" + frozen.sidekick_prompt_append
    return replace(
        worker,
        capability_view=view,
        prompt=prompt,
        tool_view_fingerprint=view.fingerprint,
        prompt_template_fingerprint=component_fingerprint({"prompt": prompt}),
        middleware_fingerprint=component_fingerprint(
            {
                "exploration_only": True,
                "view": view.fingerprint,
                "profile": frozen.config_fingerprint,
            }
        ),
    )
