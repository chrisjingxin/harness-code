"""多级审批流水线 evaluate_permission 的单元测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness_agent.policy.approval_policy import (
    classify_plan_shell_command,
    evaluate_permission,
)
from harness_agent.policy.permission_rules import PermissionRule, extract_tool_resource
from harness_agent.tracing import TraceRecorder, use_trace


def _trace_events(log_dir: Path) -> list[dict[str, object]]:
    """逐行读取当前测试 Trace 的统一 JSONL。"""
    path = next(log_dir.glob("*.jsonl"))
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _span_ends(events: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    """筛选指定标准埋点的结束事件。"""
    return [
        event
        for event in events
        if event["event"] == "span.end" and event["name"] == name
    ]


class TestDenyRuleOverridesMode:
    """deny 规则在任何模式下都不可被覆盖。"""

    def test_deny_rule_overrides_yolo_mode(self) -> None:
        rules = [PermissionRule(tool="execute", resource="rm *", effect="deny")]
        result = evaluate_permission(
            "execute", {"command": "rm -rf /"}, "yolo", rules=rules
        )
        assert result == "deny"


class TestReadOnlyTools:
    """只读工具在所有模式下免审批。"""

    def test_read_only_tools_always_allowed(self) -> None:
        for tool in ("ls", "read_file", "glob", "grep", "ask_user", "write_todos"):
            result = evaluate_permission(tool, {}, "default")
            assert result == "allow", f"{tool} should be allowed in default mode"


class TestSensitivePathSafety:
    """敏感路径写操作在非 yolo 模式下强制 ask，yolo 模式免疫。"""

    def test_sensitive_path_forces_ask_in_non_yolo_modes(self) -> None:
        for mode in ("default", "auto-edit", "auto"):
            result = evaluate_permission(
                "write_file", {"file_path": "/home/user/.git/config"}, mode
            )
            assert result == "ask", f"sensitive path should force ask in {mode} mode"

    def test_sensitive_path_immune_in_yolo(self) -> None:
        result = evaluate_permission(
            "write_file", {"file_path": "/home/user/.git/config"}, "yolo"
        )
        assert result == "allow"


class TestAllowRuleSkipsApproval:
    """allow 规则跳过审批直接执行。"""

    def test_allow_rule_skips_approval(self) -> None:
        rules = [PermissionRule(tool="execute", resource="npm test", effect="allow")]
        result = evaluate_permission(
            "execute", {"command": "npm test"}, "default", rules=rules
        )
        assert result == "allow"


class TestModePermissionTable:
    """审批模式查表行为验证。"""

    def test_mode_permission_table_default(self) -> None:
        # EDIT 工具在 default 模式下为 ask
        result = evaluate_permission("write_file", {"file_path": "/tmp/a.txt"}, "default")
        assert result == "ask"

    def test_mode_permission_table_auto_edit(self) -> None:
        # EDIT 工具在 auto-edit 模式下为 allow
        result = evaluate_permission(
            "edit_file", {"file_path": "/tmp/a.txt"}, "auto-edit"
        )
        assert result == "allow"
        # DELETE 工具在 auto-edit 模式下对普通文件为 allow
        result = evaluate_permission(
            "delete_file", {"file_path": "/tmp/a.txt"}, "auto-edit"
        )
        assert result == "allow"
        # DELETE 工具在 auto-edit 模式下对敏感路径仍为 ask
        result = evaluate_permission(
            "delete_file", {"file_path": "/home/user/.git/config"}, "auto-edit"
        )
        assert result == "ask"
        # EXECUTE 工具若是安全只读命令在 auto-edit 模式下自动放行（L3.1）
        result = evaluate_permission("execute", {"command": "ls"}, "auto-edit")
        assert result == "allow"
        result = evaluate_permission("execute", {"command": "git status"}, "auto-edit")
        assert result == "allow"
        # 非安全只读命令在 auto-edit 模式下仍为 ask
        result = evaluate_permission("execute", {"command": "npm install"}, "auto-edit")
        assert result == "ask"

    def test_safe_shell_commands_allowed_in_auto_mode(self) -> None:
        # EXECUTE 工具若是安全只读命令在 auto 模式下通过 L3.1 自动放行
        result = evaluate_permission("execute", {"command": "git status"}, "auto")
        assert result == "allow"
        result = evaluate_permission("execute", {"command": "ls"}, "auto")
        assert result == "allow"

    def test_mode_permission_table_yolo(self) -> None:
        # EXECUTE 工具在 yolo 模式下为 allow
        result = evaluate_permission("execute", {"command": "ls"}, "yolo")
        assert result == "allow"


class TestUnknownToolFailClosed:
    """未知工具 fail-closed 归为 EXECUTE 类别。"""

    def test_unknown_tool_fail_closed(self) -> None:
        # 未知工具在 default 模式下为 ask（EXECUTE 的 default 行为）
        result = evaluate_permission("some_unknown_tool", {}, "default")
        assert result == "ask"


class TestExtractResource:
    """资源提取辅助函数验证。"""

    def test_extract_resource_execute(self) -> None:
        assert extract_tool_resource("execute", {"command": "npm run build"}) == "npm run build"

    def test_extract_resource_file(self) -> None:
        assert extract_tool_resource("write_file", {"file_path": "/src/main.py"}) == "/src/main.py"
        assert extract_tool_resource("edit_file", {"file_path": "a.txt"}) == "a.txt"
        assert extract_tool_resource("delete_file", {}) == "*"

    def test_extract_resource_normalizes_backslash(self) -> None:
        assert extract_tool_resource("write_file", {"file_path": "src\\main.py"}) == "src/main.py"

    def test_extract_resource_web_fetch(self) -> None:
        assert (
            extract_tool_resource("web_fetch", {"url": "https://api.github.com/repos"})
            == "https://api.github.com/repos"
        )


class TestSafeCommandSegments:
    """L3.1 安全命令白名单对链式命令逐段判定。"""

    def test_all_safe_segments_auto_allowed(self) -> None:
        result = evaluate_permission(
            "execute", {"command": "git status && git diff"}, "default"
        )
        assert result == "allow"

    def test_dangerous_segment_blocks_fast_path(self) -> None:
        # 首段安全但次段危险时，不得借白名单整体放行
        result = evaluate_permission(
            "execute", {"command": "git status && rm -rf /"}, "default"
        )
        assert result == "ask"


def test_policy_trace_records_each_actual_decision_without_tool_payload(tmp_path: Path) -> None:
    """allow/ask/deny 是三个独立调用，只向统一 Trace 投影实际 decision。"""
    recorder = TraceRecorder(session_id="thread-policy", run_id="run-policy", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        assert evaluate_permission("read_file", {"file_path": "/tmp/a"}, "default") == "allow"
        assert evaluate_permission("write_file", {"file_path": "/tmp/a"}, "default") == "ask"
        assert evaluate_permission(
            "execute",
            {"command": "rm -rf /"},
            "yolo",
            rules=[PermissionRule(tool="execute", resource="rm *", effect="deny")],
        ) == "deny"
    recorder.end_trace()

    events = _trace_events(tmp_path)
    ends = _span_ends(events, "policy.evaluate")
    assert [event["attributes"] for event in ends] == [
        {"decision": "allow"},
        {"decision": "ask"},
        {"decision": "deny"},
    ]
    assert all(event["kind"] == "POLICY" for event in ends)
    assert "/tmp/a" not in repr(events)
    assert "rm -rf /" not in repr(events)


def test_classifier_trace_records_allow_ask_and_deny_without_command(tmp_path: Path) -> None:
    """Plan Shell 分类结果进入 POLICY Span，命令正文不得落盘。"""
    recorder = TraceRecorder(session_id="thread-classifier", run_id="run-classifier", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        assert classify_plan_shell_command("git status") == "allow"
        assert classify_plan_shell_command("python inspect_project.py") == "ask"
        assert classify_plan_shell_command("rm project.txt") == "deny"
    recorder.end_trace()

    events = _trace_events(tmp_path)
    ends = _span_ends(events, "policy.classifier")
    assert [event["attributes"] for event in ends] == [
        {"decision": "allow"},
        {"decision": "ask"},
        {"decision": "deny"},
    ]
    assert all(event["kind"] == "POLICY" for event in ends)
    assert "inspect_project.py" not in repr(events)
    assert "project.txt" not in repr(events)


def test_policy_trace_suppresses_replays_but_keeps_independent_calls(tmp_path: Path) -> None:
    """相同决策请求重放只记录一次，不同工具或命令不能被固定键合并。"""
    recorder = TraceRecorder(session_id="thread-policy-idem", run_id="run-policy-idem", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        assert evaluate_permission("read_file", {"file_path": "/tmp/secret"}, "default") == "allow"
        assert evaluate_permission("read_file", {"file_path": "/tmp/secret"}, "default") == "allow"
        assert evaluate_permission("write_file", {"file_path": "/tmp/secret"}, "default") == "ask"
        assert classify_plan_shell_command("git status") == "allow"
        assert classify_plan_shell_command("git status") == "allow"
        assert classify_plan_shell_command("rm secret.txt") == "deny"
    recorder.end_trace()

    events = _trace_events(tmp_path)
    evaluate_ends = _span_ends(events, "policy.evaluate")
    classifier_ends = _span_ends(events, "policy.classifier")
    assert [event["attributes"]["decision"] for event in evaluate_ends] == ["allow", "ask"]
    assert [event["attributes"]["decision"] for event in classifier_ends] == ["allow", "deny"]
    assert all(event.get("idempotency_key") for event in (*evaluate_ends, *classifier_ends))
    assert len({event["idempotency_key"] for event in evaluate_ends}) == 2
    assert len({event["idempotency_key"] for event in classifier_ends}) == 2
    assert "/tmp/secret" not in repr(events)
    assert "secret.txt" not in repr(events)
