"""Provider HTTP transport 复用测试。"""

from __future__ import annotations

import asyncio
import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import certifi
import pytest

from harness_agent.config.config import ModelSettings
from harness_agent.extensions.http_transport import is_loopback_endpoint
from harness_agent.extensions.providers.harness_gateway import (
    ProviderClientPool,
    create_openai_compatible_model,
)


async def test_provider_client_pool_reuses_uncredentialed_transport() -> None:
    """相同 endpoint/超时的 Profile 共享 transport，凭据和 Header 不进入复用键。"""
    pool = ProviderClientPool()
    first = ModelSettings(
        name="fast",
        base_url="https://gateway.example/v1",
        api_key="first-key",
        headers={"X-Tenant": "one"},
    )
    same_transport = ModelSettings(
        name="pro",
        base_url="https://gateway.example/v1",
        api_key="second-key",
        headers={"X-Tenant": "two"},
    )
    isolated = ModelSettings(
        name="other",
        base_url="https://other.example/v1",
        api_key="third-key",
    )
    try:
        first_lease = await pool.acquire(first)
        same_lease = await pool.acquire(same_transport)
        isolated_lease = await pool.acquire(isolated)
        try:
            assert first_lease.value is same_lease.value
            assert first_lease.value is not isolated_lease.value
        finally:
            await first_lease.release()
            await same_lease.release()
            await isolated_lease.release()
    finally:
        await pool.aclose()


@pytest.mark.parametrize(("url", "direct"), [
    ("http://localhost:3425/v1", True),
    ("http://LOCALHOST:3425/v1", True),
    ("http://127.0.0.1:3425/v1", True),
    ("http://127.2.3.4/v1", True),
    ("http://[::1]:3425/v1", True),
    ("https://localhost.example/v1", False),
    ("https://example.test/localhost", False),
    ("http://10.0.0.1/v1", False),
    ("http://192.168.1.1/v1", False),
])
def test_only_literal_loopback_bypasses_proxy(url: str, direct: bool) -> None:
    assert is_loopback_endpoint(url) is direct


async def test_system_proxy_is_bypassed_only_for_loopback_models(monkeypatch) -> None:
    """假系统代理返回502；回环模型仍成功，外部模型明确经过代理，关闭责任不变。"""
    requests: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            requests.append(self.path)
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path.startswith("http://external.example.test/"):
                status, content_type, body = 502, "text/plain", b"CONTROLLED_PROXY"
            else:
                chunk = {"id": "test", "object": "chat.completion.chunk", "created": 0, "model": "test",
                         "choices": [{"index": 0, "delta": {"content": "OK"}, "finish_reason": "stop"}]}
                status, content_type = 200, "text/event-stream"
                body = (f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n").encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    proxy_url = f"http://127.0.0.1:{server.server_port}"
    # 精确模拟 HTTPX 读取 macOS 系统代理：不依赖测试机的环境变量或真实代理。
    monkeypatch.setattr(httpx._client, "get_environment_proxies", lambda: {"all://": proxy_url})
    pool = ProviderClientPool()
    local = ModelSettings(name="test", base_url=proxy_url + "/v1", api_key="test-key")
    external = ModelSettings(name="test", base_url="http://external.example.test/v1", api_key="test-key")
    leases, models = [], []
    try:
        for settings, status in [(local, 200), (external, 502)]:
            lease = await pool.acquire(settings)
            leases.append(lease)
            response = await lease.value.post(settings.base_url + "/chat/completions", json={})
            assert response.status_code == status
        for supplied in [None, leases[0].value]:
            model = create_openai_compatible_model(local, async_client=supplied)
            models.append(model)
            chunks = [chunk async for chunk in model.astream("only OK")]
            assert "".join(chunk.text for chunk in chunks) == "OK"
            if supplied is not None:
                assert model.http_async_client is supplied
        # 同步独立入口也直连；由模型/SDK关闭独立客户端，不关闭传入的共享 transport。
        sync_response = models[0].http_client.post(local.base_url + "/chat/completions", json={})
        assert sync_response.status_code == 200
        assert requests.count("http://external.example.test/v1/chat/completions") == 1
    finally:
        for model in models:
            model.root_client.close()
            if model.http_async_client not in [lease.value for lease in leases]:
                await model.root_async_client.close()
                assert model.http_async_client.is_closed
        if leases:
            assert not leases[0].value.is_closed
        for lease in leases:
            await lease.release()
        await pool.aclose()
        assert all(lease.value.is_closed for lease in leases)
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        thread.join()


@pytest.mark.parametrize("ca_source", ("SSL_CERT_FILE", "SSL_CERT_DIR"))
async def test_loopback_clients_preserve_certificate_environment(monkeypatch, tmp_path, ca_source) -> None:
    """回环仅绕过代理，Host 与独立模型各客户端仍读取指定 CA 并校验证书。"""
    ca_path = certifi.where() if ca_source == "SSL_CERT_FILE" else str(tmp_path)
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    monkeypatch.setenv(ca_source, ca_path)
    seen: list[str | None] = []
    original = ssl.create_default_context

    def create_context(*args, **kwargs):
        seen.append(kwargs.get("cafile" if ca_source == "SSL_CERT_FILE" else "capath"))
        context = original(*args, **kwargs)
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname
        return context

    monkeypatch.setattr(ssl, "create_default_context", create_context)
    settings = ModelSettings(name="test", base_url="https://localhost:3425/v1", api_key="test-only")
    pool = ProviderClientPool()
    lease, models = None, []
    try:
        lease = await pool.acquire(settings)
        assert seen == [ca_path]
        for supplied in (None, lease.value):
            before = len(seen)
            model = create_openai_compatible_model(settings, async_client=supplied)
            models.append(model)
            assert seen[before:] == [ca_path] * (2 if supplied is None else 1)
    finally:
        for model in models:
            model.root_client.close()
            if lease is None or model.http_async_client is not lease.value:
                await model.root_async_client.close()
        if lease is not None:
            await lease.release()
        await pool.aclose()
