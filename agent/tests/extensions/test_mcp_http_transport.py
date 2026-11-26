"""真实 MCP HTTP/SSE 经过受控系统代理时的路由、认证与重定向边界。"""

from __future__ import annotations

import json
import queue
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from harness_agent.extensions.mcp import McpConnectionManager, McpServerConfig


TOOL_NAMES = ("query_project_memory", "propose_project_memory_update", "list_team_knowledge", "read_team_knowledge")


@pytest.fixture
def endpoints(monkeypatch):
    """假代理返回502，本机服务提供四个真实可发现/调用的 MCP 工具。"""
    proxy_requests: list[str] = []
    local_headers: list[str | None] = []
    sessions: dict[str, queue.Queue] = {}
    stopped = threading.Event()

    class ProxyHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            proxy_requests.append(self.path)
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST

        def log_message(self, *_args) -> None:
            pass

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    proxy_url = f"http://127.0.0.1:{proxy.server_port}"

    class McpHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/redirect":
                self.send_response(307)
                self.send_header("Location", proxy_url + "/credential-sink")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path != "/sse":
                self.send_error(405)
                return
            session_id = str(uuid4())
            channel: queue.Queue = queue.Queue()
            sessions[session_id] = channel
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(f"event: endpoint\ndata: /messages/{session_id}\n\n".encode())
                self.wfile.flush()
                while not stopped.is_set():
                    try:
                        response = channel.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    self.wfile.write(f"event: message\ndata: {json.dumps(response)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                sessions.pop(session_id, None)

        def do_POST(self) -> None:
            local_headers.append(self.headers.get("Authorization"))
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            method = request["method"]
            if method == "initialize":
                result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "controlled", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": name, "description": "受控只读工具", "inputSchema": {"type": "object", "properties": {}}} for name in TOOL_NAMES]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "controlled MCP reply"}], "isError": False}
            else:
                result = {}
            response = {"jsonrpc": "2.0", "id": request.get("id"), "result": result}
            if self.path.startswith("/messages/"):
                if "id" in request:
                    sessions[self.path.rsplit("/", 1)[-1]].put(response)
                encoded, status = b"", 202
            elif "id" not in request:
                encoded, status = b"", 202
            else:
                encoded, status = json.dumps(response).encode(), 200
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *_args) -> None:
            pass

    local = ThreadingHTTPServer(("127.0.0.1", 0), McpHandler)
    threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (local, proxy)]
    for thread in threads:
        thread.start()
    monkeypatch.setattr(httpx._client, "get_environment_proxies", lambda: {"all://": proxy_url})
    try:
        yield SimpleNamespace(url=f"http://127.0.0.1:{local.server_port}", proxy_requests=proxy_requests, local_headers=local_headers)
    finally:
        stopped.set()
        for server in (local, proxy):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join()


@pytest.mark.parametrize(("transport", "source"), [("http", "session"), ("sse", "config"), ("http", "plugin:test"), ("sse", "plugin:test")])
async def test_loopback_mcp_discovers_and_calls_tools_without_system_proxy(endpoints, transport, source) -> None:
    config = McpServerConfig(name="workbench-context", transport=transport, url=endpoints.url + ("/mcp" if transport == "http" else "/sse"), headers={"Authorization": "Bearer TEST-ONLY"}, source=source, timeout_seconds=3)
    manager = McpConnectionManager([config])
    try:
        await manager.connect_all()
        assert {tool.name for tool in manager.get_tools()} == {f"workbench-context_{name}" for name in TOOL_NAMES}
        reply = await manager.get_tools()[0].ainvoke({})
        assert "controlled MCP reply" in str(reply)
        assert endpoints.local_headers and set(endpoints.local_headers) == {"Bearer TEST-ONLY"}
        assert endpoints.proxy_requests == []
    finally:
        await manager.close_all()


@pytest.mark.parametrize("transport", ("http", "sse"))
async def test_plugin_external_proxy_and_redirect_guard_are_preserved(endpoints, transport) -> None:
    config = McpServerConfig(name="external", transport=transport, url="http://external.example.test/mcp", headers={"Authorization": "Bearer TEST-ONLY"}, source="plugin:test")
    manager = McpConnectionManager([config])
    connection = manager._build_single_connection(config)
    auth, timeout = httpx.BasicAuth("test", "test"), httpx.Timeout(7, read=13)
    async with connection["httpx_client_factory"](headers=connection["headers"], timeout=timeout, auth=auth) as client:
        assert client.follow_redirects is False
        assert client.auth is auth
        assert client.timeout.read == 13
        assert client.headers["Authorization"] == "Bearer TEST-ONLY"
        response = await client.post(config.url, json={})
        assert response.status_code == 502
    assert endpoints.proxy_requests == [config.url]
    local = McpServerConfig(name="local", transport=transport, url=endpoints.url + "/redirect", headers={"Authorization": "Bearer TEST-ONLY"}, source="plugin:test")
    connection = manager._build_single_connection(local)
    async with connection["httpx_client_factory"](headers=connection["headers"]) as client:
        tls = client._transport._pool._ssl_context
        assert tls.verify_mode == ssl.CERT_REQUIRED
        assert tls.check_hostname
        response = await client.get(local.url)
        assert response.status_code == 307
    assert endpoints.proxy_requests == [config.url]
