"""AgentHost 服务面的窄接口与传输无关的数据类。

【这是做什么的？】
这个模块只放两样东西：

1. `HostSnapshot` 之类「服务方法返回什么」的不可变数据类。顶层容器都是新建的对象，
   但内部元素（例如 `agent_commands` 里的字典）不保证深拷贝，调用方应当只读使用，
   不要原地修改。
2. `HostServicePort`：一个 `typing.Protocol`，列出 ACP 侧（`AcpServer`）允许调用的
   全部 Host 方法。AcpServer 只依赖这个 Protocol，`AgentHost` 满足它即可。
   服务方法直接长在 `AgentHost` 上（不新建服务类），测试用一致性用例锁住这条契约。

【上下游】
- 上游：`harness_agent.host.agent_host.AgentHost` 是唯一实现者。
- 下游：`harness_agent.host.acp.server.AcpServer`（S1）只依赖这里的 Protocol 与数据类。
- 这里不放任何业务逻辑，也不 import `agent_host`，避免循环依赖。

【为什么服务方法显式收 `conn`】
v3 处理器从 ContextVar 取「当前连接」。ACP 路径没有这条 ContextVar，如果服务方法
继续隐式读取，会悄悄读到休眠的 owner 连接。显式传参后，「用了哪条连接」在签名上就可见，
AST 测试也能机械检查服务方法体里没有 `_current_connection` 之类的环境读取。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from harness_agent.host.connection import ProtocolConnection, RpcError
    from harness_agent.host.run_coordinator import (
        ApprovalModeResult,
        CancelResult,
        InteractionMode,
        RunError,
        RunInput,
    )
    from harness_agent.threads.thread_records import ThreadSummary

ApprovalModeName = Literal["plan", "default", "auto-edit", "auto", "yolo"]


@dataclass(frozen=True, slots=True)
class HostSnapshot:
    """一次资源初始化完成后可安全下发给客户端的 Host 快照。

    快照在 `ensure_ready` 返回时同步取得；与重构前「在打开线程库之后才读取」相比，
    读取时机提前了一个 await，只有 catalog 在这个极短窗口内变化才会有差别。

    字段含义：
    - `agent_commands`：当前 Skill/Plugin catalog 解析出的斜杠命令列表（拷贝）。
    - `skills_snapshot`：`{"id": ..., "count": ...}` 形状的轻量摘要。
    - `skills_snapshot_id`：单独取出 id，方便调用方比较而不用做 dict 取值。
    - `skill_diagnostics`：已截取前 20 条的诊断（与 v3 wire 上限一致）。
    - `diagnostics`：脱敏后的诊断设置；配置未加载时按环境变量降级。
    - `config_summary`：脱敏配置摘要；配置损坏时为 None。
    - `startup_error`：配置加载失败时的原始错误文本；正常时为 None。
      注意它是「字符串」，v3 自己的 wire 形状 `{code, message}` 由 v3 薄壳拼。
    - `default_approval_mode`：配置里的默认审批模式，ACP 用它初始化会话模式。
    """

    agent_commands: tuple[dict[str, object], ...]
    skills_snapshot: dict[str, object]
    skills_snapshot_id: str
    skill_diagnostics: tuple[object, ...]
    diagnostics: dict[str, object]
    config_summary: dict[str, object] | None
    startup_error: str | None
    default_approval_mode: str


@dataclass(frozen=True, slots=True)
class StartRunRequest:
    """一次 Run 受理请求的传输无关快照（`StartRun` 去掉连接派生字段）。

    `input` 已经是类型化输入（`UserRunInput` / `GoalProposalRunInput` /
    `GoalContinuationRunInput`）；`connection_id`、`protocol_minor`、
    `command_binding*` 由服务方法从传入的 `conn` 取，调用方填不了也改不了。
    """

    thread_id: str
    run_id: str
    mode: InteractionMode
    input: RunInput
    requested_primary_profile: str | None = None
    requested_approval_mode: ApprovalModeName | None = None
    # 这次 prompt 开始时已经停在 plan：批准计划后 Host 切回这个模式。
    pre_plan_mode: ApprovalModeName | None = None


@dataclass(frozen=True, slots=True)
class RunAccepted:
    """Run 已受理的结果。

    故意不返回 `RunExecution`：它的 `events` 迭代器只能被消费一次，
    事件扇出任务已经在消费，调用方拿不出第二个只能返回个假象。
    """

    thread_id: str
    run_id: str
    accepted: bool


class HostServicePort(Protocol):
    """`AcpServer` 允许调用的 Host 服务面；v3 处理器也走这一组方法。"""

    async def ensure_ready(self) -> HostSnapshot:
        """完成资源初始化（技能目录、配置、MCP 后台连接）；可重复调用，只做一次。"""
        raise NotImplementedError

    def open_connection(
        self,
        sender: Callable[[dict[str, object]], Awaitable[None]],
        *,
        enabled_capabilities: Iterable[str],
        interaction_handles: Iterable[str],
        capability_ceiling: Iterable[str] = ...,
        role: str = "owner",
    ) -> ProtocolConnection:
        """登记一条已协商好的外部连接；未知 handle 与缺 sender 抛 ValueError。"""
        raise NotImplementedError

    async def bind_commands(
        self,
        connection: ProtocolConnection,
        snapshot_id: str,
        bindings: Sequence[tuple[str, str]],
    ) -> None:
        """每连接一次，把 agent_commands 的 id→名称映射绑定到连接。"""
        raise NotImplementedError

    async def start_run(
        self,
        connection: ProtocolConnection,
        request: StartRunRequest,
        *,
        on_accepted: Callable[[RunAccepted], Awaitable[None]] | None = None,
    ) -> RunAccepted:
        """受理一次 Run（含 undo 收敛、git 检查点、标题生成）；事件经 sender 推出。"""
        raise NotImplementedError

    def watch_thread(self, connection: ProtocolConnection, thread_id: str) -> None:
        """只登记 thread.summary 订阅（session/new 用，线程可以尚未落库）。"""
        raise NotImplementedError

    async def open_thread(
        self, thread_id: str, *, assume_idle: bool = False
    ) -> dict[str, object]:
        """只读历史与关联状态；不登记 watch，不存在时抛 -32004。"""
        raise NotImplementedError

    async def list_threads(self, limit: int) -> list[ThreadSummary]:
        """返回当前工作区最近活跃的 thread 摘要。"""
        raise NotImplementedError

    async def list_threads_page(
        self, limit: int, after: tuple[int, str] | None
    ) -> tuple[list[ThreadSummary], bool]:
        """keyset 分页版 `list_threads`：返回 (本页摘要, has_more)；after=None 取第一页。"""
        raise NotImplementedError

    async def cancel_run(
        self, connection: ProtocolConnection, thread_id: str, run_id: str
    ) -> CancelResult:
        """取消指定 Run；非 owner 抛 RUN_NOT_OWNER。"""
        raise NotImplementedError

    async def set_approval_mode(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        run_id: str,
        approval_mode: ApprovalModeName,
    ) -> ApprovalModeResult:
        """提交活动 Run 的审批模式，返回值只反映服务端实际状态。"""
        raise NotImplementedError

    async def open_and_watch_thread(
        self, connection: ProtocolConnection, thread_id: str
    ) -> dict[str, object]:
        """在同一个 idle 窗口读取历史并登记 watch。"""
        raise NotImplementedError

    def unwatch_thread(self, connection: ProtocolConnection, thread_id: str) -> bool:
        """移除订阅；返回是否真的删掉了一条。"""
        raise NotImplementedError

    def resolve_interaction(
        self,
        connection: ProtocolConnection,
        request_id: str,
        result: object,
    ) -> Literal["resolved", "expired", "invalid"]:
        """用客户端的 result 恢复交互 Future；返回 resolved / expired / invalid。"""
        raise NotImplementedError

    def fail_interaction(
        self,
        connection: ProtocolConnection,
        request_id: str,
        error: RpcError,
    ) -> bool:
        """用错误终止挂起的交互 Future；返回 False 表示请求已不存在。"""
        raise NotImplementedError

    async def close_connection(self, connection: ProtocolConnection) -> None:
        """关闭连接：取消它拥有的 Run，并让它挂起的交互 fail-closed。"""
        raise NotImplementedError

    @property
    def workspace(self) -> Path:
        """Host 启动时固定的工作区绝对路径；AcpServer 用它校验 session/new 的 cwd。"""
        raise NotImplementedError

    def resolve_display_path(self, raw: object, *, tool_name: str) -> str | None:
        """把工具参数里的路径解析成可展示的绝对宿主路径；不能解析时返回 None。

        与 `WorkspacePathPolicy.validate_direct_path` 同语义：主工作区内的相对/
        虚拟/绝对路径照常，外加全部已授权根（session/project/user）；不含本
        Run 一次性授权（无 run 上下文）。越界、未信任、非字符串一律返回 None，
        绝不抛异常——位置只是卡片副标题，不能打断事件流。
        """
        raise NotImplementedError

    @staticmethod
    def run_error_to_rpc_error(error: RunError) -> RpcError:
        """把 Run 的稳定错误码翻成 JSON-RPC 错误；AcpServer 翻译 RunError 时复用。"""
        raise NotImplementedError


__all__ = [
    "ApprovalModeName",
    "HostServicePort",
    "HostSnapshot",
    "RunAccepted",
    "StartRunRequest",
]
