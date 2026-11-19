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

from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
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

    async def list_models(
        self, connection: ProtocolConnection, thread_id: str | None = None
    ) -> dict[str, object]:
        """返回模型目录。`connection` 必须带 `models.read` 或 `models.select`。

        回声模式抛 `-32002 MODELS_UNAVAILABLE_IN_ECHO_MODE`。目录缺失抛 `-32010`。
        `thread_id` 有值且连接有 `models.select` 时，附带该线程上次选择与绑定。
        """
        raise NotImplementedError

    def set_session_roots(self, thread_id: str, directories: Sequence[str]) -> None:
        """替换这个线程的会话级额外目录。空列表表示清空。

        先整表校验，任一不可信任就整单拒绝（`-32602 INVALID_ADDITIONAL_DIRECTORY`，
        `data.path` 是那一项），已有登记不动。通过后再撤销本线程上次自己登记的
        session 根，并注册新目录。不认领事先已存在的 project/user 根。
        """
        raise NotImplementedError

    async def set_session_mcp(
        self, thread_id: str, servers: Sequence[Mapping[str, object]]
    ) -> None:
        """替换这个线程的会话 MCP。空列表表示清空。

        非法项、sse/acp、以及与配置或插件同名的项被跳过并记诊断，不让建会话失败。
        连接失败同样不抛。不会替换全局当前快照。
        """
        raise NotImplementedError

    def authorize_existing_file(self, raw: str) -> str | None:
        """已授权根内的现有文件返回绝对路径；越界、目录或不存在返回 None。"""
        raise NotImplementedError

    async def compact_thread(
        self, connection: ProtocolConnection, thread_id: str
    ) -> dict[str, object]:
        """空闲时压缩这个线程的上下文。忙则 `-32000 CONTEXT_COMPACTION_RUN_ACTIVE`。"""
        raise NotImplementedError

    async def side_question(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        question: str,
        model_profile_id: str | None = None,
    ) -> dict[str, object]:
        """只读旁注问答，不写对话记录。缺 `threads.read` 时带 `capability` 的 `CAPABILITY_REQUIRED`。"""
        raise NotImplementedError

    async def list_turns(
        self, connection: ProtocolConnection, thread_id: str
    ) -> dict[str, object]:
        """列出用户回合。缺 `threads.read` 抛 `THREADS_CAPABILITY_REQUIRED`。"""
        raise NotImplementedError

    async def undo_thread(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        target_turn_id: str,
        mode: str,
    ) -> dict[str, object]:
        """把对话和/或工作区退到指定回合。非 Git 仓库上 `code` 抛 `WORKSPACE_NOT_GIT_REPOSITORY`。"""
        raise NotImplementedError

    async def redo_thread(
        self, connection: ProtocolConnection, thread_id: str
    ) -> dict[str, object]:
        """重做刚才的回退。没在回退状态抛 `THREAD_NOT_IN_REVERTED_STATE`。"""
        raise NotImplementedError

    async def set_thread_title(
        self, connection: ProtocolConnection, thread_id: str, title: str
    ) -> dict[str, object]:
        """改标题并广播 `thread.summary`。空标题 `-32602`，线程不存在 `-32004`。"""
        raise NotImplementedError

    async def goal_inspect(
        self, connection: ProtocolConnection, thread_id: str
    ) -> dict[str, object]:
        """读取当前目标、排队请求和最近一次判定。不额外要求 Goal 能力，避免打断 v3。"""
        raise NotImplementedError

    async def goal_request(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        request_id: str,
        kind: str,
        input_text: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        """记下创建、替换或修订目标的请求。线程正忙时处置是 `queued`。"""
        raise NotImplementedError

    async def goal_mutate(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        operation_id: str,
        action: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        """暂停、恢复、清除或取消排队。`action` 只能是这四个词。"""
        raise NotImplementedError

    async def compose_abandon(
        self,
        connection: ProtocolConnection,
        thread_id: str,
        reason: str | None = None,
    ) -> dict[str, object]:
        """放弃当前 Compose 进度，对话记录保留。不是 Compose 线程则拒绝。"""
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
