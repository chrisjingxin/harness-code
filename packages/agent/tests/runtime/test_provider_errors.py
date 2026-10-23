"""用户只收到已确认的原因和下一步，不收到上游原始响应或秘密。"""

from types import SimpleNamespace

import httpx
import openai
import pytest

from harness_agent.host.goal_proposal import _provider_draft_outcome
from harness_agent.runtime import provider_retry
from harness_agent.runtime.managed_agent_executor import _provider_terminal_error


def api_error(status, detail=None, *, wrapped=True):
    body = {"error": detail} if wrapped else detail
    response = httpx.Response(
        status,
        request=httpx.Request(
            "POST",
            "https://secret-user:secret-pass@example.invalid/v1?token=URL_SECRET",
        ),
        json=body,
    )
    return openai.APIStatusError(
        "RAW_GATEWAY_SECRET sk-test-sensitive Authorization: Bearer HEADER_SECRET",
        response=response,
        body=body,
    )


@pytest.mark.parametrize("wrapped", [False, True])
@pytest.mark.parametrize("site", ["cn-cli", "intl-cli", "intl-work"])
def test_explicit_upstream_login_failure_identifies_account_and_action(wrapped, site):
    error = api_error(
        401,
        {
            "type": "upstream_error",
            "code": 401,
            "message": f"[{site}] 上游 401：登录态失效，请重新登录。RAW_BODY_SECRET sk-sensitive",
        },
        wrapped=wrapped,
    )
    message = provider_retry.provider_failure_message(error)
    assert "上游账号" in message and site in message
    assert "登录已失效" in message and "HTTP 401" in message
    assert "控制台" in message and "重新登录" in message
    assert "SECRET" not in message and "sk-sensitive" not in message


@pytest.mark.parametrize("marker", ["invalid_api_key", "incorrect_api_key"])
def test_known_invalid_key_points_to_configuration_and_environment(marker):
    message = provider_retry.provider_failure_message(api_error(401, {"code": marker}))
    assert "API Key" in message and "环境变量" in message
    assert "登录已失效" not in message


@pytest.mark.parametrize(
    "status,expected",
    [
        (400, "参数"),
        (401, "鉴权"),
        (403, "权限"),
        (404, "地址"),
        (422, "参数"),
        (429, "限流"),
        (500, "服务"),
        (502, "服务"),
        (503, "服务"),
        (409, "拒绝"),
    ],
)
def test_http_status_has_plain_reason_and_next_step_without_raw_body(status, expected):
    message = provider_retry.provider_failure_message(
        api_error(status, {"message": "RAW_BODY_SECRET sk-sensitive"})
    )
    assert expected in message and f"HTTP {status}" in message
    assert "请" in message
    assert all(
        secret not in message
        for secret in [
            "SECRET",
            "sk-sensitive",
            "secret-user",
            "secret-pass",
            "Authorization",
            "example.invalid",
        ]
    )


@pytest.mark.parametrize(
    "body",
    [
        None,
        "<html>RAW_BODY_SECRET</html>",
        ["RAW_BODY_SECRET"],
        {"code": [], "type": {}},
        {"error": ["RAW_BODY_SECRET"]},
    ],
)
def test_malformed_error_body_uses_known_http_status(body):
    message = provider_retry.provider_failure_message(
        api_error(401, body, wrapped=False)
    )
    assert "HTTP 401" in message and "鉴权" in message
    assert "登录已失效" not in message and "SECRET" not in message


@pytest.mark.parametrize(
    "detail",
    [
        {"message": "[cn-cli] 登录态失效，请重新登录"},
        {"type": "upstream_error", "message": "401 RAW_BODY_SECRET"},
        {"type": "invalid_api_key", "message": "[cn-cli] 登录态失效，请重新登录"},
    ],
)
def test_login_expiry_is_not_inferred_from_one_ambiguous_signal(detail):
    message = provider_retry.provider_failure_message(api_error(401, detail))
    assert "登录已失效" not in message


def test_unknown_account_name_is_not_reflected_in_message():
    error = api_error(
        401,
        {
            "type": "upstream_error",
            "message": "[ACCOUNT_SECRET] 登录态失效，请重新登录",
        },
    )
    message = provider_retry.provider_failure_message(error)
    assert "登录已失效" in message and "ACCOUNT_SECRET" not in message


def test_known_context_error_explains_how_to_reduce_input():
    message = provider_retry.provider_failure_message(
        api_error(400, {"code": "context_length_exceeded"})
    )
    assert "上下文" in message and "压缩" in message


@pytest.mark.parametrize(
    "error,expected",
    [
        (TimeoutError("RAW_SECRET"), "超时"),
        (httpx.ReadTimeout("RAW_SECRET"), "超时"),
        (httpx.ConnectError("RAW_SECRET"), "连接"),
        (httpx.ReadError("RAW_SECRET"), "连接"),
        (ConnectionError("RAW_SECRET"), "连接"),
    ],
)
def test_transport_errors_are_actionable_without_exception_text(error, expected):
    message = provider_retry.provider_failure_message(error)
    assert expected in message and "请" in message and "RAW_SECRET" not in message


def test_unknown_failure_does_not_invent_http_status_or_read_arbitrary_response():
    error = RuntimeError("401 RAW_SECRET")
    error.body = {"type": "upstream_error", "message": "登录态失效"}
    error.response = SimpleNamespace(status_code=None)
    message = provider_retry.provider_failure_message(error)
    assert (
        "HTTP" not in message
        and "登录已失效" not in message
        and "RAW_SECRET" not in message
    )


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (401, "PROVIDER_REQUEST_REJECTED", False),
        (403, "PROVIDER_REQUEST_REJECTED", False),
        (429, "PROVIDER_RATE_LIMITED", True),
        (502, "PROVIDER_RETRY_EXHAUSTED", True),
    ],
)
def test_goal_and_managed_paths_share_message_and_keep_existing_terminal_contract(
    status, code, retryable
):
    error = api_error(
        status, {"type": "upstream_error", "message": "[cn-cli] 登录态失效，请重新登录"}
    )
    managed = _provider_terminal_error(error)
    goal = _provider_draft_outcome(error)
    expected = provider_retry.provider_failure_message(error)
    assert str(managed) == goal.message == expected
    assert managed.code == goal.code == code
    assert managed.retryable is goal.retryable is retryable
