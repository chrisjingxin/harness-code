"""Fusion 启动前绑定的验证、冻结、脱敏和身份稳定性。"""

from __future__ import annotations

import importlib
import json
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import pytest

from harness_agent.config.config import (
    AgentEnginePoolSettings, ConfigError, ExecutionSettings, ModelCatalog,
    ModelProfile, ModelSettings, Za38Config,
)
from harness_agent.config.fusion import (
    FusionCheckPlanSettings, FusionProfileSettings, FusionSettings,
)


ENVIRONMENT = {
    "TEST_LEAD_KEY": "fake-lead-secret", "TEST_WORKER_KEY": "fake-worker-secret",
    "TEST_HEADER": "fake-header-secret",
}


def _config(tmp_path: Path) -> Za38Config:
    catalog = ModelCatalog(default_profile="fast", role_profiles={}, profiles={
        "pro": ModelProfile(profile_id="pro", source="test", settings=ModelSettings(
            name="lead-model", base_url="https://lead.example.invalid/v1",
            api_key_env="TEST_LEAD_KEY", headers={"X-Tag": "original"},
            headers_env={"Authorization": "TEST_HEADER"},
        )),
        "fast": ModelProfile(profile_id="fast", source="test", settings=ModelSettings(
            name="worker-model", base_url="https://worker.example.invalid/v1",
            api_key_env="TEST_WORKER_KEY",
        )),
    })
    return Za38Config(
        model=catalog.require_profile().settings, model_profile="fast",
        execution=ExecutionSettings(), agent_engine_pool=AgentEnginePoolSettings(),
        paths=(), workspace=tmp_path, sources={}, model_catalog=catalog,
        fusion=FusionSettings(
            profiles={"default": FusionProfileSettings("pro", "fast", ("unit",), 3)},
            check_plans={"unit": FusionCheckPlanSettings("echo fake-command-secret")},
        ),
    )


def _resolve(config: Za38Config, profile_id: str = "default", environ=None):
    module = importlib.import_module("harness_agent.runtime.fusion.profile")
    return module.resolve_fusion_profile(
        config, profile_id, environ=ENVIRONMENT if environ is None else environ,
    )


def _model_override(config: Za38Config, role: str, **fields) -> Za38Config:
    catalog = config.model_catalog
    assert catalog is not None
    profiles = dict(catalog.profiles)
    selected = profiles[role]
    profiles[role] = replace(selected, settings=replace(selected.settings, **fields))
    return replace(config, model_catalog=replace(catalog, profiles=profiles))


def test_freezes_selected_models_and_checks_without_using_default_root(tmp_path: Path) -> None:
    frozen = _resolve(_config(tmp_path))
    assert frozen.profile_id == "default"
    assert frozen.lead_profile.profile_id == "pro"
    assert frozen.sidekick_profile.profile_id == "fast"
    assert frozen.max_rework_rounds == 3
    assert frozen.check_plans[0].plan_id == "unit"
    assert frozen.check_plans[0].cwd == tmp_path.resolve()
    assert frozen.check_plans[0].command == "echo fake-command-secret"
    assert frozen.check_plans[0].timeout_seconds == 300


@pytest.mark.parametrize("profile_id", ["missing", "", " "])
def test_unknown_combination_never_falls_back_to_default(tmp_path: Path, profile_id: str) -> None:
    with pytest.raises(ConfigError, match="FUSION_PROFILE_INVALID"):
        _resolve(_config(tmp_path), profile_id)


@pytest.mark.parametrize("environment,role", [
    ({"TEST_WORKER_KEY": "fake"}, "lead"),
    ({"TEST_LEAD_KEY": "fake"}, "sidekick"),
    ({"TEST_LEAD_KEY": "  ", "TEST_WORKER_KEY": "fake"}, "lead"),
])
def test_missing_credentials_identify_role_without_echoing_values(
    tmp_path: Path, environment: dict[str, str], role: str,
) -> None:
    with pytest.raises(ConfigError, match=f"FUSION_PROFILE_INVALID: {role}.*API_KEY_MISSING"):
        _resolve(_config(tmp_path), environ=environment)


@pytest.mark.parametrize("role,capabilities", [
    ("pro", frozenset({"streaming"})),
    ("fast", frozenset({"tool-calling"})),
])
def test_both_models_need_tools_and_streaming(
    tmp_path: Path, role: str, capabilities: frozenset[str],
) -> None:
    with pytest.raises(ConfigError, match="MODEL_PROFILE_CAPABILITY_MISSING"):
        _resolve(_model_override(_config(tmp_path), role, capabilities=capabilities))


def test_trusted_literal_key_is_preserved_in_private_frozen_settings(tmp_path: Path) -> None:
    config = _model_override(_config(tmp_path), "pro", api_key="fake-literal-secret")
    frozen = _resolve(config, environ={"TEST_WORKER_KEY": "fake"})
    assert frozen.lead_profile.settings.resolve_api_key({}) == "fake-literal-secret"
    assert frozen.to_record()["lead"]["available"] is True
    assert "fake-literal-secret" not in repr(frozen)


