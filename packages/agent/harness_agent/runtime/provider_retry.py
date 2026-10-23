"""模型服务的统一错误分类、用户提示和有界重试；不向用户回显上游原始正文。"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, TypeVar

import httpx
import openai


_RETRY_AFTER = re.compile(r"(\d+)\s*(ms|s|min|h)?", re.IGNORECASE)
_RATE_LIMIT_CODES = frozenset(
    {"RATE_LIMITED", "PROVIDER_RATE_LIMITED", "429", "THROTTLED"}
)
_T = TypeVar("_T")


def provider_status_code(error: BaseException) -> int | None:
    """读取 OpenAI-compatible 异常的稳定 HTTP 状态，不读取正文。"""
    status = getattr(error, "status_code", None)
    if isinstance(status, int):
        return status
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def provider_failure_message(
    error: BaseException, *, output_published: bool = False
) -> str:
    """用已知状态和有限结构化信号说明原因与下一步，不回显密钥、URL 或响应原文。

    该函数只生成提示，不决定重试、取消或任务状态。输出已公开时，额外说明片段
    已保留且本轮不会自动重放，避免用户把重新发起任务误解为程序仍在自动重试。
    """
    reason = _provider_failure_reason(error)
    if output_published:
        return reason + "\n已显示的内容已保留，本轮不会自动重放；处理后可重新发起任务。"
    return reason


def _provider_failure_reason(error: BaseException) -> str:
    status = provider_status_code(error)
    body = getattr(error, "body", None)
    detail = body if isinstance(body, Mapping) else {}
    if isinstance(detail.get("error"), Mapping):
        detail = detail["error"]
    markers = {
        value[:128].strip().casefold()
        for name in ("type", "code")
        if isinstance(value := detail.get(name), str)
    }
    if status == 401:
        if "upstream_error" in markers:
            raw_message = detail.get("message")
            message = raw_message[:4096] if isinstance(raw_message, str) else ""
            expired = bool(
                markers & {"not_logged_in", "refresh_failed", "session_expired"}
            ) or bool(
                re.search(
                    r"登录态失效|登录已失效|请重新登录|not logged in|session expired|please log ?in|refresh failed",
                    message,
                    re.IGNORECASE,
                )
            )
            if expired:
                # 只输出已知站点枚举；账号、令牌、HTML 和任意上游文字都不进入提示。
                site = re.search(r"\[(cn-cli|intl-cli|intl-work)\]", message)
                account = f"上游账号 {site[1]} 的" if site else "上游账号的"
                return (
                    account + "登录已失效（HTTP 401）。请在代理控制台重新登录，"
                    "完成授权后回到当前对话继续。"
                )
            return "代理连接的上游服务鉴权失败（HTTP 401）。请检查代理上游账号的登录状态或凭据。"
        if markers & {"invalid_api_key", "incorrect_api_key", "invalid_authentication"}:
            return (
                "模型服务拒绝了当前 API Key（HTTP 401）。请检查模型配置中的密钥；"
                "通过 api_key_env 指定的环境变量非空时，会优先于配置文件中的 api_key。"
            )
        return (
            "模型服务鉴权失败（HTTP 401）。请检查当前模型的 API Key；"
            "使用本地代理时，还需检查代理上游账号是否需要重新登录。"
        )
    if status == 403:
        return "模型服务拒绝访问（HTTP 403）。请检查账号、模型权限和服务端访问限制。"
    if status == 404:
        return "模型接口或模型不存在（HTTP 404）。请核对模型配置中的 base_url 地址和 model 名称。"
    if status in {400, 422}:
        if "context_length_exceeded" in markers:
            return (
                f"对话上下文超过模型限制（HTTP {status}）。请压缩对话或新建会话后重试。"
            )
        return (
            f"模型服务拒绝了请求参数（HTTP {status}）。请核对当前模型是否支持所用参数和工具调用，"
            "并检查对话是否超过模型上下文限制。"
        )
    if is_provider_rate_limited(error):
        http = "（HTTP 429）" if status == 429 else ""
        return f"模型服务限流{http}。请稍后重试，并检查账号调用额度及并发限制。"
    if isinstance(status, int) and 500 <= status <= 599:
        return f"模型服务暂时不可用（HTTP {status}）。请稍后重试；使用代理时请检查上游服务及代理日志。"
    if isinstance(
        error, (TimeoutError, httpx.TimeoutException, openai.APITimeoutError)
    ):
        return "等待模型服务响应超时。请检查网络和服务状态，或在模型配置中调整 timeout_seconds。"
    if isinstance(
        error, (ConnectionError, httpx.NetworkError, openai.APIConnectionError)
    ):
        return "与模型服务的连接失败或中断。请检查服务是否已启动、base_url 地址、端口和网络。"
    if getattr(error, "code", None) == "MALFORMED_TOOL_CALL":
        return "模型返回的工具调用格式无效。请重新运行；反复出现时请检查模型的工具调用兼容性。"
    if isinstance(status, int) and 400 <= status <= 599:
        return f"模型服务拒绝了请求（HTTP {status}）。请核对模型配置，并查看模型服务或代理日志。"
    return (
        "模型服务调用失败，当前没有明确的状态码。请检查模型服务或代理日志中的错误记录。"
    )


def is_provider_rate_limited(error: BaseException) -> bool:
    """判断异常是否携带稳定 provider 限流事实。"""
    status = provider_status_code(error)
    if status is not None:
        # 明确 HTTP 状态码优先于异常文本，避免 400/401/403 的错误文案中
        # 偶然出现 “rate limit” 时被扩大成可重试请求。
        return status == 429
    code = getattr(error, "code", None)
    if isinstance(code, str) and code.upper() in _RATE_LIMIT_CODES:
        return True
    message = str(error)
    return "429" in message or "rate limit" in message.lower()


def is_provider_transient(error: BaseException) -> bool:
    """只识别可恢复的 provider 响应/传输故障。"""
    # 取消必须原样传播，不能被重试逻辑当成"临时故障"吞掉。
    if isinstance(error, asyncio.CancelledError):
        return False
    # 模型偶尔会吐出结构错误的 tool call；重问一次常能得到合法调用，
    # 所以归为可重试而不是终态失败。
    if getattr(error, "code", None) == "MALFORMED_TOOL_CALL":
        return True
    status = provider_status_code(error)
    if isinstance(status, int) and (status == 429 or 500 <= status <= 599):
        return True
    if is_provider_rate_limited(error):
        return True
    transport_types = (
        TimeoutError,
        ConnectionError,
        asyncio.TimeoutError,
        httpx.TimeoutException,
        httpx.NetworkError,
        openai.APIConnectionError,
        openai.APITimeoutError,
    )
    return isinstance(error, transport_types)


def is_provider_error(error: BaseException) -> bool:
    """判断异常是否应由 executor 收敛为稳定 provider 终态。"""
    status = provider_status_code(error)
    if isinstance(status, int) and 400 <= status <= 599:
        return True
    if is_provider_transient(error):
        return True
    return isinstance(error, (httpx.HTTPError, openai.APIError))


def retry_after_seconds(error: BaseException) -> float | None:
    """读取异常属性、HTTP response header 或文本形式的 Retry-After。"""
    raw = getattr(error, "retry_after_seconds", None)
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw >= 0:
        return float(raw)
    header = getattr(error, "retry_after", None)
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if header is None and isinstance(headers, Mapping):
        header = headers.get("retry-after") or headers.get("Retry-After")
    if isinstance(header, str):
        match = _RETRY_AFTER.search(header)
        if match is not None:
            value = float(match.group(1))
            unit = (match.group(2) or "s").lower()
            if unit == "ms":
                return value / 1000.0
            if unit == "min":
                return value * 60.0
            if unit == "h":
                return value * 3600.0
            return value
    return None


@dataclass(frozen=True, slots=True)
class BoundedProviderRetry:
    """所有模型调用方共享的线性、有上限 provider retry 策略。"""

    max_attempts: int = 3
    base_delay_seconds: float = 1.0
    max_delay_seconds: float = 30.0

    def __post_init__(self) -> None:
        """拒绝无界或不合理的 retry 配置。"""
        if self.max_attempts < 1:
            raise ValueError("PROVIDER_RETRY_BUDGET_INVALID")
        if (
            self.base_delay_seconds < 0
            or self.max_delay_seconds < self.base_delay_seconds
        ):
            raise ValueError("PROVIDER_RETRY_DELAY_INVALID")

    def should_retry(self, attempt: int, error: BaseException) -> bool:
        """attempt 从 1 计数；只在预算内重试临时 provider 错误。"""
        return attempt < self.max_attempts and is_provider_transient(error)

    def retry_delay_seconds(self, error: BaseException, attempt: int) -> float:
        """优先尊重 Retry-After，否则按 attempt 线性退避并封顶。"""
        retry_after = retry_after_seconds(error)
        if retry_after is None:
            return min(
                self.base_delay_seconds * max(1, attempt),
                self.max_delay_seconds,
            )
        return min(retry_after, self.max_delay_seconds)


async def run_with_provider_retry(
    operation: Callable[[], Awaitable[_T]],
    policy: Any | None,
    *,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
) -> _T:
    """为 managed executor 之外的直接异步模型调用复用同一 retry owner。"""
    attempt = 1
    while True:
        try:
            return await operation()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - policy 决定是否重试
            if policy is None or not policy.should_retry(attempt, error):
                raise
            await sleep(policy.retry_delay_seconds(error, attempt))
            attempt += 1


def run_with_provider_retry_sync(
    operation: Callable[[], _T],
    policy: Any | None,
    *,
    sleep: Callable[[float], object] = time.sleep,
) -> _T:
    """为同步分类器模型调用复用同一 bounded retry 语义。"""
    attempt = 1
    while True:
        try:
            return operation()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - policy 决定是否重试
            if policy is None or not policy.should_retry(attempt, error):
                raise
            sleep(policy.retry_delay_seconds(error, attempt))
            attempt += 1
