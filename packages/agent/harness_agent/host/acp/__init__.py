"""ACP（Agent Client Protocol）接入层的落地目录。

【这是做什么的？】
把 `harness_agent` 以标准 ACP Agent 的身份暴露给编辑器/Web 桥：复用 `AgentHost`
已有的服务面（`host/service_types.py` 的 `HostServicePort`），额外提供 stdio
接管、事件翻译与 ACP 方法实现。v3（`python -m harness_agent` 无参数）路径不经过这里。

【上下游】
- 上游：`harness_agent.__main__` 在 `argv == ["acp"]` 时才惰性导入本包，
  因此 v3 运行期不会加载 ACP SDK。
- 下游：`AgentHost`（服务面）、官方 `agent-client-protocol` SDK（线路编解码）。

【文件分工】
- `stdio.py`：文件描述符洁癖（把 fd 1 让给协议、把污染导向 stderr）、帧长校验、
  关闭顺序与信号处理。不认识任何业务。
- `server.py`：`AcpServer`，实现 SDK 的 Agent 接口，只依赖 `HostServicePort`。
- `translate.py`：每个 Run 一份的纯状态机，把 v3 事件翻成 ACP `session/update`。
- `tool_display.py`：工具 kind、标题与位置信息的展示规则。
- `ext.py`：扩展命名空间常量（`harnessCode`）。
"""

from __future__ import annotations

from harness_agent.host.acp.stdio import run_acp_stdio

__all__ = ["run_acp_stdio"]
