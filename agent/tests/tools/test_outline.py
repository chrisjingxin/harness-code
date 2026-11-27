"""多语言批量代码大纲工具 ``outline_files`` 的提取、预算截断与端到端测试。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import Runnable

from harness_agent.runtime.agent import create_harness_agent
from harness_agent.tools.outline import extract_file_outline, format_batch_outlines


class _ToolCallingModel(GenericFakeChatModel):
    """返回预置工具调用序列而不访问真实模型服务。"""

    def bind_tools(self, *_args: Any, **_kwargs: Any) -> Runnable:
        return self


def test_extract_python_ast_and_syntax_fallback() -> None:
    """Python 支持精确 AST 行号区间，语法错误时降级到正则扫描。"""
    py_src = (
        "class Engine:\n"
        "    def start(self) -> None:\n"
        "        pass\n\n"
        "    async def stop(self) -> None:\n"
        "        pass\n\n"
        "async def run_once() -> int:\n"
        "    return 1\n"
    )
    out = extract_file_outline("/pkg/engine.py", py_src)
    assert "## Outline: /pkg/engine.py (9 lines)" in out
    assert "L1-L6 [class] Engine" in out
    assert "  L2-L3 [method] start" in out
    assert "  L5-L6 [async method] stop" in out
    assert "L8-L9 [async function] run_once" in out

    broken = (
        "def good_helper(x):\n"
        "    return x + 1\n\n"
        "def broken(:\n"
        "    pass\n"
    )
    fallback = extract_file_outline("/pkg/broken.py", broken)
    assert "L1-L2 [function] good_helper" in fallback


def test_extract_ts_go_rust_java_markdown_and_configs() -> None:
    """TS/JS、Go、Rust、Java、Markdown 与 JSON/YAML/TOML 均能产出紧凑结构大纲。"""
    ts_src = (
        "// comment with {\n"
        "export interface Config {\n"
        "  port: number;\n"
        "}\n"
        "export class Server {\n"
        '  private tag = "{ignored}";\n'
        "  async handle(req: unknown) {\n"
        "    return req;\n"
        "  }\n"
        "}\n"
        "export const boot = async () => {\n"
        "  return true;\n"
        "};\n"
    )
    ts_out = extract_file_outline("/src/server.ts", ts_src)
    assert "L2-L4 [interface] Config" in ts_out
    assert "L5-L10 [class] Server" in ts_out
    assert "  L7-L9 [method] handle" in ts_out
    assert "L11-L13 [function] boot" in ts_out

    go_src = (
        "package main\n"
        "type Hub struct {\n"
        "  id int\n"
        "}\n"
        "func (h *Hub) Run() {\n"
        "  return\n"
        "}\n"
    )
    go_out = extract_file_outline("/cmd/hub.go", go_src)
    assert "L2-L4 [struct] Hub" in go_out
    assert "L5-L7 [func] Run" in go_out

    rs_src = (
        "pub struct Store {\n"
        "  n: usize,\n"
        "}\n"
        "impl Store {\n"
        "  pub fn size(&self) -> usize {\n"
        "    self.n\n"
        "  }\n"
        "}\n"
    )
    rs_out = extract_file_outline("/src/lib.rs", rs_src)
    assert "L1-L3 [struct] Store" in rs_out
    assert "L4-L8 [impl] Store" in rs_out
    assert "  L5-L7 [fn] size" in rs_out

    java_src = (
        "public class App {\n"
        "  record Pair(int a, int b) {\n"
        "  }\n"
        "}\n"
    )
    assert "L1-L4 [class] App" in extract_file_outline("/src/App.java", java_src)

    md_src = (
        "# Title\n"
        "```python\n"
        "# not a heading\n"
        "```\n"
        "## Section A\n"
        "text\n"
        "## Section B\n"
    )
    md_out = extract_file_outline("/README.md", md_src)
    assert "L1-L7 [h1] Title" in md_out
    assert "  L5-L6 [h2] Section A" in md_out
    assert "not a heading" not in md_out

    json_src = '{\n  "name": "app",\n  "scripts": {\n    "test": "pytest"\n  }\n}\n'
    json_out = extract_file_outline("/package.json", json_src)
    assert 'L2-L2 [key] name' in json_out
    assert 'L3-L5 [key] scripts' in json_out

    yaml_src = "server:\n  port: 8080\ndatabase:\n  url: sqlite\n"
    yaml_out = extract_file_outline("/config.yaml", yaml_src)
    assert "L1-L2 [key] server" in yaml_out
    assert "L3-L4 [key] database" in yaml_out

    toml_src = 'name = "demo"\n[tool.pytest]\naddopts = "-q"\n'
    toml_out = extract_file_outline("/pyproject.toml", toml_src)
    assert "L1-L1 [key] name" in toml_out
    assert "L2-L3 [section] [tool.pytest]" in toml_out
    assert "  L3-L3 [key] addopts" in toml_out

    plain_out = extract_file_outline("/notes.txt", "hello\nworld\n")
    assert "无结构符号" in plain_out


def test_format_batch_outlines_enforces_budget_and_reports_omitted() -> None:
    """超过 max_chars 时在文件边界截断并明确列出被省略的文件路径。"""
    entries = [
        ("/a.py", "## Outline: /a.py (10 lines)\nL1-L10 [function] alpha"),
        ("/b.py", "## Outline: /b.py (10 lines)\nL1-L10 [function] beta"),
        ("/c.py", "## Outline: /c.py (10 lines)\nL1-L10 [function] gamma"),
    ]
    text, omitted = format_batch_outlines(entries, max_chars=70)
    assert "alpha" in text
    assert omitted == ["/b.py", "/c.py"]
    assert "省略其余 2 个文件：/b.py, /c.py" in text


@pytest.mark.asyncio
async def test_create_harness_agent_outline_files_then_read_and_edit(
    tmp_path: Path,
) -> None:
    """端到端验证 outline_files 去重、单文件失败隔离、不发 snapshot，随后配合 read_file 完成 edit_file。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "app.py"
    target.write_text(
        "def greet(name: str) -> str:\n"
        "    return f'hello {name}'\n",
        encoding="utf-8",
    )

    model = _ToolCallingModel(
        messages=iter(
            [
                # 1. 先批量 outline（包含重复路径与缺失文件）
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "outline_files",
                            "args": {"paths": ["/app.py", "/missing.py", "/app.py"]},
                            "id": "call_outline",
                        }
                    ],
                ),
                # 2. 按大纲行号调用 read_file 拿 snapshot_id
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": "/app.py", "offset": 0, "limit": 2},
                            "id": "call_read",
                        }
                    ],
                ),
                # 3. 验证未传真实 snapshot_id 时，仅仅 outline 过不能绕过先读后写
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "edit_file",
                            "args": {
                                "file_path": "/app.py",
                                "snapshot_id": "invalid_snap_from_outline",
                                "edits": [
                                    {
                                        "old_string": "return f'hello {name}'",
                                        "new_string": "return f'hi {name}'",
                                    }
                                ],
                            },
                            "id": "call_bad_edit",
                        }
                    ],
                ),
                AIMessage(content="READ_OK"),
            ]
        )
    )
    agent = create_harness_agent(
        model,
        cwd=str(workspace),
        approval_mode="yolo",
        enable_memory=False,
        enable_skills=False,
        enable_ask_user=False,
    )
    state = await agent.ainvoke(
        {"messages": [HumanMessage(content="inspect app.py")]},
        config={"configurable": {"thread_id": "test-outline-e2e"}},
    )
    assert state["messages"][-1].content == "READ_OK"
    tool_msgs = [m for m in state["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 3

    outline_content = str(tool_msgs[0].content)
    assert tool_msgs[0].status == "success"
    assert outline_content.count("## Outline: /app.py") == 1
    assert "L1-L2 [function] greet" in outline_content
    assert "## Outline: /missing.py" in outline_content
    assert "[error: FILE_NOT_FOUND]" in outline_content
    assert "snapshot_id" not in outline_content

    read_payload = json.loads(str(tool_msgs[1].content))
    assert read_payload["ok"] is True
    snap_id = read_payload["snapshot_id"]
    assert isinstance(snap_id, str) and snap_id

    bad_edit_payload = json.loads(str(tool_msgs[2].content))
    assert bad_edit_payload["ok"] is False

    # 同一 agent / Thread 内使用 read_file 签发的 snapshot_id 完成 edit_file
    model.messages = iter(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "edit_file",
                        "args": {
                            "file_path": "/app.py",
                            "snapshot_id": snap_id,
                            "edits": [
                                {
                                    "old_string": "return f'hello {name}'",
                                    "new_string": "return f'hi {name}'",
                                }
                            ],
                        },
                        "id": "call_edit",
                    }
                ],
            ),
            AIMessage(content="EDIT_OK"),
        ]
    )
    state2 = await agent.ainvoke(
        {"messages": [HumanMessage(content="update greet")]},
        config={"configurable": {"thread_id": "test-outline-e2e"}},
    )
    assert state2["messages"][-1].content == "EDIT_OK"
    assert "return f'hi {name}'" in target.read_text(encoding="utf-8")
