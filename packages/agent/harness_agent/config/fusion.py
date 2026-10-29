"""可信 TOML 中的 Fusion 模型组合与检查计划，不负责执行。

load_config 将用户/显式配置交给本模块：按 ID 合并 → 校验引用 → 冻结配置。
运行时再检查凭据与真实目录；config.show 只使用这里的脱敏摘要。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath, PureWindowsPath
from types import MappingProxyType
from typing import Mapping


class FusionConfigError(ValueError):
    """Fusion 配置或引用不合法；错误只包含字段位置和安全原因。"""


@dataclass(frozen=True, slots=True)
class FusionCheckPlanSettings:
    """待 Host 执行的可信检查配置；命令不进入对象摘要。"""

    command: str = field(repr=False)
    cwd: str = "."
    timeout_seconds: int = 300


@dataclass(frozen=True, slots=True)
class FusionProfileSettings:
    """引用已有 ModelProfile 的双模型组合。"""

    lead_profile_id: str
    sidekick_profile_id: str
    check_plan_ids: tuple[str, ...] = ()
    max_rework_rounds: int = 3
    lead_prompt_append: str = field(default="", repr=False)
    sidekick_prompt_append: str = field(default="", repr=False)

    def redacted(self) -> dict[str, object]:
        """生成不携带模型连接配置的组合摘要。"""
        return {
            "lead_profile_id": self.lead_profile_id,
            "sidekick_profile_id": self.sidekick_profile_id,
            "check_plan_ids": list(self.check_plan_ids),
            "max_rework_rounds": self.max_rework_rounds,
            **(
                {
                    "prompt_appends": {
                        "lead": bool(self.lead_prompt_append),
                        "sidekick": bool(self.sidekick_prompt_append),
                    }
                }
                if self.lead_prompt_append or self.sidekick_prompt_append
                else {}
            ),
        }


@dataclass(frozen=True, slots=True)
class FusionSettings:
    """Host 生命周期内不可修改的 Fusion 配置。"""

    profiles: Mapping[str, FusionProfileSettings] = field(default_factory=dict)
    check_plans: Mapping[str, FusionCheckPlanSettings] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """复制并封闭映射，避免来源字典改变已加载配置。"""
        object.__setattr__(self, "profiles", MappingProxyType(dict(self.profiles)))
        object.__setattr__(self, "check_plans", MappingProxyType(dict(self.check_plans)))

    def require_profile(self, profile_id: str) -> FusionProfileSettings:
        """取得明确选择的组合；不存在时不使用默认组合替代。"""
        profile = self.profiles.get(profile_id)
        if profile is None:
            raise FusionConfigError("FUSION_PROFILE_INVALID: profile not found")
        return profile

    def redacted(self) -> dict[str, object]:
        """供 config.show 展示 ID 和超时，不输出检查命令。"""
        return {
            "profiles": {
                name: profile.redacted()
                for name, profile in sorted(self.profiles.items())
            },
            "check_plans": {
                name: {"timeout_seconds": plan.timeout_seconds}
                for name, plan in sorted(self.check_plans.items())
            },
            "applies_to": "restart",
        }


_FIELDS = {
    "profiles": {"lead_profile_id", "sidekick_profile_id", "check_plan_ids", "max_rework_rounds", "lead_prompt_append", "sidekick_prompt_append"},
    "check_plans": {"command", "cwd", "timeout_seconds"},
}


def merge_fusion_values(
    base: Mapping[str, object], override: object,
) -> dict[str, object]:
    """按组合/检查 ID 逐字段覆盖；每份文档均拒绝未知字段。"""
    values = _table(override, "fusion")
    _known_fields(values, set(_FIELDS), "fusion")
    merged = dict(base)
    for section, fields in _FIELDS.items():
        if section not in values:
            continue
        entries = _table(values[section], f"fusion.{section}")
        result = dict(_table(merged.get(section, {}), f"fusion.{section}"))
        for name, raw in entries.items():
            if not isinstance(name, str) or not name.strip() or name != name.strip():
                raise FusionConfigError(f"fusion.{section} requires non-empty IDs without surrounding spaces")
            path = f"fusion.{section}.{name}"
            fields_value = _table(raw, path)
            _known_fields(fields_value, fields, path)
            result[name] = {**_table(result.get(name, {}), path), **fields_value}
        merged[section] = result
    return merged


def parse_fusion_settings(
    values: Mapping[str, object], *, model_profile_ids: frozenset[str],
) -> FusionSettings:
    """校验最终配置的类型和引用，不检查凭据或运行命令。"""
    check_plans: dict[str, FusionCheckPlanSettings] = {}
    for name, raw in _table(values.get("check_plans", {}), "fusion.check_plans").items():
        path = f"fusion.check_plans.{name}"
        plan = _table(raw, path)
        command = _string(plan.get("command"), f"{path}.command", strip=False)
        cwd = normalize_check_cwd(plan.get("cwd", "."), path=f"{path}.cwd")
        check_plans[name] = FusionCheckPlanSettings(
            command=command,
            cwd=cwd,
            timeout_seconds=_integer(plan.get("timeout_seconds", 300), f"{path}.timeout_seconds", minimum=1),
        )

    profiles: dict[str, FusionProfileSettings] = {}
    for name, raw in _table(values.get("profiles", {}), "fusion.profiles").items():
        path = f"fusion.profiles.{name}"
        profile = _table(raw, path)
        lead = _string(profile.get("lead_profile_id"), f"{path}.lead_profile_id")
        sidekick = _string(profile.get("sidekick_profile_id"), f"{path}.sidekick_profile_id")
        for role, profile_id in (("lead", lead), ("sidekick", sidekick)):
            if profile_id not in model_profile_ids:
                raise FusionConfigError(f"{path}.{role}_profile_id references an unknown model Profile")
        raw_checks = profile.get("check_plan_ids", [])
        if not isinstance(raw_checks, list):
            raise FusionConfigError(f"{path}.check_plan_ids must be a list")
        checks = tuple(_string(item, f"{path}.check_plan_ids") for item in raw_checks)
        if len(set(checks)) != len(checks):
            raise FusionConfigError(f"{path}.check_plan_ids must not contain duplicates")
        if any(check_id not in check_plans for check_id in checks):
            raise FusionConfigError(f"{path}.check_plan_ids references an unknown check plan")
        profiles[name] = FusionProfileSettings(
            lead_profile_id=lead,
            sidekick_profile_id=sidekick,
            check_plan_ids=checks,
            max_rework_rounds=_integer(profile.get("max_rework_rounds", 3), f"{path}.max_rework_rounds", minimum=0),
            lead_prompt_append=_prompt_append(profile.get("lead_prompt_append", "")),
            sidekick_prompt_append=_prompt_append(profile.get("sidekick_prompt_append", "")),
        )
    return FusionSettings(profiles=profiles, check_plans=check_plans)


def normalize_check_cwd(value: object, *, path: str) -> str:
    """检查目录只接受跨平台的工作区相对路径；真实边界由绑定时核对。"""
    cwd = _string(value, path)
    if (
        "\\" in cwd
        or PurePosixPath(cwd).is_absolute()
        or PureWindowsPath(cwd).drive
        or ".." in PurePosixPath(cwd).parts
    ):
        raise FusionConfigError(f"{path} must stay within the workspace")
    return PurePosixPath(cwd).as_posix()


def _table(value: object, path: str) -> Mapping[str, object]:
    """将结构错误转换为不含配置值的提示。"""
    if not isinstance(value, Mapping):
        raise FusionConfigError(f"{path} must be a TOML table")
    return value


def _known_fields(value: Mapping[str, object], allowed: set[str], path: str) -> None:
    """逐层拒绝拼错的键，避免无声丢弃配置。"""
    if set(value) - allowed:
        raise FusionConfigError(f"{path} contains unsupported fields")


def _string(value: object, path: str, *, strip: bool = True) -> str:
    """校验必需字符串，不在错误中回显原值。"""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise FusionConfigError(f"{path} must be a non-empty string without NUL")
    return value.strip() if strip else value


def _integer(value: object, path: str, *, minimum: int) -> int:
    """拒绝布尔值和非整数，并实施字段下限。"""
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise FusionConfigError(f"{path} must be an integer >= {minimum}")
    return value


def _prompt_append(value: object) -> str:
    """可信追加有界且不回显正文，不能借配置放大角色能力。"""
    if not isinstance(value, str) or len(value) > 8000 or "\x00" in value:
        raise FusionConfigError(
            "fusion.profiles prompt append must be a string up to 8000 characters without NUL"
        )
    return value
