"""``execute`` 输出头尾折叠、私有目录落盘与中间件嵌套顺序测试。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from deepagents.backends import LocalShellBackend
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import Runnable
from langchain_core.tools import StructuredTool
from pydantic import Field

from harness_agent.extensions.plugin_skills import SkillRegistry
from harness_agent.policy.workspace_boundary import WorkspaceBoundaryMiddleware
from harness_agent.runtime.agent import create_harness_agent
from harness_agent.threads.virtual_files import (
    VIRTUAL_ROOT,
    HarnessVirtualBackend,
    mount_harness_virtual_files,
)
from harness_agent.tools.execute_output import (
    _EXECUTE_DESCRIPTION_HINT,
    DEFAULT_MAX_INLINE_CHARS,
    ExecuteOutputMiddleware,
)
from harness_agent.tools.snapshot_file_contract import create_snapshot_file_tool_contract


class _ToolCallingModel(GenericFakeChatModel):
    """返回预置工具调用序列而不访问真实模型服务。"""

    def bind_tools(self, *_args: Any, **_kwargs: Any) -> Runnable:
        return self


@pytest.mark.asyncio
async def test_execute_output_middleware_keeps_short_output_intact(tmp_path: Path) -> None:
    """未超过阈值的短输出原样返回，不触发落盘。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home"
    backend = mount_harness_virtual_files(
        LocalShellBackend(root_dir=workspace, virtual_mode=True),
        registry=None,
        thread_id="thread-short",
        home=home,
    )
    middleware = ExecuteOutputMiddleware(backend=backend)
    request = SimpleNamespace(
        tool_call={"name": "execute", "id": "call-short-1", "args": {"command": "echo hi"}}
    )

    async def handler(_req: Any) -> ToolMessage:
        return ToolMessage(content="short ok\n", name="execute", tool_call_id="call-short-1")

    result = await middleware.awrap_tool_call(request, handler)  # type: ignore[arg-type]
    assert result.content == "short ok\n"
    assert not (home / ".harness" / "tool-outputs").exists()
    assert list(workspace.iterdir()) == []


