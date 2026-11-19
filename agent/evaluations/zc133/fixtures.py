"""ZC-133 使用的合成文件编辑 fixture。

fixture 只包含去业务化文本和期望操作。评测报告只写入 fixture ID、类别和聚合指标，
不会写入源码、old_string、new_text 或模型原始响应。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


FIXTURE_VERSION = "zc133-v1"
BATCH_FIXTURE_VERSION = "hc185-v1"
"""HC-185 同文件批量编辑的独立 fixture 版本；不改变 zc133-v1 的 24 个原场景。"""

UNSET: Any = object()
"""`custom_edits` 的“未提供”哨兵：None/[]/字符串都是需要原样回放的畸形取值。"""
OperationKind = Literal["replace", "insert", "delete", "write"]
InsertAction = Literal["before", "after"]
Scenario = Literal["success", "expected_error", "recovery"]


@dataclass(frozen=True, slots=True)
class FixtureOperation:
    """描述一个不包含模型参数的期望文件变更。"""

    kind: OperationKind
    start_line: int = 1
    end_line: int | None = None
    new_text: str = ""
    insert_action: InsertAction | None = None


@dataclass(frozen=True, slots=True)
class EvaluationFixture:
    """一个可重复执行的合成编辑场景。"""

    fixture_id: str
    category: str
    description: str
    source: str
    read_start: int
    read_end: int
    operations: tuple[FixtureOperation, ...]
    expected_content: str
    scenario: Scenario = "success"
    expected_error: str | None = None
    external_after_read: str | None = None
    external_before_commit: str | None = None
    call_thread_id: str = "thread-a"
    call_path: str = "/src/fixture.txt"
    expire_snapshot: bool = False
    wrong_valid_range: bool = False
    path: str = "/src/fixture.txt"
    thread_id: str = "thread-a"
    backend_id: str = "local-fixture"
    same_turn: bool = False
    """同一轮模型输出的 N 个调用共用一个 snapshot_id，中间不重读（复现线上自我作废）。"""
    custom_edits: Any = UNSET
    """仅供 `exact-string-edits` 候选：原样作为 `edits` 参数回放，用于构造畸形或乱序入参。"""
    edits_only: bool = False
    """只对 `exact-string-edits` 有意义的场景；基线 exact-string 不运行。"""
    expected_edit_index: int | None = None
    """expected_error 场景下，错误应指向的 `edits` 数组下标。"""


def split_source_lines(content: str) -> list[str]:
    """按原始换行切分文本，保留 BOM、CRLF 和末尾换行。"""

    return content.splitlines(keepends=True)


def line_block(content: str, start_line: int, end_line: int) -> str:
    """读取 1-based 闭区间的原始文本，用于构造 exact-string 回放。"""

    lines = split_source_lines(content)
    return "".join(lines[start_line - 1 : end_line])


def _line_ending(text: str, fallback: str = "\n") -> str:
    """读取文本中的首个换行风格。"""

    if "\r\n" in text:
        return "\r\n"
    if "\n" in text:
        return "\n"
    if "\r" in text:
        return "\r"
    return fallback


def _replacement_text(new_text: str, removed: str, source: str) -> str:
    """为行编辑补齐被替换区间的换行，但不改变文本编码标记。"""

    if not new_text or new_text.endswith(("\n", "\r")):
        return new_text
    if not removed.endswith(("\n", "\r")):
        return new_text
    ending = _line_ending(removed, _line_ending(source))
    return f"{new_text}{ending}"


def apply_expected_operations(
    source: str,
    operations: tuple[FixtureOperation, ...],
) -> str:
    """在 fixture 构建阶段生成期望内容；此函数不访问文件系统。"""

    lines = split_source_lines(source)
    for operation in sorted(operations, key=lambda item: item.start_line, reverse=True):
        if operation.kind == "write":
            continue
        if operation.kind == "insert":
            index = operation.start_line - 1 if operation.insert_action == "before" else operation.start_line
            ending = _line_ending(source)
            inserted = operation.new_text
            if inserted and not inserted.endswith(("\n", "\r")):
                inserted += ending
            lines[index:index] = [inserted] if inserted else []
            continue
        end_line = operation.end_line or operation.start_line
        removed = "".join(lines[operation.start_line - 1 : end_line])
        replacement = _replacement_text(operation.new_text, removed, source)
        lines[operation.start_line - 1 : end_line] = (
            split_source_lines(replacement) if replacement else []
        )
    return "".join(lines)


def _fixture(
    fixture_id: str,
    category: str,
    description: str,
    source: str,
    read_start: int,
    read_end: int,
    operations: tuple[FixtureOperation, ...],
    *,
    scenario: Scenario = "success",
    expected_error: str | None = None,
    external_after_read: str | None = None,
    external_before_commit: str | None = None,
    call_thread_id: str = "thread-a",
    call_path: str = "/src/fixture.txt",
    expire_snapshot: bool = False,
    wrong_valid_range: bool = False,
    same_turn: bool = False,
    custom_edits: Any = UNSET,
    edits_only: bool = False,
    expected_edit_index: int | None = None,
) -> EvaluationFixture:
    """创建 fixture 并集中计算成功场景的期望内容。"""

    expected = apply_expected_operations(source, operations)
    return EvaluationFixture(
        fixture_id=fixture_id,
        category=category,
        description=description,
        source=source,
        read_start=read_start,
        read_end=read_end,
        operations=operations,
        expected_content=expected,
        scenario=scenario,
        expected_error=expected_error,
        external_after_read=external_after_read,
        external_before_commit=external_before_commit,
        call_thread_id=call_thread_id,
        call_path=call_path,
        expire_snapshot=expire_snapshot,
        wrong_valid_range=wrong_valid_range,
        same_turn=same_turn,
        custom_edits=custom_edits,
        edits_only=edits_only,
        expected_edit_index=expected_edit_index,
    )


def fixture_catalog() -> tuple[EvaluationFixture, ...]:
    """返回 ZC-133 固定版本的 24 个合成 fixture。"""

    single = "def greet():\n    return \"hello\"\n"
    ranged = "class Counter:\n    value = 1\n    limit = 2\n    return_value = value + limit\n"
    duplicate = "def first():\n    return \"same\"\n\ndef second():\n    return \"same\"\n"
    similar = "def first():\n    return 1\ndef second():\n    return 2\n"
    crlf = "alpha\r\nbeta\r\n"
    bom = "\ufeffname = \"a\"\nname = \"b\"\n"
    long_file = "".join(f"line {number:03d}\n" for number in range(1, 161))
    long_line = f"prefix = {'x' * 1600}\n"
    multi = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"
    stale_source = "version = 1\nvalue = \"old\"\n"
    stale_current = "version = 2\nvalue = \"old\"\n"
    commit_source = "approved = false\n"
    commit_current = "approved = externally-changed\n"

    return (
        _fixture(
            "replace-single-line", "replace", "替换一个已读源行", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "hi"'),),
        ),
        _fixture(
            "replace-range", "replace", "替换连续的两行", ranged, 1, 4,
            (FixtureOperation("replace", 2, 3, "    value = 10\n    limit = 20"),),
        ),
        _fixture(
            "delete-line", "delete", "删除一个已读源行", single, 1, 2,
            (FixtureOperation("delete", 2, 2),),
        ),
        _fixture(
            "insert-before-line", "insert", "在已读锚点前插入一行", single, 1, 2,
            (FixtureOperation("insert", 2, new_text="    log()", insert_action="before"),),
        ),
        _fixture(
            "insert-after-line", "insert", "在已读锚点后插入一行", single, 1, 2,
            (FixtureOperation("insert", 2, new_text="    log()", insert_action="after"),),
        ),
        _fixture(
            "multi-non-overlap", "multi-edit", "一次提交两个非重叠编辑", multi, 1, 8,
            (
                FixtureOperation("replace", 2, 2, "TWO"),
                FixtureOperation("replace", 6, 6, "SIX"),
            ),
        ),
        _fixture(
            "duplicate-text", "duplicate", "重复文本只修改指定函数", duplicate, 1, 5,
            (FixtureOperation("replace", 2, 2, '    return "different"'),),
        ),
        _fixture(
            "similar-function", "similar", "相似函数中修改第二个函数", similar, 1, 4,
            (FixtureOperation("replace", 4, 4, "    return 20"),),
            wrong_valid_range=True,
        ),
        _fixture(
            "long-file-local-read", "long-file", "长文件只读取目标附近区间", long_file, 96, 110,
            (FixtureOperation("replace", 101, 101, "line 101 updated"),),
        ),
        _fixture(
            "long-line", "long-line", "超长单行仍使用原始源行号", long_line, 1, 1,
            (FixtureOperation("replace", 1, 1, "prefix = updated"),),
        ),
        _fixture(
            "empty-file-insert", "empty", "空文件插入首行", "", 1, 1,
            (FixtureOperation("insert", 1, new_text="created", insert_action="before"),),
        ),
        _fixture(
            "bom-utf8", "encoding", "保留 UTF-8 BOM", bom, 1, 2,
            (FixtureOperation("replace", 2, 2, 'name = "changed"'),),
        ),
        _fixture(
            "crlf", "encoding", "保留 CRLF 换行", crlf, 1, 2,
            (FixtureOperation("replace", 2, 2, "changed"),),
        ),
        _fixture(
            "no-final-newline", "encoding", "保留无末尾换行", "alpha\nbeta", 1, 2,
            (FixtureOperation("replace", 2, 2, "changed"),),
        ),
        _fixture(
            "stale-after-read", "stale", "read 后外部修改必须拒绝", stale_source, 1, 2,
            (FixtureOperation("replace", 2, 2, 'value = "new"'),),
            scenario="expected_error", expected_error="STALE_FILE", external_after_read=stale_current,
        ),
        _fixture(
            "commit-conflict", "concurrency", "审批后提交前外部修改必须拒绝", commit_source, 1, 1,
            (FixtureOperation("replace", 1, 1, "approved = true"),),
            scenario="expected_error", expected_error="COMMIT_CONFLICT", external_before_commit=commit_current,
        ),
        _fixture(
            "expired-snapshot", "snapshot", "淘汰的 Snapshot 不能继续编辑", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "new"'),),
            scenario="expected_error", expected_error="SNAPSHOT_EXPIRED", expire_snapshot=True,
        ),
        _fixture(
            "cross-thread", "scope", "Snapshot 不能跨 Thread 复用", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "new"'),),
            scenario="expected_error", expected_error="SNAPSHOT_SCOPE_MISMATCH", call_thread_id="thread-b",
        ),
        _fixture(
            "unread-range", "seen-range", "未读源行不能被编辑", single, 1, 1,
            (FixtureOperation("replace", 2, 2, '    return "new"'),),
            scenario="expected_error", expected_error="UNREAD_RANGE",
        ),
        _fixture(
            "wrong-path", "path", "Snapshot 路径必须与调用路径一致", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "new"'),),
            scenario="expected_error", expected_error="SNAPSHOT_SCOPE_MISMATCH", call_path="/src/other.txt",
        ),
        _fixture(
            "overlapping-edits", "overlap", "同批重叠 edits 必须零写入", ranged, 1, 4,
            (
                FixtureOperation("replace", 2, 3, "first"),
                FixtureOperation("replace", 3, 4, "second"),
            ),
            scenario="expected_error", expected_error="OVERLAPPING_EDITS",
        ),
        _fixture(
            "write-existing", "write", "write_file 对已有文件必须拒绝", single, 1, 2,
            (FixtureOperation("write", new_text="replacement"),),
            scenario="expected_error", expected_error="FILE_ALREADY_EXISTS",
        ),
        _fixture(
            "malformed-recovery", "recovery", "畸形参数失败后按错误提示重试", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "recovered"'),),
            scenario="recovery",
        ),
        _fixture(
            "no-op", "no-op", "拟议内容与当前内容相同时不重复写入", single, 1, 2,
            (FixtureOperation("replace", 2, 2, '    return "hello"'),),
            scenario="expected_error", expected_error="NO_CHANGES",
        ),
        _fixture(
            "invalid-range", "invalid-range", "越过文件末尾的范围必须拒绝", single, 1, 2,
            (FixtureOperation("replace", 99, 99, "invalid"),),
            scenario="expected_error", expected_error="INVALID_RANGE",
        ),
    )


def batch_fixture_catalog() -> tuple[EvaluationFixture, ...]:
    """返回 HC-185 的同文件批量编辑 fixture：同轮多编辑与批内失败场景。

    same-turn 类用来复现线上失败：基线对同一 snapshot_id 连发多个扁平调用，第二个起
    被拒；`exact-string-edits` 只发一次调用。edits_only 类验证批内规则，失败必须零写入。
    """

    multi = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"
    sixteen = "".join(f"line {number:02d}\n" for number in range(1, 17))
    duplicate = 'def first():\n    return "same"\n\ndef second():\n    return "same"\n'
    eight_ops = tuple(
        FixtureOperation("replace", line, line, f"LINE {line:02d}") for line in range(1, 16, 2)
    )

    def edit(old: str, new: str) -> dict[str, str]:
        return {"old_string": old, "new_string": new}

    return (
        _fixture(
            "same-turn-2-edits", "same-turn", "同一轮对同一文件连发两个编辑", multi, 1, 8,
            (
                FixtureOperation("replace", 2, 2, "TWO"),
                FixtureOperation("replace", 6, 6, "SIX"),
            ),
            same_turn=True,
        ),
        _fixture(
            "same-turn-8-edits", "same-turn", "同一轮对同一文件连发八个编辑（对应线上 Run 1327ba32）",
            sixteen, 1, 16, eight_ops, same_turn=True,
        ),
        _fixture(
            "batch-adjacent-allowed", "batch-success", "首尾相接的两处编辑不算重叠", multi, 1, 8,
            (
                FixtureOperation("replace", 2, 2, "TWO"),
                FixtureOperation("replace", 3, 3, "THREE"),
            ),
            edits_only=True,
        ),
        _fixture(
            "batch-reverse-order", "batch-success", "edits 顺序与文件顺序相反仍应成功", multi, 1, 8,
            (
                FixtureOperation("replace", 2, 2, "TWO"),
                FixtureOperation("replace", 6, 6, "SIX"),
            ),
            custom_edits=[edit("six\n", "SIX\n"), edit("two\n", "TWO\n")],
            edits_only=True,
        ),
        _fixture(
            "batch-item-not-found", "batch-failure", "第 1 处找不到，整批零写入", multi, 1, 8, (),
            scenario="expected_error", expected_error="EXACT_MATCH_NOT_FOUND", expected_edit_index=1,
            custom_edits=[edit("two\n", "TWO\n"), edit("missing\n", "x\n")], edits_only=True,
        ),
        _fixture(
            "batch-item-ambiguous", "batch-failure", "第 0 处在文件中不唯一，整批零写入", duplicate, 1, 5, (),
            scenario="expected_error", expected_error="AMBIGUOUS_MATCH", expected_edit_index=0,
            custom_edits=[edit('    return "same"\n', '    return "x"\n')], edits_only=True,
        ),
        _fixture(
            "batch-overlap-identical", "batch-failure", "两处完全相同的编辑视为重叠", multi, 1, 8, (),
            scenario="expected_error", expected_error="OVERLAPPING_EDITS", expected_edit_index=1,
            custom_edits=[edit("two\n", "A\n"), edit("two\n", "B\n")], edits_only=True,
        ),
        _fixture(
            "batch-overlap-nested", "batch-failure", "一处完全包含另一处视为重叠", multi, 1, 8, (),
            scenario="expected_error", expected_error="OVERLAPPING_EDITS", expected_edit_index=1,
            custom_edits=[edit("three\nfour\n", "X\n"), edit("four\n", "Y\n")], edits_only=True,
        ),
        _fixture(
            "batch-out-of-seen-range", "batch-failure", "第 1 处落在未读范围，整批零写入", multi, 1, 4, (),
            scenario="expected_error", expected_error="UNREAD_RANGE", expected_edit_index=1,
            custom_edits=[edit("two\n", "TWO\n"), edit("six\n", "SIX\n")], edits_only=True,
        ),
        _fixture(
            "batch-empty-file-mixed", "batch-failure", "空 old_string 与其他项混用必须拒绝", "", 1, 1, (),
            scenario="expected_error", expected_error="INVALID_EDIT", expected_edit_index=0,
            custom_edits=[edit("", "a\n"), edit("x", "y")], edits_only=True,
        ),
        _fixture(
            "batch-too-many", "batch-failure", "超过 20 项必须拒绝", multi, 1, 8, (),
            scenario="expected_error", expected_error="TOO_MANY_EDITS",
            custom_edits=[edit("two\n", "TWO\n")] * 21, edits_only=True,
        ),
        _fixture(
            "batch-malformed-empty", "batch-malformed", "edits 为空数组", multi, 1, 8, (),
            scenario="expected_error", expected_error="FILE_TOOL_SCHEMA_INVALID",
            custom_edits=[], edits_only=True,
        ),
        _fixture(
            "batch-malformed-not-list", "batch-malformed", "edits 不是数组", multi, 1, 8, (),
            scenario="expected_error", expected_error="FILE_TOOL_SCHEMA_INVALID",
            custom_edits="oops", edits_only=True,
        ),
        _fixture(
            "batch-malformed-missing-field", "batch-malformed", "项缺少 new_string", multi, 1, 8, (),
            scenario="expected_error", expected_error="FILE_TOOL_SCHEMA_INVALID", expected_edit_index=0,
            custom_edits=[{"old_string": "two\n"}], edits_only=True,
        ),
        _fixture(
            "batch-malformed-extra-field", "batch-malformed", "项带有多余字段", multi, 1, 8, (),
            scenario="expected_error", expected_error="FILE_TOOL_SCHEMA_INVALID", expected_edit_index=0,
            custom_edits=[{"old_string": "two\n", "new_string": "x\n", "replace_all": True}], edits_only=True,
        ),
        _fixture(
            "batch-malformed-non-string", "batch-malformed", "项字段不是字符串", multi, 1, 8, (),
            scenario="expected_error", expected_error="FILE_TOOL_SCHEMA_INVALID", expected_edit_index=0,
            custom_edits=[{"old_string": "two\n", "new_string": 1}], edits_only=True,
        ),
    )
