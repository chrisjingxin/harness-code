"""Run 级「(工具名, 参数) 指纹 → provider tool_call_id」的短生命周期缓存。

【这是做什么的？】
LangChain 的 HITL 预检回调里能拿到 `tool_call["id"]`，但真正发出去的
`action_requests` 元素里没有它（`ActionRequest` 只保留 name/args/description）。
为了让 ACP 客户端把一条 `session/request_permission` 关联到正确的工具卡片，
预检阶段按「工具名 + 参数」记下 id，Host 生成审批 payload 时再按同一指纹取回。

【上下游】
- 上游写入方：`runtime/agent.py` 的审批预检装饰器（只在确定要弹窗时写）。
- 上游读取方：`host/run_coordinator.py` 生成 `interaction.approval` payload 时读。
- 生命周期：挂在 `RunContext` / `RunState` 上，随 Run 收敛 `clear()`。

【为什么不用 TTL】
审批已经没有任何超时（用户可能几分钟才点一下），同一批的第 2、3 个审批的
payload 是在处理完前一个之后才生成的。带过期的缓存会让后面的审批拿不到 id，
只能降级成模糊匹配。这里只限制条数（256 条，每条约 70 字节），不依赖时间。
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Mapping

from harness_agent.runtime.approval_presentation import approval_fingerprint

# ponytail: 固定条数上限而非 TTL，因为审批没有超时；单个 Run 里同时待决的不同调用远少于 256，
# 超出时只会退回「按名字+参数匹配」。需要更大范围再改成按批次回收。
MAX_TOOL_CALL_IDS = 256
"""单个 Run 最多记住多少个不同的调用指纹；超出淘汰最久未使用的。"""


class ToolCallIdStore:
    """按工具名与原始参数指纹关联 provider tool_call_id 的有界缓存。

    线程安全：预检回调是同步函数，LangGraph 可能在线程池里执行同步节点，
    所以写入与读取都可能来自非事件循环线程。
    """

    def __init__(self, *, max_entries: int = MAX_TOOL_CALL_IDS) -> None:
        """创建内存缓存；非法容量直接报错。"""
        if max_entries < 1:
            raise ValueError("TOOL_CALL_ID_LIMIT_INVALID")
        self._max_entries = max_entries
        self._entries: OrderedDict[str, str] = OrderedDict()
        self._lock = threading.RLock()

    def remember(
        self,
        tool_name: str,
        tool_args: Mapping[str, object],
        tool_call_id: str,
    ) -> bool:
        """登记一个指纹；空名字、空 id 或参数无法稳定编码时返回 False。

        同一指纹再次登记覆盖旧值：跨轮次的同参数调用（先 `ls`、后又 `ls`）
        覆盖到的就是最新一次，不会串到旧卡片上。
        """
        if not tool_name or not tool_call_id:
            return False
        key = approval_fingerprint(tool_name, tool_args)
        if key is None:
            return False
        with self._lock:
            self._entries.pop(key, None)
            self._entries[key] = tool_call_id
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
        return True

    def lookup(self, tool_name: str, tool_args: Mapping[str, object]) -> str | None:
        """按指纹取 provider id；缺失或参数不可编码时返回 None。"""
        key = approval_fingerprint(tool_name, tool_args)
        if key is None:
            return None
        with self._lock:
            value = self._entries.get(key)
            if value is None:
                return None
            self._entries.move_to_end(key)
            return value

    def clear(self) -> None:
        """Run 收敛时立即释放，避免异常 Run 长期保留调用指纹。"""
        with self._lock:
            self._entries.clear()


__all__ = ["MAX_TOOL_CALL_IDS", "ToolCallIdStore"]