@pytest.mark.asyncio
async def test_execute_output_middleware_folds_and_offloads_to_home(tmp_path: Path) -> None:
    """超长 execute 输出保留头尾摘要与只读路径，完整日志落盘到 home 而非工作区。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home"
    backend = mount_harness_virtual_files(
        LocalShellBackend(root_dir=workspace, virtual_mode=True),
        registry=None,
        thread_id="thread-long",
        home=home,
    )
    middleware = ExecuteOutputMiddleware(backend=backend)
    request = SimpleNamespace(
        tool_call={"name": "execute", "id": "call_pytest_1", "args": {"command": "pytest"}}
    )
    middle = [f"test_case_{i} PASSED " + ("x" * 100) for i in range(1, 300)]
    full_output = "\n".join(
        [
            "=== test session starts ===",
            "FIRST_FAILURE: AssertionError in test_alpha",
            *middle,
            "=== 1 failed, 299 passed in 12.34s ===",
            "Exit code: 1",
        ]
    )
    assert len(full_output) > DEFAULT_MAX_INLINE_CHARS

    async def handler(_req: Any) -> ToolMessage:
        return ToolMessage(
            content=full_output,
            name="execute",
            tool_call_id="call_pytest_1",
            status="success",
        )

    result = await middleware.awrap_tool_call(request, handler)  # type: ignore[arg-type]
    text = str(result.content)
    assert "FIRST_FAILURE: AssertionError in test_alpha" in text
    assert "=== 1 failed, 299 passed in 12.34s ===" in text
    assert "Exit code: 1" in text
    assert "已省略中间" in text
    assert "/.harness/tool-outputs/call_pytest_1.txt" in text
    assert "不要重复执行同一长耗时命令" in text
    assert len(text) < DEFAULT_MAX_INLINE_CHARS

    # 工作区零文件写入，完整内容安全落盘在 home
    assert list(workspace.iterdir()) == []
    disk = home / ".harness" / "tool-outputs" / "thread-long" / "tool-outputs" / "call_pytest_1.txt"
    assert disk.read_text(encoding="utf-8") == full_output

    # 通过 WorkspaceBoundaryMiddleware + SnapshotFileToolContract 可分页只读读取，写入仍被拒绝
    from harness_agent.threads.snapshots import ThreadSnapshotStore
    from harness_agent.threads.text_backend import LocalTextMutationBackend

    contract = create_snapshot_file_tool_contract(
        backend,
        snapshot_store=ThreadSnapshotStore(),
        text_backend=LocalTextMutationBackend(workspace),
    )
    boundary = WorkspaceBoundaryMiddleware(workspace)
    read_req = SimpleNamespace(
        tool_call={
            "name": "read_file",
            "id": "read-out-1",
            "args": {
                "file_path": "/.harness/tool-outputs/call_pytest_1.txt",
                "offset": 1,
                "limit": 2,
            },
        }
    )
    assert boundary.allows_approval(read_req)
    read_msg = boundary.wrap_tool_call(read_req, contract.dispatch)
    assert "FIRST_FAILURE: AssertionError in test_alpha" in str(read_msg.content)

    write_req = SimpleNamespace(
        tool_call={
            "name": "write_file",
            "id": "write-out-1",
            "args": {"file_path": "/.harness/tool-outputs/call_pytest_1.txt", "content": "x"},
        }
    )
    assert not boundary.allows_approval(write_req)
    denied = boundary.wrap_tool_call(write_req, contract.dispatch)
    assert denied.status == "error"


@pytest.mark.asyncio
async def test_execute_output_middleware_skips_disk_write_without_virtual_route(
    tmp_path: Path,
) -> None:
    """未挂载 /.harness 虚拟路由时只做头尾折叠，绝不向工作区写入文件。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    backend = LocalShellBackend(root_dir=workspace, virtual_mode=True)
    middleware = ExecuteOutputMiddleware(backend=backend)
    request = SimpleNamespace(
        tool_call={"name": "execute", "id": "call-novirt", "args": {"command": "pytest"}}
    )
    big = "\n".join(f"line {i} " + ("z" * 120) for i in range(200))

    async def handler(_req: Any) -> ToolMessage:
        return ToolMessage(content=big, name="execute", tool_call_id="call-novirt")

    result = await middleware.awrap_tool_call(request, handler)  # type: ignore[arg-type]
    assert "已省略中间" in str(result.content)
    assert "/.harness/tool-outputs/" not in str(result.content)
    assert list(workspace.iterdir()) == []


