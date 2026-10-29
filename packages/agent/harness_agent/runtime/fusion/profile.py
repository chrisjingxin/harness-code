"""冻结 Fusion 模型与检查计划，提供后续 Run 唯一的启动前绑定入口。

可信配置 + 组合 ID → 校验模型/目录 → 冻结运行输入 → 生成安全记录。
本模块不创建 Agent、不执行检查；后续 Run 负责使用这些固定输入。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from harness_agent.config.config import ConfigError, ModelProfile, Za38Config
from harness_agent.config.fusion import (
    FusionCheckPlanSettings,
    FusionConfigError,
    normalize_check_cwd,
)
from harness_agent.runtime.agent_engine_profile import (
    component_fingerprint,
    model_settings_fingerprint,
)
from harness_agent.runtime.execution_binding import (
    SafeModelProfile,
    validate_model_profile,
)


@dataclass(frozen=True, slots=True)
class FrozenFusionCheckPlan:
    """一次任务使用的检查配置；命令与真实目录只保留在内存。"""

    plan_id: str
    command: str = field(repr=False)
    cwd: Path = field(repr=False)
    timeout_seconds: int
    command_digest: str


@dataclass(frozen=True, slots=True)
class FrozenFusionProfile:
    """固定两角色的实际模型与检查计划，记录出口只提供安全摘要。"""

    profile_id: str
    lead_profile: ModelProfile = field(repr=False)
    sidekick_profile: ModelProfile = field(repr=False)
    lead: SafeModelProfile
    sidekick: SafeModelProfile
    check_plans: tuple[FrozenFusionCheckPlan, ...]
    max_rework_rounds: int
    config_fingerprint: str
    lead_prompt_append: str = field(default="", repr=False)
    sidekick_prompt_append: str = field(default="", repr=False)
    pairing_warnings: tuple[str, ...] = ()

    def to_record(self) -> dict[str, object]:
        """供持久化和协议使用，禁止输出连接配置和检查正文。"""
        return {
            "profile_id": self.profile_id,
            "lead": self.lead.to_record(),
            "sidekick": self.sidekick.to_record(),
            "check_plan_ids": [plan.plan_id for plan in self.check_plans],
            "max_rework_rounds": self.max_rework_rounds,
            "config_fingerprint": self.config_fingerprint,
            **(
                {"pairing_warnings": list(self.pairing_warnings)}
                if self.pairing_warnings
                else {}
            ),
            "pricing": {
                "lead": self.lead_profile.pricing.to_record()
                if self.lead_profile.pricing
                else None,
                "sidekick": self.sidekick_profile.pricing.to_record()
                if self.sidekick_profile.pricing
                else None,
            },
        }


def resolve_fusion_profile(
    config: Za38Config,
    profile_id: str,
    *,
    environ: Mapping[str, str] | None = None,
) -> FrozenFusionProfile:
    """校验并冻结选中的双模型组合；不连接模型、不执行检查、不静默回退。"""
    try:
        selection = config.fusion.require_profile(profile_id)
    except FusionConfigError as exc:
        raise ConfigError(str(exc)) from exc
    if config.agent_engine_pool.max_profiles < 2:
        raise ConfigError(
            "FUSION_PROFILE_INVALID: runtime_pool.max_profiles must be >= 2"
        )

    lead = _freeze_model(
        config, selection.lead_profile_id, role="lead", environ=environ
    )
    sidekick = _freeze_model(
        config, selection.sidekick_profile_id, role="sidekick", environ=environ
    )
    workspace = config.workspace.resolve()
    checks: list[FrozenFusionCheckPlan] = []
    for check_id in selection.check_plan_ids:
        plan = config.fusion.check_plans.get(check_id)
        if plan is None:
            raise ConfigError(
                "FUSION_PROFILE_INVALID: check_plan_ids references an unknown check plan"
            )
        checks.append(_freeze_check(check_id, plan, workspace))

    fingerprint = component_fingerprint(
        {
            "version": 1,
            "profile_id": profile_id,
            "workspace": str(workspace),
            "lead": model_settings_fingerprint(
                profile_name=lead.profile_id, model=lead.settings
            ),
            "sidekick": model_settings_fingerprint(
                profile_name=sidekick.profile_id, model=sidekick.settings
            ),
            "checks": [
                {
                    "plan_id": plan.plan_id,
                    "command_digest": plan.command_digest,
                    "cwd": str(plan.cwd),
                    "timeout_seconds": plan.timeout_seconds,
                }
                for plan in checks
            ],
            "max_rework_rounds": selection.max_rework_rounds,
            **(
                {
                    "prompt_appends": {
                        "lead": selection.lead_prompt_append,
                        "sidekick": selection.sidekick_prompt_append,
                    }
                }
                if selection.lead_prompt_append or selection.sidekick_prompt_append
                else {}
            ),
            **(
                {
                    "pricing": {
                        "lead": lead.pricing.to_record() if lead.pricing else None,
                        "sidekick": sidekick.pricing.to_record()
                        if sidekick.pricing
                        else None,
                    }
                }
                if lead.pricing or sidekick.pricing
                else {}
            ),
        }
    )
    return FrozenFusionProfile(
        profile_id=profile_id,
        lead_profile=lead,
        sidekick_profile=sidekick,
        lead=SafeModelProfile.from_profile(lead, environ=environ),
        sidekick=SafeModelProfile.from_profile(sidekick, environ=environ),
        check_plans=tuple(checks),
        max_rework_rounds=selection.max_rework_rounds,
        config_fingerprint=fingerprint,
        lead_prompt_append=selection.lead_prompt_append,
        sidekick_prompt_append=selection.sidekick_prompt_append,
        pairing_warnings=_pairing_warnings(lead, sidekick),
    )


def _freeze_model(
    config: Za38Config,
    profile_id: str,
    *,
    role: str,
    environ: Mapping[str, str] | None,
) -> ModelProfile:
    """复用现有模型校验，保留私有 TOML Key 并隔离可变 Header 映射。"""
    try:
        profile = config.require_model_profile(profile_id)
        validate_model_profile(profile, environ=environ)
    except ConfigError as exc:
        # 仅保留稳定错误码与安全原因；缺失 Profile 的原始 ID 不进入错误。
        reason = str(exc)
        if reason.startswith("MODEL_PROFILE_NOT_FOUND"):
            reason = "MODEL_PROFILE_NOT_FOUND"
        raise ConfigError(f"FUSION_PROFILE_INVALID: {role} {reason}") from exc
    settings = profile.settings
    snapshot = replace(
        settings,
        api_key=settings._api_key,
        # ModelSettings 兼容已有 dict 输入，绑定快照只提供只读 Mapping。
        headers=MappingProxyType(dict(settings.headers)),  # type: ignore[arg-type]
        headers_env=MappingProxyType(dict(settings.headers_env)),  # type: ignore[arg-type]
    )
    return replace(profile, settings=snapshot)


def _freeze_check(
    plan_id: str,
    plan: FusionCheckPlanSettings,
    workspace: Path,
) -> FrozenFusionCheckPlan:
    """固定真实目录；symlink、路径解析失败或目录不存在均停止绑定。"""
    try:
        relative = normalize_check_cwd(plan.cwd, path="fusion.check_plans.cwd")
        cwd = (workspace / relative).resolve(strict=True)
        if not cwd.is_relative_to(workspace) or not cwd.is_dir():
            raise ValueError("invalid directory")
    except (FusionConfigError, OSError, RuntimeError, ValueError) as exc:
        raise ConfigError(
            "FUSION_PROFILE_INVALID: check plan cwd must be an existing directory within the workspace"
        ) from exc
    return FrozenFusionCheckPlan(
        plan_id=plan_id,
        command=plan.command,
        cwd=cwd,
        timeout_seconds=plan.timeout_seconds,
        command_digest=hashlib.sha256(plan.command.encode("utf-8")).hexdigest(),
    )


def _pairing_warnings(lead: ModelProfile, sidekick: ModelProfile) -> tuple[str, ...]:
    """只按实际设置和显式价格提醒，不按模型别名或窗口大小猜测。"""
    warnings = []
    if model_settings_fingerprint(
        profile_name="pairing", model=lead.settings
    ) == model_settings_fingerprint(profile_name="pairing", model=sidekick.settings):
        warnings.append(
            "两侧使用完全相同的模型连接与设置；请确认这是预期配对，实际节省仍取决于单价和用量。"
        )
    a, b = lead.pricing, sidekick.pricing
    if (
        a
        and b
        and a.currency == b.currency
        and b.input_per_million >= a.input_per_million
        and b.output_per_million >= a.output_per_million
        and (
            b.input_per_million > a.input_per_million
            or b.output_per_million > a.output_per_million
        )
    ):
        warnings.append(
            "配置的 Sidekick 输入和输出单价均不低于 Lead；请核对单价，缓存和实际用量也会影响估算。"
        )
    return tuple(warnings)
