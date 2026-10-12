"""通过真实 Host 协议派发验证 Fusion 配置摘要。"""

from __future__ import annotations

import json
from pathlib import Path

from harness_agent.host.agent_host import AgentHost


async def test_config_show_returns_fusion_summary_without_live_credentials(tmp_path: Path) -> None:
    config_path = tmp_path / "trusted.toml"
    config_path.write_text('''
[config]
version = 1
[models]
default_profile = "fast"
[models.profiles.fast]
provider = "openai-compatible"
model = "test-model"
base_url = "https://gateway.example.invalid/v1"
api_key_env = "FUSION_TEST_MISSING_KEY"
[fusion.profiles.default]
lead_profile_id = "fast"
sidekick_profile_id = "fast"
check_plan_ids = ["unit"]
[fusion.check_plans.unit]
command = "echo fake-command-secret"
timeout_seconds = 42
''', encoding="utf-8")
    frames: list[dict[str, object]] = []

    async def send(message: dict[str, object]) -> None:
        frames.append(message)

    host = AgentHost(
        allow_echo=False, config_path=str(config_path),
        config_home=tmp_path / "home", workspace=tmp_path,
    )
    host.send = send
    try:
        await host.dispatch({
            "jsonrpc": "2.0", "id": "initialize", "method": "initialize",
            "params": {
                "protocol": {"major": 3, "min_minor": 0, "max_minor": 10},
                "client": {"name": "test", "version": "1", "kind": "test"},
                "capabilities": {"requests": ["config.read"], "handles": []},
            },
        })
        await host.dispatch({
            "jsonrpc": "2.0", "id": "show", "method": "config.show", "params": {},
        })
        response = next(frame for frame in frames if frame.get("id") == "show")
        assert "error" not in response, response
        summary = response["result"]["fusion"]
        assert summary["profiles"]["default"]["lead_profile_id"] == "fast"
        assert summary["profiles"]["default"]["check_plan_ids"] == ["unit"]
        assert summary["check_plans"]["unit"] == {"timeout_seconds": 42}
        assert "fake-command-secret" not in json.dumps(response)
    finally:
        await host.close()