@pytest.mark.asyncio
async def test_create_harness_agent_folds_120kb_execute_before_deepagents_eviction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """端到端确认 ExecuteOutputMiddleware 在 FilesystemMiddleware 之前拦截超大输出。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    # 构造 >100 KB 输出（同时超过 deepagents 80 KB eviction 阈值与 100 KB 旧上限）
    lines = [
        "START_HEADER_LINE",
        "FIRST_ERROR_HERE: boom",
        *[f"row_{i}: " + ("a" * 200) for i in range(600)],
        "FINAL_SUMMARY: 1 failed, 599 passed",
    ]
    script_payload = "\n".join(lines)
    assert len(script_payload) > 100_000
    (workspace / "emit.py").write_text(
        f"print({script_payload!r})\n",
        encoding="utf-8",
    )

    model = _ToolCallingModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "execute",
                            "args": {"command": "python3 emit.py"},
                            "id": "call_big_exec",
                        }
                    ],
                ),
                AIMessage(content="ok"),
            ]
        )
    )
    skill_registry = SkillRegistry(workspace, home=home)
    agent = create_harness_agent(
        model,
        cwd=str(workspace),
        approval_mode="yolo",
        skill_registry=skill_registry,
        enable_memory=False,
        enable_skills=True,
        enable_ask_user=False,
    )
    state = await agent.ainvoke(
        {"messages": [HumanMessage(content="run emit.py")]},
        config={"configurable": {"thread_id": "test-e2e-execute"}},
    )
    tool_msgs = [m for m in state["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    content = str(tool_msgs[0].content)
    # 必须走我们的头尾折叠与 /.harness/tool-outputs 落盘，而不是 deepagents 5+5 行 large_tool_results
    assert "FIRST_ERROR_HERE: boom" in content
    assert "FINAL_SUMMARY: 1 failed, 599 passed" in content
    assert "/.harness/tool-outputs/call_big_exec.txt" in content
    assert "/large_tool_results/" not in content
    assert not (workspace / "large_tool_results").exists()
    assert sorted(p.name for p in workspace.iterdir()) == ["emit.py"]


@pytest.mark.asyncio
async def test_execute_output_middleware_appends_execute_hint_idempotently(
    tmp_path: Path,
) -> None:
    """ExecuteOutputMiddleware 同步与异步均只为 execute 幂等追加一次提示且不改原工具。"""
    middleware = ExecuteOutputMiddleware()
    original_execute = StructuredTool.from_function(
        func=lambda command: command,
        name="execute",
        description="Execute a shell command.",
    )
    original_read = StructuredTool.from_function(
        func=lambda file_path: file_path,
        name="read_file",
        description="Read a file.",
    )

    class _FakeModelRequest:
        def __init__(self, tools: list[Any]) -> None:
            self.tools = tools

        def override(self, **kwargs: Any) -> "_FakeModelRequest":
            return _FakeModelRequest(list(kwargs["tools"]))

    seen_tools: list[list[Any]] = []

    def sync_handler(req: Any) -> str:
        seen_tools.append(req.tools)
        return "ok"

    async def async_handler(req: Any) -> str:
        seen_tools.append(req.tools)
        return "ok"

    req = _FakeModelRequest([original_execute, original_read])
    assert middleware.wrap_model_call(req, sync_handler) == "ok"  # type: ignore[arg-type]
    assert await middleware.awrap_model_call(req, async_handler) == "ok"  # type: ignore[arg-type]
    # 重复经过中间件不能叠写两次提示
    nested_req = _FakeModelRequest(seen_tools[0])
    assert await middleware.awrap_model_call(nested_req, async_handler) == "ok"  # type: ignore[arg-type]

    assert original_execute.description == "Execute a shell command."
    for batch in seen_tools:
        exec_tool = next(t for t in batch if t.name == "execute")
        read_tool = next(t for t in batch if t.name == "read_file")
        assert exec_tool.description.count(_EXECUTE_DESCRIPTION_HINT.strip()) == 1
        assert read_tool.description == "Read a file."


@pytest.mark.asyncio
async def test_create_harness_agent_exposes_execute_hint_in_model_tools(
    tmp_path: Path,
) -> None:
    """create_harness_agent 发给模型的 execute 工具声明包含防截断与防 cd <workspace> 提示。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    class _BindRecordingModel(_ToolCallingModel):
        bound_batches: list[list[Any]] = Field(default_factory=list)

        def bind_tools(self, tools: Any, **_kwargs: Any) -> Runnable:
            self.bound_batches.append(list(tools))
            return self

    model = _BindRecordingModel(messages=iter([AIMessage(content="done")]))
    agent = create_harness_agent(
        model,
        cwd=str(workspace),
        approval_mode="yolo",
        enable_memory=False,
        enable_skills=False,
        enable_ask_user=False,
    )
    state = await agent.ainvoke(
        {"messages": [HumanMessage(content="check")]},
        config={"configurable": {"thread_id": "test-execute-hint"}},
    )
    assert state["messages"][-1].content == "done"
    assert model.bound_batches
    exec_tool = next(t for t in model.bound_batches[-1] if getattr(t, "name", None) == "execute")
    assert _EXECUTE_DESCRIPTION_HINT.strip() in exec_tool.description
    assert exec_tool.description.count(_EXECUTE_DESCRIPTION_HINT.strip()) == 1