def test_pool_capacity_check_only_applies_when_selecting_fusion(tmp_path: Path) -> None:
    config = replace(_config(tmp_path), agent_engine_pool=AgentEnginePoolSettings(max_profiles=1))
    assert config.require_model_profile().profile_id == "fast"
    with pytest.raises(ConfigError, match="max_profiles"):
        _resolve(config)


def test_frozen_binding_and_safe_record_omit_connection_and_command_values(tmp_path: Path) -> None:
    frozen = _resolve(_config(tmp_path))
    record = frozen.to_record()
    assert record["lead"]["id"] == "pro"
    assert record["sidekick"]["id"] == "fast"
    assert record["check_plan_ids"] == ["unit"]
    assert len(record["config_fingerprint"]) == 64
    serialized = json.dumps(record) + repr(frozen) + repr(frozen.check_plans)
    for forbidden in (
        "example.invalid", "fake-command-secret", "TEST_HEADER", "Authorization",
        *ENVIRONMENT.values(),
    ):
        assert forbidden not in serialized


def test_frozen_header_maps_do_not_alias_mutable_source_configuration(tmp_path: Path) -> None:
    config = _config(tmp_path)
    frozen = _resolve(config)
    source = config.require_model_profile("pro").settings
    source.headers["X-Tag"] = "changed"
    source.headers_env["Authorization"] = "DIFFERENT_HEADER"
    assert frozen.lead_profile.settings.headers == {"X-Tag": "original"}
    assert frozen.lead_profile.settings.headers_env == {"Authorization": "TEST_HEADER"}
    with pytest.raises(TypeError):
        frozen.lead_profile.settings.headers["X-Tag"] = "mutated"
    with pytest.raises(FrozenInstanceError):
        frozen.max_rework_rounds = 10


def test_credential_rotation_does_not_change_configuration_identity(tmp_path: Path) -> None:
    config = _config(tmp_path)
    first = _resolve(config)
    rotated = {name: value + "-rotated" for name, value in ENVIRONMENT.items()}
    second = _resolve(config, environ=rotated)
    assert first.config_fingerprint == second.config_fingerprint
    literal = _model_override(config, "pro", api_key="fake-new-literal-key")
    assert first.config_fingerprint == _resolve(literal).config_fingerprint


@pytest.mark.parametrize("change", ["model", "endpoint", "headers", "command", "timeout", "cwd", "rounds", "roles"])
def test_changes_to_effective_configuration_invalidate_binding_identity(tmp_path: Path, change: str) -> None:
    config = _config(tmp_path)
    first = _resolve(config)
    profile = config.fusion.require_profile("default")
    checks = dict(config.fusion.check_plans)
    if change == "model":
        config = _model_override(config, "pro", name="another-model")
    elif change == "endpoint":
        config = _model_override(config, "fast", base_url="https://other.example.invalid/v1")
    elif change == "headers":
        config = _model_override(config, "pro", headers={"X-Tag": "other"})
    elif change == "command":
        checks["unit"] = replace(checks["unit"], command="echo another-command")
    elif change == "timeout":
        checks["unit"] = replace(checks["unit"], timeout_seconds=30)
    elif change == "cwd":
        (tmp_path / "subdir").mkdir()
        checks["unit"] = replace(checks["unit"], cwd="subdir")
    elif change == "rounds":
        profile = replace(profile, max_rework_rounds=0)
    elif change == "roles":
        profile = replace(profile, lead_profile_id="fast", sidekick_profile_id="pro")
    config = replace(config, fusion=FusionSettings(profiles={"default": profile}, check_plans=checks))
    assert first.config_fingerprint != _resolve(config).config_fingerprint


@pytest.mark.parametrize("cwd", ["missing", "file", "../outside", "/tmp"])
def test_freezer_rechecks_directory_boundaries_for_typed_config(tmp_path: Path, cwd: str) -> None:
    config = _config(tmp_path)
    (tmp_path / "file").write_text("not a directory")
    config = replace(config, fusion=FusionSettings(
        profiles=config.fusion.profiles,
        check_plans={"unit": FusionCheckPlanSettings("echo ok", cwd=cwd)},
    ))
    with pytest.raises(ConfigError, match="FUSION_PROFILE_INVALID.*cwd"):
        _resolve(config)


def test_directory_symlink_escape_cannot_be_frozen(tmp_path: Path) -> None:
    config = _config(tmp_path)
    (tmp_path / "escaped").symlink_to(tmp_path.parent, target_is_directory=True)
    config = replace(config, fusion=FusionSettings(
        profiles=config.fusion.profiles,
        check_plans={"unit": FusionCheckPlanSettings("echo ok", cwd="escaped")},
    ))
    with pytest.raises(ConfigError, match="FUSION_PROFILE_INVALID.*cwd"):
        _resolve(config)


def test_no_checks_is_an_explicit_review_only_configuration(tmp_path: Path) -> None:
    config = _config(tmp_path)
    profile = replace(config.fusion.require_profile("default"), check_plan_ids=())
    config = replace(config, fusion=FusionSettings(profiles={"default": profile}))
    assert _resolve(config).check_plans == ()
