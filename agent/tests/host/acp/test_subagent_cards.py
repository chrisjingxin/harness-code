"""2.11：子代理工具卡可见（GAP-16）与审批挂子代理卡（GAP-34）。"""

from __future__ import annotations

from pathlib import Path

from harness_agent.host.acp.ext import CAP_SUBAGENT
from harness_agent.host.acp.tool_display import PathLocator
from harness_agent.host.acp.translate import RunTranslator, acp_child_tool_call_id, acp_tool_call_id
from tests.support.acp_harness import primary_path_resolver


def _translator(tmp: Path, *, subagent: bool = False) -> RunTranslator:
    return RunTranslator("r1", PathLocator(primary_path_resolver(tmp)), subagent=subagent)


def _event(etype: str, payload: dict, *, execution_id: str = "root", parent=None, agent_id=None) -> dict:
    return {"type": etype, "payload": payload, "execution_id": execution_id,
            "parent_execution_id": parent, "agent_id": agent_id}


def _tool_call(updates):
    return [u for u in updates if getattr(u, "session_update", None) == "tool_call" or getattr(u, "session_update", None) == "tool_call_update"]


def test_child_tool_card_with_binding(tmp_path: Path) -> None:
    """绑定 delta + 子代理 tool.started → 卡 id 三层形、标题带代理名前缀。"""
    tr = _translator(tmp_path)
    # 父卡 + 绑定
    tr.feed(_event("tool.started", {"tool_call_id": "pc0", "name": "task"}))
    tr.feed(_event("tool.delta", {"tool_call_id": "pc0",
                                  "child_execution_id": "exec-c1", "child_agent_id": "builder"}))
    updates = tr.feed(_event("tool.started", {"tool_call_id": "cc0", "name": "execute"},
                             execution_id="exec-c1", parent="root", agent_id="builder")).updates
    cards = _tool_call(updates)
    assert len(cards) == 1
    assert cards[0].tool_call_id == acp_child_tool_call_id("r1", "exec-c1", "cc0")
    assert cards[0].title.startswith("builder: ")


def test_child_card_no_parent_meta_without_negotiation(tmp_path: Path) -> None:
    """未协商 subagent：子代理卡仍出（标准卡），但无 harnessCode parent。"""
    import json
    tr = _translator(tmp_path, subagent=False)
    tr.feed(_event("tool.delta", {"tool_call_id": "pc0",
                                  "child_execution_id": "exec-c1", "child_agent_id": "b"}))
    updates = tr.feed(_event("tool.started", {"tool_call_id": "cc0", "name": "execute"},
                             execution_id="exec-c1", parent="root", agent_id="b")).updates
    assert _tool_call(updates)
    assert "harnessCode" not in json.dumps([u.model_dump(mode="json", by_alias=True) for u in updates])


def test_child_content_delta_appends_to_parent_card(tmp_path: Path) -> None:
    tr = _translator(tmp_path)
    tr.feed(_event("tool.started", {"tool_call_id": "pc0", "name": "task"}))
    tr.feed(_event("tool.delta", {"tool_call_id": "pc0",
                                  "child_execution_id": "exec-c1", "child_agent_id": "b"}))
    u1 = tr.feed(_event("content.delta", {"text": "第一句"},
                        execution_id="exec-c1", parent="root")).updates
    u2 = tr.feed(_event("content.delta", {"text": "第二句"},
                        execution_id="exec-c1", parent="root")).updates
    parent_id = acp_tool_call_id("r1", "pc0")
    assert all(u.tool_call_id == parent_id for u in _tool_call(u1 + u2))
    text_out = _tool_call(u2)[0].content[0].content.text
    assert "第一句" in text_out and "第二句" in text_out


def test_child_approval_hangs_on_child_card(tmp_path: Path) -> None:
    """子代理审批按复合 id 挂到子代理卡（GAP-34）。"""
    tr = _translator(tmp_path)
    tr.feed(_event("tool.delta", {"tool_call_id": "pc0",
                                  "child_execution_id": "exec-c1", "child_agent_id": "b"}))
    target = tr.prepare_approval(
        request_id="req-c", name="execute", args={"command": "ls"},
        tool_call_id="cc0", is_child=True, agent_id="b", execution_id="exec-c1",
    )
    assert target.tool_call_id == acp_child_tool_call_id("r1", "exec-c1", "cc0")
    assert target.matched == "id"
    assert target.title.startswith("b: ")


def test_child_card_carries_parent_meta_when_negotiated(tmp_path: Path) -> None:
    """协商 subagent 后子代理卡带 _meta.harnessCode.parent（GAP-16）。"""
    tr = _translator(tmp_path, subagent=True)
    tr.feed(_event("tool.delta", {"tool_call_id": "pc0",
                                  "child_execution_id": "exec-c1", "child_agent_id": "b"}))
    updates = tr.feed(_event("tool.started", {"tool_call_id": "cc0", "name": "execute"},
                             execution_id="exec-c1", parent="root", agent_id="b")).updates
    card = _tool_call(updates)[0]
    meta = card.field_meta["harnessCode"]["parent"]
    assert meta["toolCallId"] == acp_tool_call_id("r1", "pc0")
    assert meta["executionId"] == "exec-c1"
    assert meta["agentId"] == "b"
