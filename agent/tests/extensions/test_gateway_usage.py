"""兼容网关应显式请求流式用量，不建立网络连接。"""

from harness_agent.config.config import ModelSettings
from harness_agent.extensions.providers.harness_gateway import create_openai_compatible_model


def test_custom_gateway_explicitly_requests_stream_usage(monkeypatch):
    monkeypatch.setenv("HC194_TEST_KEY", "test-placeholder")
    model = create_openai_compatible_model(ModelSettings(name="mock", base_url="https://gateway.example.invalid/v1", api_key_env="HC194_TEST_KEY"))
    assert model.stream_usage is True
    assert model._should_stream_usage() is True
