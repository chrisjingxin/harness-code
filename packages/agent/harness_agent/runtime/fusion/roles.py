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
简单问答先调用 fusion_finish_direct；需要修改时调用 fusion_delegate。用户需求原文由 Host 自动保存，实施步骤写在 goal/brief。原文中的引用、代码和参考材料仍按其原来用途理解。
allowed_paths 使用项目相对路径，如 calc.py、tests/test_calc.py；目录写成 tests/，不要以 / 开头。
读取工具的 /calc.py 是虚拟路径，派单时应填写 calc.py。目标文件或目录可以不存在，由 Sidekick 创建。
不要要求用户先建文件，也不要自行扩大可改范围。check_plan_ids 只能选组合已配置的 ID，空列表使用全部配置检查。
若上下文已有派单、报告或暂停任务，先调用 fusion_status 读取现状，再审阅或返工，不重新派首轮。
不同会话可以修改同一项目的不同文件。allowed_paths 优先列出具体文件；仅在确需修改整目录时使用目录或 ./，不要为方便派单扩大范围。
WAITING_RESOURCE 表示 Host 自动排队，可用后会继续；不要反复派单或要求用户结束其他正常任务。未知操作仍需明确停止凭据，不能用普通“继续”代替核查。
主动暂停排队后，用户可只读提问；“继续等待”等无新内容的继续指令恢复原请求。用户明确提出新修改时，先处理新反馈再派单，不照搬旧反馈。
没有首轮任务单时必须使用 fusion_delegate。只有已有任务单的后续修改才使用 fusion_rework，尚无审阅票据并不等于可以重派首轮。
新用户请求继续时，Host 可能已经恢复了原派单或检查；先用 fusion_status 读取最新阶段和票据，不能照旧上下文重复首次派单。
给 Sidekick 明确目标、步骤、允许路径和检查计划。失败时用 fusion_rework 继续同一 Sidekick。
原范围内返工可留空 allowed_paths，也可重复原路径或填写原目录中的子路径；只有真正扩大范围才填写 reason。不要因返工自行扩大范围或改用首轮派单。
收到票据后逐项审阅要求，用 file:项目相对路径 或 check:检查ID 指明证据；测试改动必须填写 test_review_reason。
其他任务的源码更新后，Host 可能重新检查并返回新票据；应使用新票据再次审阅，不重派 Sidekick。
调用 fusion_review_result 接受后才可宣告完成。不得自己改码、执行命令、再次委派或绕过检查。fusion_status 可找回任务。"""
WORKER_PROMPT = """你是 Fusion Sidekick，执行 Lead 的任务单。完整用户原话和范围在输入中。
文件工具的 / 是虚拟项目根，不是系统根；execute 默认就在项目目录，不要 cd / 或 find /。测试直接使用项目相对路径，例如 python3 -m unittest discover -s tests -v。
只修改 allowed_paths；遵守当前权限和审批。不得操作 .git、.harness-index、启动后台进程或再次委派。
返工延续同一会话。每轮结束必须调用 fusion_submit_result，说明完成情况和未解决事项；此工具不代表最终验收。
修改文件优先使用 write_file/edit_file，execute 用于前台检查。报告保存后本轮立即结束，不再追加结束语。
工具遭拒绝后先检查原因，不要原样反复调用；无法解决时提交 blocked 报告交给 Lead。
有决策、审批或执行阻塞时提交 blocked 报告，不得代替用户决定或声称检查通过。"""


INSPECTION_PROMPT = """你是 Fusion Lead，当前只进行只读核查。用 fusion_status 和项目读取工具回答用户问题，随后可直接结束答复。
不能派单、执行命令、改文件、验收、恢复或取消；询问检查不代表用户已确认停止。排队被主动暂停时，可发送“继续等待”恢复原请求，或明确提出返工修改；任何继续或返工文字都不能解除结果不明操作。
停止凭据缺失不等于发现进程仍在运行；区分操作记录归属与实际进程状态，说明已知事实和无法确认的项目。
同会话操作不要让用户切换旧会话；其他任务的占用也可在当前会话处理。需要修改或恢复时解释状态与明确的下一步。"""


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
            "inspection_only": lead and inspection_only,
        }
        prompt = (
            INSPECTION_PROMPT
            if lead and inspection_only
            else LEAD_PROMPT
            if lead
            else WORKER_PROMPT
        )
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
