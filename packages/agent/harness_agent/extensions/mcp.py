"""MCP (Model Context Protocol) 扩展协议：连接外部工具服务与生命周期管理。

【什么是 MCP，为什么需要它？】
MCP 是 Anthropic 发起的开放标准协议，用于连接大模型与外部系统（如 GitHub、数据库、浏览器自动化、Docker 等）。
通过 MCP，开发者无需为每个外部系统编写专有代码，只要启动对应的 MCP Server（本地命令行工具或远程 HTTP/SSE 服务），
Agent 即可动态发现并调用其提供的工具与数据资源。

【本模块的核心职责】
1. 配置安全解析（McpServerConfig）：解析并校验本地进程（stdio）或远程服务（http/sse）的配置，
   严格过滤非法名称与注入风险，并支持 `${ENV}` 环境变量安全求值；
2. 连接池与生命周期（McpConnectionManager）：基于资源租约（SharedResourceLease）管理长连接，
   支持并发连接数限制（最多 4 个并发连接，防止瞬间耗尽系统资源）与优雅关闭；
3. 工具适配与隔离（Tool Wrapping）：通过适配器将 MCP 远端工具无缝转换为 LangChain 标准的 BaseTool，
   自动添加超时保护（默认 60s）与错误脱敏，保证外部服务的异常不会导致 Agent 进程崩溃。

┌────────────────────────────────────────────────────────────────────────┐
│                 Harness MCP (模型上下文协议) 扩展集成架构              │
└────────────────────────────────────────────────────────────────────────┘

    .harness/settings.json (配置)
           │
           ▼
    [McpServerConfig 校验] ──> 解析 stdio / http / sse 配置，注入安全环境变量
           │
           ▼
    [McpConnectionManager 连接池]
           │
     ┌─────┴──────────────────────────────────────────────────────┐
     │ 并发限制与生命周期管理                                      │
     │                                                            │
     ▼ (stdio: 启动子进程)                   ▼ (http/sse: 远程网络) │
  [本地 MCP 服务: 如 git-mcp]            [远程 MCP 服务: 如 db-mcp]│
     │ (JSON-RPC over stdio)                │ (HTTP/SSE 流式交互)  │
     └─────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
    [McpToolWrapper 工具适配] ──> 转换为 LangChain BaseTool
                               │  - 命名空间隔离: mcp__{server}__{tool}
                               │  - 超时保护 (默认 60s)
                               │  - 错误安全脱敏
                               ▼
    注入 AgentTools 供大模型调用
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import time
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, cast
from urllib.parse import parse_qsl, urlsplit

from harness_agent.diagnostic_log.runtime import ensure_log
from harness_agent.runtime.resource_lifecycle import (
    ResourceScope,
    ResourceState,
    SharedResourceHandle,
    SharedResourceLease,
    SharedResourceUnavailableError,
)

logger = logging.getLogger(__name__)

_ENV_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
"""匹配 ${VAR} 环境变量引用语法。"""

DEFAULT_CONNECT_TIMEOUT_SECONDS = 30
"""MCP 服务器连接超时（秒）。"""

DEFAULT_TOOL_TIMEOUT_SECONDS = 60
"""MCP 工具调用超时（秒）。"""

_MAX_PARALLEL_CONNECTIONS = 4
"""同时建立的 MCP 连接上限，避免一次拉起过多子进程或网络会话。"""

TransportType = Literal["stdio", "http", "sse"]
"""支持的 MCP 传输类型。"""


class McpConfigError(ValueError):
    """MCP 配置在可信边界校验失败时抛出的安全错误。"""

    def __init__(self, code: str, message: str, *, field: str | None = None) -> None:
        """保存稳定错误码与字段路径，不回显配置秘密。"""
        super().__init__(message)
        self.code = code
        self.field = field


@dataclass(frozen=True, slots=True)
class McpServerConfig:
    """一个 MCP 服务器的已校验配置。"""

    name: str
    transport: TransportType
    command: str | None = None
    args: tuple[str, ...] = ()
    env: Mapping[str, str] = field(default_factory=dict)
    url: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout_seconds: float = DEFAULT_CONNECT_TIMEOUT_SECONDS
    cwd: str | None = None
    source: str = "config"
    source_fingerprint: str | None = None
    inherit_environment: bool = True
    plugin_root: str | None = None
    plugin_data: str | None = None
    # Qwen 已冻结 executable 后不需要宿主 PATH；Claude/portable 保持默认兼容。
    inherit_path: bool = True

    def __post_init__(self) -> None:
        """冻结嵌套映射，避免快照建立后仍被调用方修改。"""
        object.__setattr__(self, "args", tuple(self.args))
        object.__setattr__(self, "env", MappingProxyType(dict(self.env)))
        object.__setattr__(self, "headers", MappingProxyType(dict(self.headers)))
        object.__setattr__(self, "timeout_seconds", float(self.timeout_seconds))
        if self.cwd is not None and not self.cwd.strip():
            raise McpConfigError("MCP_CWD_INVALID", "MCP cwd 不能为空", field="mcp.servers.cwd")
        if not self.source:
            raise McpConfigError("MCP_SOURCE_INVALID", "MCP source 不能为空")

    @classmethod
    def from_mapping(cls, entry: Mapping[str, object]) -> "McpServerConfig":
        """把协议或 TOML 映射规范化为唯一的 MCP 配置值对象。"""
        name = entry.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", name.strip()):
            raise McpConfigError(
                "MCP_SERVER_NAME_INVALID",
                f"Invalid server name {name!r}: only [a-zA-Z0-9_-] allowed",
                field="mcp.servers.name",
            )
        name = name.strip()
        transport = entry.get("transport", "stdio")
        if transport not in ("stdio", "http", "sse"):
            raise McpConfigError(
                "MCP_TRANSPORT_INVALID",
                f"Unsupported MCP transport {transport!r}",
                field="mcp.servers.transport",
            )
        timeout = entry.get("timeout", DEFAULT_CONNECT_TIMEOUT_SECONDS)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(float(timeout))
            or timeout <= 0
        ):
            raise McpConfigError("MCP_TIMEOUT_INVALID", "MCP 连接超时无效", field="mcp.servers.timeout")

        if transport == "stdio":
            command = entry.get("command")
            if not isinstance(command, str) or not command.strip():
                raise McpConfigError(
                    "MCP_COMMAND_REQUIRED",
                    "stdio transport requires 'command'",
                    field="mcp.servers.command",
                )
            args = _string_sequence(entry.get("args", ()), "mcp.servers.args")
            env = _string_mapping(entry.get("env", {}), "mcp.servers.env")
            return cls(
                name=name,
                transport="stdio",
                command=command.strip(),
                args=args,
                env=env,
                timeout_seconds=float(timeout),
            )

        url = entry.get("url")
        if not isinstance(url, str) or not url.strip():
            raise McpConfigError(
                "MCP_URL_REQUIRED",
                f"{transport} transport requires 'url'",
                field="mcp.servers.url",
            )
        headers = _string_mapping(entry.get("headers", {}), "mcp.servers.headers")
        return cls(
            name=name,
            transport=transport,  # type: ignore[arg-type]
            url=url.strip(),
            headers=headers,
            timeout_seconds=float(timeout),
        )

    def to_document(self) -> dict[str, object]:
        """转换为不含额外运行时状态的 TOML MCP 条目。"""
        result: dict[str, object] = {"name": self.name, "transport": self.transport}
        if self.transport == "stdio":
            result["command"] = self.command
            if self.args:
                result["args"] = list(self.args)
            if self.env:
                result["env"] = dict(self.env)
        else:
            result["url"] = self.url
            if self.headers:
                result["headers"] = dict(self.headers)
        if self.timeout_seconds != DEFAULT_CONNECT_TIMEOUT_SECONDS:
            result["timeout"] = self.timeout_seconds
        return result


def _string_sequence(value: object, field_name: str) -> tuple[str, ...]:
    """校验字符串数组，禁止写服务隐式转换任意对象。"""
    if not isinstance(value, (list, tuple)) or not all(isinstance(item, str) for item in value):
        raise McpConfigError("MCP_FIELD_INVALID", "MCP 字段类型无效", field=field_name)
    return tuple(value)


def _string_mapping(value: object, field_name: str) -> dict[str, str]:
    """校验字符串映射，返回与输入隔离的副本。"""
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        raise McpConfigError("MCP_FIELD_INVALID", "MCP 字段类型无效", field=field_name)
    return dict(value)


def parse_mcp_config(mcp_section: dict[str, Any] | None) -> list[McpServerConfig]:
    """从 TOML [mcp] 区段解析服务器配置列表。

    无效配置记录警告并跳过，不阻止 sidecar 启动。
    环境变量 ${VAR} 在此阶段不展开，延迟到连接时解析。
    """
    if not mcp_section or not isinstance(mcp_section, dict):
        return []
    servers_raw = mcp_section.get("servers")
    if not isinstance(servers_raw, list):
        if servers_raw is not None:
            logger.warning("mcp.servers must be an array of tables; ignoring")
        return []

    configs: list[McpServerConfig] = []
    for idx, entry in enumerate(servers_raw):
        if not isinstance(entry, dict):
            logger.warning("mcp.servers[%d] is not a table; skipping", idx)
            continue
        config = _parse_single_server(entry, idx)
        if config is not None:
            configs.append(config)
    return configs


def _parse_single_server(entry: dict[str, Any], idx: int) -> McpServerConfig | None:
    """校验并解析单个 MCP 服务器配置条目。"""
    try:
        return McpServerConfig.from_mapping(entry)
    except McpConfigError as exc:
        if exc.code == "MCP_TIMEOUT_INVALID":
            # 启动时保持历史兼容：损坏的超时回退默认值；交互式写入仍严格拒绝。
            normalized = dict(entry)
            normalized["timeout"] = DEFAULT_CONNECT_TIMEOUT_SECONDS
            try:
                return McpServerConfig.from_mapping(normalized)
            except McpConfigError:
                pass
        logger.warning("mcp.servers[%d] rejected: %s", idx, exc)
        return None


def expand_env_vars(value: str) -> str | None:
    """展开字符串中的 ${VAR} 引用；任一变量缺失时返回 None。"""
    missing: list[str] = []

    def _replace(match: re.Match[str]) -> str:
        var_name = match.group(1)
        env_value = os.environ.get(var_name)
        if env_value is None:
            missing.append(var_name)
            return ""
        return env_value

    result = _ENV_VAR_RE.sub(_replace, value)
    if missing:
        logger.warning(
            "MCP environment variable(s) not set: %s", ", ".join(sorted(set(missing)))
        )
        return None
    return result


def _server_status(
    config: McpServerConfig,
    status: str,
    *,
    error: str | None = None,
) -> dict[str, object]:
    """构造不含连接对象的单 server 状态记录。"""
    result: dict[str, object] = {
        "name": config.name,
        "transport": config.transport,
        "source": config.source,
        "status": status,
    }
    if error is not None:
        result["error"] = error
    return result


def _create_plugin_http_client(
    headers: dict[str, str] | None = None,
    timeout: Any | None = None,
    auth: Any | None = None,
) -> Any:
    """为 Plugin HTTP/SSE 禁用自动 redirect，避免认证 header 跨 origin 传播。"""
    import httpx

    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout,
        auth=auth,
        follow_redirects=False,
    )


def mcp_server_fingerprint(config: McpServerConfig) -> str:
    """MCP server canonical id 的不可逆 hash，不含 URL、command、args、header 或 env。"""
    from harness_agent.runtime.agent_engine_profile import component_fingerprint

    return component_fingerprint(
        {
            "name": config.name,
            "transport": config.transport,
            "source": config.source,
        }
    )


def _mark_mcp_tool(tool: Any, server_name: str) -> None:
    """给 MCP 工具打上类型与配置名诊断标记；失败不影响工具本身。"""
    try:
        object.__setattr__(tool, "_harness_tool_kind", "mcp")
        object.__setattr__(tool, "_harness_mcp_server_name", server_name)
    except Exception:
        try:
            tool._harness_tool_kind = "mcp"
            tool._harness_mcp_server_name = server_name
        except Exception:
            metadata = getattr(tool, "metadata", None)
            if isinstance(metadata, dict):
                metadata["harness_tool_kind"] = "mcp"
                metadata["harness_mcp_server_name"] = server_name


def _duplicate_tools_message(skipped_names: Sequence[str]) -> str | None:
    """把被丢弃的重名工具整理成给用户看的一句话；没有重名时返回 None。"""
    if not skipped_names:
        return None
    shown = ", ".join(skipped_names[:5])
    extra = f" 等 {len(skipped_names)} 个" if len(skipped_names) > 5 else ""
    return f"{len(skipped_names)} 个工具与已加载工具重名，已忽略: {shown}{extra}"


def mcp_server_name_of(tool: Any) -> str | None:
    """读取 ``_mark_mcp_tool`` 写入的归属服务器名；未标记时返回 None。

    写入有三层兑底（__setattr__ → 实例属性 → metadata），读取需对应三层；
    diagnostic_log/middleware.py 也按同序读取，避免两处不一致。
    """
    marked = getattr(tool, "_harness_mcp_server_name", None)
    if isinstance(marked, str) and marked:
        return marked
    metadata = getattr(tool, "metadata", None)
    if isinstance(metadata, dict):
        fallback = metadata.get("harness_mcp_server_name")
        if isinstance(fallback, str) and fallback:
            return fallback
    return None


def tool_belongs_to_server(tool: Any, server_name: str) -> bool:
    """判断工具是否归属指定服务器；所有需要"工具属于哪个服务器"的地方必须用它。

    优先读 ``mcp_server_name_of`` 的标记；未标记的工具（加载异常路径，或测试里
    用 ``dict`` 表示的工具）退化为 ``{server_name}_`` 前缀匹配。退化路径在服务器名
    互为前缀时会误判，所以不得在这个函数之外再写一份前缀匹配。
    """
    marked = mcp_server_name_of(tool)
    if marked is not None:
        return marked == server_name
    name = tool.get("name", "") if isinstance(tool, Mapping) else getattr(tool, "name", "")
    return isinstance(name, str) and name.startswith(f"{server_name}_")


def mcp_config_fingerprint(configs: list[McpServerConfig]) -> str:
    """计算 MCP 配置的脱敏 SHA-256 指纹。

    包含所有影响运行行为的非秘密字段：name、transport、command（stdio）、
    url（http/sse）、args、env 变量名列表（仅 key）、header 引用名列表（仅 key）、
    timeout_seconds、来源、包内容指纹、cwd 与环境继承策略。不包含 env
    变量值、header 值或任何 token/秘密。
    无配置时返回与 {"transport": "disabled"} 一致的固定值。
    """
    from harness_agent.runtime.agent_engine_profile import component_fingerprint

    if not configs:
        return component_fingerprint({"transport": "disabled"})
    entries = []
    for c in sorted(configs, key=lambda c: c.name):
        entries.append(_engine_identity_for_server(c))
    return component_fingerprint({"servers": entries})


def _engine_identity_for_server(config: McpServerConfig) -> dict[str, object]:
    """返回包含运行字段但不包含凭据值的服务器身份。"""
    identity: dict[str, object] = {
        "name": config.name,
        "transport": config.transport,
        "args": tuple(config.args),
        "env_keys": tuple(sorted(config.env)),
        "header_keys": tuple(sorted(config.headers)),
        "timeout_seconds": config.timeout_seconds,
        "cwd": config.cwd,
        "source": config.source,
        "source_fingerprint": config.source_fingerprint,
        "inherit_environment": config.inherit_environment,
        "inherit_path": config.inherit_path,
    }
    if config.transport == "stdio":
        identity["command"] = config.command
    else:
        identity["url"] = _safe_url_identity(config.url or "")
    return identity


def _safe_url_identity(url: str) -> Mapping[str, object]:
    """提取 URL 的连接形状，避免认证 query 值和用户信息进入身份。"""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return MappingProxyType({"invalid": True})
    try:
        port = parsed.port
    except ValueError:
        port = None
    query: list[tuple[str, str]] = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        safe_value = "<redacted>" if any(
            marker in lowered for marker in ("token", "auth", "key", "secret", "password", "credential")
        ) else value
        query.append((key, safe_value))
    return MappingProxyType(
        {
            "scheme": parsed.scheme,
            "hostname": parsed.hostname or "",
            "port": port,
            "path": parsed.path,
            "query": tuple(sorted(query)),
        }
    )


def _freeze(value: object) -> object:
    """递归冻结快照身份中的映射、列表和集合。"""
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return frozenset(_freeze(item) for item in value)
    return value


@dataclass(frozen=True, slots=True)
class McpConfigSnapshot:
    """Host 认可的不可变 MCP 配置快照。

    作为 McpConnectionManager 和 AgentEngineProfile 的唯一配置真相来源，
    消除持久化文件、连接管理器和 AgentEngine 身份之间的多副本不一致。
    """

    servers: tuple[McpServerConfig, ...]
    digest: str
    revision: str
    engine_identity: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """冻结传入的服务器序列和身份摘要，防止绕过 builder 修改快照。"""
        object.__setattr__(self, "servers", tuple(self.servers))
        object.__setattr__(self, "engine_identity", _freeze(self.engine_identity))


def build_mcp_snapshot(servers: Sequence[McpServerConfig], revision: str) -> McpConfigSnapshot:
    """从已校验配置列表构建不可变 MCP 快照。

    servers 按 name 排序后冻结；digest 使用扩充后的 fingerprint；
    engine_identity 包含脱敏的运行相关字段摘要。
    """
    from harness_agent.runtime.agent_engine_profile import component_fingerprint

    ordered = tuple(sorted(servers, key=lambda c: c.name))
    fingerprint = mcp_config_fingerprint(list(ordered))
    identity: dict[str, object] = {
        "server_count": len(ordered),
        "fingerprint": fingerprint,
        "servers": [_engine_identity_for_server(c) for c in ordered],
    }
    return McpConfigSnapshot(
        servers=ordered,
        digest=fingerprint,
        revision=revision,
        engine_identity=_freeze(identity),  # type: ignore[arg-type]
    )


@dataclass(slots=True)
class _McpRuntime:
    """一个 immutable MCP snapshot 对应的 Host 级连接和工具集合。"""

    snapshot: McpConfigSnapshot
    tools: list[Any] = field(default_factory=list)
    client: Any | None = None
    connected: bool = False
    server_statuses: dict[str, dict[str, object]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class _McpConnectionAttempt:
    """单个 MCP 服务器连接结果，供并发完成后按配置顺序归并。"""

    started: float
    completed: float
    tools: tuple[Any, ...] = ()
    error: BaseException | None = None
    summary_code: str | None = None


class McpConnectionManager:
    """管理所有 MCP 服务器的连接生命周期和工具加载。

    使用 langchain-mcp-adapters 的 MultiServerMCPClient 建立连接，
    将 MCP 工具转换为 LangChain BaseTool 供 Agent 使用。
    """

    def __init__(
        self,
        snapshot: McpConfigSnapshot | Sequence[McpServerConfig],
        *,
        diagnostic_log: Any | None = None,
    ) -> None:
        """保存初始快照，并把每个连接快照置于 Host owner 之下。"""
        if not isinstance(snapshot, McpConfigSnapshot):
            snapshot = build_mcp_snapshot(snapshot, revision="legacy")
        self._resources: dict[str, list[SharedResourceHandle[_McpRuntime]]] = {}
        self._current_resource = self._create_resource(snapshot)
        self._resources[snapshot.digest] = [self._current_resource]
        self._diagnostic_log = ensure_log(diagnostic_log)
        self._connected_at: dict[str, float] = {}

    @property
    def snapshot(self) -> McpConfigSnapshot:
        """返回当前连接管理器认可的配置快照。"""
        return self._current_resource.value.snapshot

    @property
    def connected(self) -> bool:
        """是否已成功建立至少一次连接。"""
        return self._current_resource.value.connected

    def get_tools(self) -> list[Any]:
        """返回当前 snapshot 的工具副本（LangChain BaseTool）。"""
        return list(self._current_resource.value.tools)

    def get_tool_names(self) -> list[str]:
        """返回所有 MCP 工具的名称，用于审批注册。"""
        return [tool.name for tool in self._current_resource.value.tools]

    async def acquire(
        self,
        snapshot_or_digest: McpConfigSnapshot | str,
    ) -> SharedResourceLease[_McpRuntime]:
        """借用指定 MCP snapshot；AgentEngine 关闭时只释放租约。"""
        digest = (
            snapshot_or_digest.digest
            if isinstance(snapshot_or_digest, McpConfigSnapshot)
            else snapshot_or_digest
        )
        for resource in reversed(self._resources.get(digest, ())):
            if resource.state is not ResourceState.READY:
                continue
            try:
                return await resource.acquire()
            except SharedResourceUnavailableError:
                continue
        raise RuntimeError("MCP_RESOURCE_SNAPSHOT_UNAVAILABLE")

    def get_server_statuses(self) -> list[dict[str, object]]:
        """返回每个 MCP 服务器的连接状态和工具列表。

        工具归属读加载时 ``_mark_mcp_tool`` 写入的标记；服务器名可含下划线且
        互相为前缀（my / my_server），按 ``{server}_`` 前缀匹配会让较短名（my）
        多认领较长名（my_server）的工具。未标记的工具（异常路径）按前缀退化
        匹配（标记缺失本身已在 ``_mark_mcp_tool`` 的兑底路径处理）。
        """
        runtime = self._current_resource.value
        result: list[dict[str, object]] = []
        for config in runtime.snapshot.servers:
            entry = dict(runtime.server_statuses.get(config.name, {
                "name": config.name,
                "transport": config.transport,
                "source": config.source,
                "status": "failed",
                "error": "not connected",
            }))
            entry.setdefault("source", config.source)
            entry["tool_names"] = [
                t.name for t in runtime.tools
                if hasattr(t, "name") and tool_belongs_to_server(t, config.name)
            ]
            result.append(entry)
        return result

    def unavailable_server_names(self) -> list[str]:
        """返回当前连接失败或被跳过的服务器名，供 ``tool_search`` 提示模型。

        只返回名字，不带错误原文：错误文本可能含 URL 或本机路径，不应进入模型上下文。
        每次调用都读最新状态，服务器恢复后提示会自动消失。
        """
        runtime = self._current_resource.value
        return [
            config.name
            for config in runtime.snapshot.servers
            if runtime.server_statuses.get(config.name, {}).get("status") in ("failed", "skipped")
        ]

    def _create_resource(
        self,
        snapshot: McpConfigSnapshot,
    ) -> SharedResourceHandle[_McpRuntime]:
        """创建一个由 Host owner 持有的 MCP snapshot resource。"""
        runtime = _McpRuntime(snapshot=snapshot)
        return SharedResourceHandle(
            name=f"mcp-snapshot:{snapshot.digest[:12]}",
            scope=ResourceScope.HOST,
            value=runtime,
            close=lambda: self._close_runtime(runtime),
        )

    async def _close_runtime(self, runtime: _McpRuntime) -> None:
        """关闭单个 snapshot 的 transport；不会影响其他 snapshot。"""
        client = runtime.client
        close = getattr(client, "aclose", None) if client is not None else None
        if close is None and client is not None:
            close = getattr(client, "close", None)
        if callable(close):
            result = close()
            if asyncio.iscoroutine(result) or hasattr(result, "__await__"):
                await cast(Awaitable[object], result)
        runtime.client = None
        runtime.tools = []
        runtime.connected = False

    def _set_current_snapshot(self, snapshot: McpConfigSnapshot) -> _McpRuntime:
        """切换当前快照，但保留旧 snapshot resource 供旧引擎继续借用。"""
        resources = self._resources.setdefault(snapshot.digest, [])
        resource = next(
            (candidate for candidate in reversed(resources) if candidate.state is ResourceState.READY),
            None,
        )
        if resource is None:
            resource = self._create_resource(snapshot)
            resources.append(resource)
        self._current_resource = resource
        return resource.value

    async def _reap_closed_resources(self) -> None:
        """回收已排空且没有 AgentEngine 借用的旧 snapshot resource。"""
        for digest, resources in tuple(self._resources.items()):
            remaining: list[SharedResourceHandle[_McpRuntime]] = []
            for resource in resources:
                if resource is self._current_resource:
                    remaining.append(resource)
                    continue
                snapshot = await resource.snapshot()
                if snapshot.state is ResourceState.DRAINING and not snapshot.borrowers:
                    await resource.close()
                    continue
                remaining.append(resource)
            if remaining:
                self._resources[digest] = remaining
            else:
                self._resources.pop(digest, None)

    async def reap(self) -> None:
        """在旧 AgentEngine 释放租约后回收已排空的 MCP snapshot。"""
        await self._reap_closed_resources()

    async def add_server(self, config: McpServerConfig) -> dict[str, object]:
        """为新配置创建独立 Host snapshot；旧图继续使用旧工具对象。"""
        current = self._current_resource.value
        snapshot = build_mcp_snapshot(
            [*current.snapshot.servers, config],
            revision=current.snapshot.revision,
        )
        await self.apply_snapshot(snapshot)
        return next(
            (
                item
                for item in self.get_server_statuses()
                if item.get("name") == config.name
            ),
            {
                "name": config.name,
                "transport": config.transport,
                "source": config.source,
                "status": "failed",
                "error": "not connected",
                "tool_names": [],
            },
        )

    def remove_server(self, name: str) -> bool:
        """运行时移除指定 MCP 服务器的工具并更新状态。

        Returns:
            是否找到并移除了该服务器。
        """
        old_runtime = self._current_resource.value
        found = any(config.name == name for config in old_runtime.snapshot.servers) or name in old_runtime.server_statuses
        new_configs = [c for c in old_runtime.snapshot.servers if c.name != name]
        snapshot = build_mcp_snapshot(new_configs, revision=old_runtime.snapshot.revision)
        runtime = self._set_current_snapshot(snapshot)

        # 复制未删除服务器的工具到新 snapshot；旧 runtime 列表保持不变。
        # 归属判定与 get_server_statuses 一致：优先读标记，避免服务器名互前缀误删。
        runtime.tools = [
            tool for tool in old_runtime.tools
            if not (hasattr(tool, "name") and tool_belongs_to_server(tool, name))
        ]
        runtime.server_statuses = {
            server_name: dict(status)
            for server_name, status in old_runtime.server_statuses.items()
            if server_name != name
        }
        runtime.connected = old_runtime.connected
        if found:
            runtime.server_statuses[name] = {
                "name": name,
                "transport": old_runtime.server_statuses.get(name, {}).get("transport", "stdio"),
                "source": old_runtime.server_statuses.get(name, {}).get("source", "config"),
                "status": "removed",
                "tool_names": [],
            }
        logger.info("MCP server '%s' removed", name)
        return found

    async def apply_snapshot(self, snapshot: McpConfigSnapshot) -> list[dict[str, object]]:
        """切换当前快照；旧 connection resource 由 Host owner 保留至关闭。"""
        old_resource = self._current_resource
        runtime = self._set_current_snapshot(snapshot)
        if old_resource is not self._current_resource:
            await old_resource.begin_draining(reason="mcp_snapshot_changed")
        if runtime.connected:
            return self.get_server_statuses()
        runtime.server_statuses.clear()
        runtime.tools = []
        runtime.client = None
        runtime.connected = False
        await self.connect_all()
        return self.get_server_statuses()

    async def connect_all(self) -> None:
        """建立所有已配置 MCP 服务器的连接并加载工具。

        连接失败的服务器记录警告并跳过，不阻止 Agent 启动。
        """
        runtime = self._current_resource.value
        if runtime.connected:
            return
        configs = runtime.snapshot.servers
        if not configs:
            runtime.connected = True
            return

        from langchain_mcp_adapters.client import MultiServerMCPClient

        connections = self._build_connections()
        if not connections:
            logger.warning("No valid MCP connections after environment expansion")
            runtime.connected = True
            return

        config_by_name = {config.name: config for config in configs if config.name in connections}
        try:
            runtime.client = MultiServerMCPClient(connections, tool_name_prefix=True)
        except Exception as exc:
            logger.warning("MCP client construction failed: %s; continuing", exc)
            runtime.tools = []
            runtime.connected = True
            for name, config in config_by_name.items():
                runtime.server_statuses[name] = _server_status(config, "failed", error=str(exc))
                self._log_connection_failed(config, started=time.monotonic(), error=exc, summary_code="MCP_CLIENT_FAILED")
            return

        connection_items = list(config_by_name.items())
        limiter = asyncio.Semaphore(_MAX_PARALLEL_CONNECTIONS)
        attempts = await asyncio.gather(*(
            self._load_server_tools(runtime.client, name, config, limiter)
            for name, config in connection_items
        ))

        # gather 保留输入顺序；连接可以乱序完成，但工具优先级和去重结果必须稳定。
        runtime.tools = []
        seen_tool_names: set[str] = set()
        for (name, config), attempt in zip(connection_items, attempts, strict=True):
            if attempt.error is not None:
                if attempt.summary_code == "MCP_CONNECT_TIMEOUT":
                    logger.warning("MCP server %r connection timed out; continuing", name)
                    error_message = "connection timed out"
                else:
                    logger.warning(
                        "MCP server %r connection failed: %s; continuing",
                        name,
                        attempt.error,
                    )
                    error_message = str(attempt.error)
                runtime.server_statuses[name] = _server_status(
                    config, "failed", error=error_message
                )
                self._log_connection_failed(
                    config,
                    started=attempt.started,
                    completed_at=attempt.completed,
                    error=attempt.error,
                    summary_code=attempt.summary_code or "MCP_CONNECT_FAILED",
                )
                continue

            loaded = 0
            skipped_names: list[str] = []
            for tool in attempt.tools:
                tool_name = getattr(tool, "name", None)
                if isinstance(tool_name, str) and tool_name in seen_tool_names:
                    skipped_names.append(tool_name)
                    # D-1 同类：同名工具（如 my/server_search 与 my_server/search）
                    # 第一个赢、第二个静默丢弃，模型与用户都无法诊断，记 warning 兜底。
                    logger.warning(
                        "MCP server %r tool %r conflicts with an already-loaded tool; skipped",
                        name,
                        tool_name,
                    )
                    continue
                if isinstance(tool_name, str):
                    seen_tool_names.add(tool_name)
                _mark_mcp_tool(tool, name)
                runtime.tools.append(tool)
                loaded += 1
            # 服务器本身是连上的，所以 status 保持 connected；被丢弃的重名工具写进
            # error 字段，/mcp 面板才看得到（复用现有字段，不新增协议字段）。
            runtime.server_statuses[name] = _server_status(
                config,
                "connected",
                error=_duplicate_tools_message(skipped_names),
            )
            self._connected_at[name] = attempt.started
            self._log_connection_completed(
                config,
                started=attempt.started,
                completed_at=attempt.completed,
                tool_count=loaded,
            )
        runtime.connected = True
        logger.info(
            "MCP connection attempts complete: %d server(s), %d tool(s) loaded",
            len(connections), len(runtime.tools),
        )

    async def _load_server_tools(
        self,
        client: Any,
        name: str,
        config: McpServerConfig,
        limiter: asyncio.Semaphore,
    ) -> _McpConnectionAttempt:
        """在并发上限内加载单个服务器工具，并保留独立超时和错误。"""
        async with limiter:
            started = time.monotonic()
            try:
                tools = await asyncio.wait_for(
                    client.get_tools(server_name=name),
                    timeout=config.timeout_seconds,
                )
                return _McpConnectionAttempt(
                    started=started,
                    completed=time.monotonic(),
                    tools=tuple(tools),
                )
            except asyncio.TimeoutError as exc:
                return _McpConnectionAttempt(
                    started=started,
                    completed=time.monotonic(),
                    error=exc,
                    summary_code="MCP_CONNECT_TIMEOUT",
                )
            except Exception as exc:
                return _McpConnectionAttempt(
                    started=started,
                    completed=time.monotonic(),
                    error=exc,
                    summary_code="MCP_CONNECT_FAILED",
                )

    async def close_all(self) -> None:
        """由 Host owner 关闭所有 snapshot connection，不被单个引擎调用。"""
        resources = [
            resource
            for candidates in self._resources.values()
            for resource in candidates
        ]
        if resources:
            try:
                runtime = self._current_resource.value
            except Exception:
                runtime = None
            if runtime is not None:
                for config in runtime.snapshot.servers:
                    started = self._connected_at.pop(config.name, None)
                    duration_ms = (
                        max(0, round((time.monotonic() - started) * 1000))
                        if started is not None
                        else 0
                    )
                    self._diagnostic_log.info(
                        "mcp.connection.closed",
                        {
                            "server_name": config.name,
                            "server_fingerprint": mcp_server_fingerprint(config),
                            "outcome": "closed",
                            "duration_ms": duration_ms,
                        },
                    )
        self._resources = {}
        for resource in resources:
            await resource.begin_draining(reason="host_shutdown")
            try:
                await resource.close()
            except Exception:
                await resource.close(force=True)
        logger.info("MCP connections closed")

    def _log_connection_completed(
        self,
        config: McpServerConfig,
        *,
        started: float,
        completed_at: float | None = None,
        tool_count: int,
    ) -> None:
        finished = time.monotonic() if completed_at is None else completed_at
        self._diagnostic_log.info(
            "mcp.connection.completed",
            {
                "server_name": config.name,
                "server_fingerprint": mcp_server_fingerprint(config),
                "transport": config.transport,
                "duration_ms": max(0, round((finished - started) * 1000)),
                "tool_count": tool_count,
            },
        )

    def _log_connection_failed(
        self,
        config: McpServerConfig,
        *,
        started: float,
        completed_at: float | None = None,
        error: BaseException,
        summary_code: str,
    ) -> None:
        finished = time.monotonic() if completed_at is None else completed_at
        self._diagnostic_log.warn(
            "mcp.connection.failed",
            {
                "server_name": config.name,
                "server_fingerprint": mcp_server_fingerprint(config),
                "transport": config.transport,
                "duration_ms": max(0, round((finished - started) * 1000)),
                "failure_stage": "connect",
                "error_type": type(error).__name__,
                "summary_code": summary_code,
                "retryable": summary_code == "MCP_CONNECT_TIMEOUT",
            },
        )

    def _build_connections(self) -> dict[str, Any]:
        """将 McpServerConfig 列表转换为 MultiServerMCPClient 的 connections 字典。

        用户 MCP 在此时展开环境变量；portable Plugin MCP 已在 adapter 中完成
        保留 placeholder 替换，运行时保持其余字段字面值。
        """
        runtime = self._current_resource.value
        connections: dict[str, Any] = {}
        for config in runtime.snapshot.servers:
            conn = self._build_single_connection(config)
            if conn is not None:
                connections[config.name] = conn
            else:
                # 环境变量缺失导致跳过，记录 skipped 状态
                runtime.server_statuses[config.name] = {
                    "name": config.name,
                    "transport": config.transport,
                    "source": config.source,
                    "status": "skipped",
                    "error": "environment variable(s) not set",
                }
        return connections

    def _build_single_connection(self, config: McpServerConfig) -> dict[str, Any] | None:
        """构建单个服务器的连接参数；环境变量缺失时返回 None。"""
        is_portable_plugin = config.plugin_root is not None
        is_plugin_source = config.source.startswith("plugin:")
        if config.transport == "stdio":
            if is_portable_plugin:
                command = config.command or ""
                args = list(config.args)
                env = dict(config.env)
            else:
                command = expand_env_vars(config.command or "")
                if command is None:
                    logger.warning("MCP server %r: missing env vars in command; skipping", config.name)
                    return None
                args = []
                for arg in config.args:
                    expanded = expand_env_vars(arg)
                    if expanded is None:
                        logger.warning("MCP server %r: missing env vars in args; skipping", config.name)
                        return None
                    args.append(expanded)
                env = {}
                for key, value in config.env.items():
                    expanded = expand_env_vars(value)
                    if expanded is None:
                        logger.warning(
                            "MCP server %r: missing env var for %s; skipping", config.name, key
                        )
                        return None
                    env[key] = expanded
            if config.inherit_environment:
                process_env = env or None
            else:
                # Plugin MCP 不继承 API Key 等宿主环境；只保留命令查找和临时目录所需字段。
                process_env = {
                    key: value
                    for key in ("PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC")
                    if (config.inherit_path or key != "PATH")
                    and (value := os.environ.get(key))
                }
                process_env.update(env)
            if is_portable_plugin and config.plugin_root and config.plugin_data:
                if process_env is None:
                    process_env = {}
                process_env["PLUGIN_ROOT"] = config.plugin_root
                process_env["PLUGIN_DATA"] = config.plugin_data
            connection: dict[str, Any] = {
                "transport": "stdio",
                "command": command,
                "args": args,
                "env": process_env or None,
            }
            if config.cwd is not None:
                if is_portable_plugin:
                    connection["cwd"] = config.cwd
                else:
                    cwd = expand_env_vars(config.cwd)
                    if cwd is None:
                        logger.warning("MCP server %r: missing env vars in cwd; skipping", config.name)
                        return None
                    connection["cwd"] = cwd
            return connection

        # http / sse
        if is_portable_plugin:
            url = config.url or ""
            headers = dict(config.headers)
        else:
            url = expand_env_vars(config.url or "")
            if url is None:
                logger.warning("MCP server %r: missing env vars in url; skipping", config.name)
                return None
            headers = {}
            for key, value in config.headers.items():
                expanded = expand_env_vars(value)
                if expanded is None:
                    logger.warning(
                        "MCP server %r: missing env var in header %s; skipping", config.name, key
                    )
                    return None
                headers[key] = expanded

        # langchain-mcp-adapters 0.2.x 使用 "streamable_http" 作为 HTTP 传输键
        transport_key = "streamable_http" if config.transport == "http" else "sse"
        conn: dict[str, Any] = {
            "transport": transport_key,
            "url": url,
        }
        if headers:
            conn["headers"] = headers
        # Claude `.mcp.json` 与 portable `mcp.json` 保留各自的 placeholder、
        # environment 和 timeout 语义；但两者都是已安装 Plugin 的 header 来源，
        # 都不能让凭据随跨源 redirect 自动转发。
        if is_portable_plugin or is_plugin_source:
            conn["httpx_client_factory"] = _create_plugin_http_client
        return conn
