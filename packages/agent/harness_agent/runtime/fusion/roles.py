"""分别从用户原始权限派生双模型角色，模型和能力共同参与 Profile 身份。"""

from __future__ import annotations

from dataclasses import replace

from harness_agent.extensions.mcp import build_mcp_snapshot
from harness_agent.policy.capability_policy import EffectiveCapabilityView
from harness_agent.runtime.agent_engine_profile import component_fingerprint
from harness_agent.runtime.agent_spec import ResolvedAgentSpec
from harness_agent.runtime.fusion.profile import FrozenFusionProfile

READ_TOOLS = frozenset({"ls", "read_file", "glob", "grep", "lsp", "codebase_explore"})
LEAD_CONTROLS = frozenset(
    {
        "fusion_finish_direct",
        "fusion_delegate",
        "fusion_rework",
        "fusion_review_result",
        "fusion_status",
    }
)
WORKER_CONTROLS = frozenset({"fusion_submit_result", "fusion_status"})
LEAD_PROMPT = """你是 Fusion Lead，负责理解要求、派单和审阅。你只能读取代码和提问。
简单问答先调用 fusion_finish_direct；需要修改时调用 fusion_delegate。user_requirements 逐条引用用户原话。
allowed_paths 使用项目相对路径，如 calc.py、tests/test_calc.py；目录写成 tests/，不要以 / 开头。
读取工具的 /calc.py 是虚拟路径，派单时应填写 calc.py。目标文件或目录可以不存在，由 Sidekick 创建。
不要要求用户先建文件，也不要自行扩大可改范围。check_plan_ids 只能选组合已配置的 ID，空列表使用全部配置检查。
若上下文已有派单、报告或暂停任务，先调用 fusion_status 读取现状，再审阅或返工，不重新派首轮。
给 Sidekick 明确目标、步骤、允许路径和检查计划。失败时用 fusion_rework 继续同一 Sidekick。
收到票据后逐项审阅要求，用 file:项目相对路径 或 check:检查ID 指明证据；测试改动必须填写 test_review_reason。
调用 fusion_review_result 接受后才可宣告完成。不得自己改码、执行命令、再次委派或绕过检查。fusion_status 可找回任务。"""
WORKER_PROMPT = """你是 Fusion Sidekick，执行 Lead 的任务单。完整用户原话和范围在输入中。
只修改 allowed_paths；遵守当前权限和审批。不得操作 .git、.harness-index、启动后台进程或再次委派。
返工延续同一会话。每轮结束必须调用 fusion_submit_result，说明完成情况和未解决事项；此工具不代表最终验收。
有决策、审批或执行阻塞时提交 blocked 报告，不得代替用户决定或声称检查通过。"""


def resolve_fusion_specs(
    base_spec: ResolvedAgentSpec, frozen: FrozenFusionProfile
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
        if lead and not base_spec.capability_view.allows_tool("task"):
            controls -= {"fusion_delegate", "fusion_rework"}
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
        }
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
                prompt=LEAD_PROMPT if lead else WORKER_PROMPT,
                interactive=base_spec.interactive if lead else False,
                tool_view_fingerprint=view.fingerprint,
                skill_view_fingerprint=component_fingerprint({"skills": False}),
                middleware_fingerprint=component_fingerprint(identity),
                prompt_template_fingerprint=component_fingerprint(
                    {"prompt": LEAD_PROMPT if lead else WORKER_PROMPT}
                ),
                pinned=False,
                enable_memory=False,
                enable_skills=False,
                enable_ask_user=lead,
                goal_backed=False,
            )
        )
    return specs[0], specs[1]
