"""Fusion 配置加载、合并、校验和脱敏行为。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness_agent.config.config import ConfigError, load_config


MODELS = '''
[models]
default_profile = "pro"
[models.profiles.pro]
provider = "openai-compatible"
model = "test-lead"
base_url = "https://lead.example.invalid/v1"
api_key_env = "TEST_LEAD_KEY"
[models.profiles.fast]
provider = "openai-compatible"
model = "test-sidekick"
base_url = "https://worker.example.invalid/v1"
api_key_env = "TEST_WORKER_KEY"
'''

FUSION = '''
[fusion.profiles.default]
lead_profile_id = "pro"
sidekick_profile_id = "fast"
check_plan_ids = ["unit"]
[fusion.check_plans.unit]
command = "python -m pytest --marker=fake-command-secret"
'''


def _write(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('[config]\nversion = 1\n' + body, encoding="utf-8")
    return path


def _load(tmp_path: Path, body: str = FUSION):
    return load_config(
        workspace=tmp_path,
        config_path=_write(tmp_path / "trusted.toml", MODELS + body),
        home=tmp_path / "home",
        environ={},
    )


def test_absent_fusion_keeps_normal_configuration_usable(tmp_path: Path) -> None:
    config = _load(tmp_path, "")
    assert config.model_profile == "pro"
    assert config.redacted({})["fusion"] == {
        "profiles": {}, "check_plans": {}, "applies_to": "restart"
    }


def test_loads_references_without_requiring_live_model_credentials(tmp_path: Path) -> None:
    config = _load(tmp_path)
    profile = config.fusion.require_profile("default")
    assert (profile.lead_profile_id, profile.sidekick_profile_id) == ("pro", "fast")
    assert profile.check_plan_ids == ("unit",)
    assert profile.max_rework_rounds == 3
    assert config.fusion.check_plans["unit"].cwd == "."
    assert config.fusion.check_plans["unit"].timeout_seconds == 300
    assert config.sources["fusion"] == "explicit"


def test_explicit_fields_override_user_fields_and_replace_check_list(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _write(home / ".harness" / "config.toml", MODELS + FUSION + '''
[fusion.profiles.other]
lead_profile_id = "fast"
sidekick_profile_id = "pro"
''')
    explicit = _write(tmp_path / "override.toml", '''
[fusion.profiles.default]
sidekick_profile_id = "pro"
check_plan_ids = []
max_rework_rounds = 0
[fusion.check_plans.unit]
timeout_seconds = 12
''')
    config = load_config(workspace=tmp_path, config_path=explicit, home=home, environ={})
    profile = config.fusion.require_profile("default")
    assert profile.lead_profile_id == "pro"
    assert profile.sidekick_profile_id == "pro"
    assert profile.check_plan_ids == ()
    assert profile.max_rework_rounds == 0
    assert set(config.fusion.profiles) == {"default", "other"}
    assert config.fusion.check_plans["unit"].timeout_seconds == 12
    assert config.fusion.check_plans["unit"].command.startswith("python -m pytest")


def test_fusion_does_not_change_experimental_delegation_binding(tmp_path: Path) -> None:
    config = _load(tmp_path, FUSION + '''
[experimental.delegation]
enabled = true
[experimental.delegation.models]
explore = "fast"
''')
    assert config.experimental.delegation.models["explore"] == "fast"
    assert config.fusion.require_profile("default").lead_profile_id == "pro"


def test_config_show_summary_omits_commands_and_credentials(tmp_path: Path) -> None:
    config = _load(tmp_path)
    view = config.redacted({"TEST_LEAD_KEY": "fake-model-secret"})["fusion"]
    assert view["profiles"]["default"] == {
        "lead_profile_id": "pro", "sidekick_profile_id": "fast",
        "check_plan_ids": ["unit"], "max_rework_rounds": 3,
    }
    assert view["check_plans"]["unit"]["timeout_seconds"] == 300
    serialized = json.dumps(view) + repr(config.fusion)
    for forbidden in ("fake-command-secret", "fake-model-secret", "example.invalid", "python -m pytest"):
        assert forbidden not in serialized


def test_fusion_mappings_cannot_be_mutated(tmp_path: Path) -> None:
    config = _load(tmp_path)
    with pytest.raises(TypeError):
        config.fusion.profiles["replacement"] = config.fusion.require_profile("default")
    with pytest.raises(TypeError):
        config.fusion.check_plans["other"] = config.fusion.check_plans["unit"]


def test_check_command_preserves_exact_trusted_text(tmp_path: Path) -> None:
    command = "\nprintf '  preserve spaces  '\n\n"
    config = _load(tmp_path, "[fusion.check_plans.unit]\ncommand = " + json.dumps(command))
    assert config.fusion.check_plans["unit"].command == command


@pytest.mark.parametrize("change,reason", [
    ('lead_profile_id = "missing"', "lead_profile_id"),
    ('sidekick_profile_id = "missing"', "sidekick_profile_id"),
    ('check_plan_ids = ["missing"]', "check_plan_ids"),
    ('check_plan_ids = ["unit", "unit"]', "check_plan_ids"),
    ('check_plan_ids = "unit"', "check_plan_ids"),
    ('max_rework_rounds = -1', "max_rework_rounds"),
    ('max_rework_rounds = true', "max_rework_rounds"),
    ('lead_profile_id = " "', "lead_profile_id"),
    ('sidekick_profile_id = 2', "sidekick_profile_id"),
    ('unexpected = "fake-invalid-secret"', "unsupported fields"),
])
def test_rejects_invalid_profile_fields(tmp_path: Path, change: str, reason: str) -> None:
    fields = {
        "lead_profile_id": 'lead_profile_id = "pro"',
        "sidekick_profile_id": 'sidekick_profile_id = "fast"',
        "check_plan_ids": 'check_plan_ids = ["unit"]',
    }
    fields[change.split(" = ")[0]] = change
    body = "[fusion.profiles.default]\n" + "\n".join(fields.values())
    body += '\n[fusion.check_plans.unit]\ncommand = "echo fake-invalid-secret"\n'
    with pytest.raises(ConfigError, match=reason) as error:
        _load(tmp_path, body)
    assert "fake-invalid-secret" not in str(error.value)


@pytest.mark.parametrize("fields,reason", [
    ('command = ""', "command"),
    ('command = 4', "command"),
    ('command = "echo ok"\ntimeout_seconds = 0', "timeout_seconds"),
    ('command = "echo ok"\ntimeout_seconds = true', "timeout_seconds"),
    ('command = "echo ok"\ntimeout_seconds = 1.5', "timeout_seconds"),
    ('command = "echo ok"\ncwd = "/tmp"', "cwd"),
    ('command = "echo ok"\ncwd = "../outside"', "cwd"),
    ('command = "echo ok"\ncwd = "C:/outside"', "cwd"),
    ('command = "echo ok"\ncwd = \'..\\outside\'', "cwd"),
    ('command = "echo ok"\nunknown = true', "unsupported fields"),
])
def test_rejects_invalid_check_plan_fields(tmp_path: Path, fields: str, reason: str) -> None:
    with pytest.raises(ConfigError, match=reason):
        _load(tmp_path, "[fusion.check_plans.unit]\n" + fields)


@pytest.mark.parametrize("body", [
    "[fusion]\nunknown = 1",
    "[fusion]\nprofiles = []",
    "[fusion]\ncheck_plans = []",
    '[fusion.profiles.default]\nlead_profile_id = "pro"',
    '[fusion.profiles." "]\nlead_profile_id = "pro"\nsidekick_profile_id = "fast"',
    '[fusion.check_plans." "]\ncommand = "echo ok"',
])
def test_rejects_malformed_fusion_tables(tmp_path: Path, body: str) -> None:
    with pytest.raises(ConfigError):
        _load(tmp_path, body)


def test_untrusted_project_fusion_configuration_is_rejected(tmp_path: Path) -> None:
    _write(tmp_path / ".harness" / "config.toml", MODELS + FUSION)
    with pytest.raises(ConfigError, match="Project configuration is not supported"):
        load_config(workspace=tmp_path, home=tmp_path / "home", environ={})


def test_trusted_prompt_appends_are_private_bounded_and_preserved(tmp_path):
    body = FUSION.replace(
        'check_plan_ids = ["unit"]',
        'check_plan_ids = ["unit"]\nlead_prompt_append = "先分析业务边界：fake-private-style"\nsidekick_prompt_append = "报告需列文件"',
    )
    config = _load(tmp_path, body)
    selection = config.fusion.require_profile("default")
    assert "fake-private-style" in selection.lead_prompt_append
    assert "fake-private-style" not in json.dumps(config.redacted({})) + repr(selection)
    assert config.redacted({})["fusion"]["profiles"]["default"]["prompt_appends"] == {
        "lead": True,
        "sidekick": True,
    }
    with pytest.raises(ConfigError):
        _load(tmp_path, body.replace('fake-private-style', 'a' * 8001))
