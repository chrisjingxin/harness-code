"""2.8：`_thread_message_payload` 的 tool 关联三键输出。"""

from __future__ import annotations

from dataclasses import replace

from harness_agent.host.agent_host import _thread_message_payload
from harness_agent.threads.thread_records import ThreadMessage


def _msg(**kw) -> ThreadMessage:
    base = dict(kind="tool", content="out", tool_name="execute", created_at_ms=1)
    base.update(kw)
    return ThreadMessage(**base)


def test_tool_keys_emitted_when_present() -> None:
    p = _thread_message_payload(
        _msg(tool_call_id="c1", tool_status="success", tool_arguments={"command": "ls"})
    )
    assert p["tool_call_id"] == "c1"
    assert p["arguments"] == {"command": "ls"}
    assert p["status"] == "completed"


def test_tool_error_maps_to_failed() -> None:
    p = _thread_message_payload(_msg(tool_call_id="c1", tool_status="error"))
    assert p["status"] == "failed"
    assert "arguments" not in p


def test_legacy_tool_message_omits_new_keys() -> None:
    p = _thread_message_payload(_msg())
    assert "tool_call_id" not in p and "arguments" not in p and "status" not in p
    assert p == {"kind": "tool", "content": "out", "tool_name": "execute", "created_at_ms": 1}
