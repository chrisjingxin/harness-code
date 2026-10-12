"""文件变更的两阶段提交服务（准备 Prepare -> 审批 Diff -> 提交 Commit）。

【为什么文件修改需要两阶段（Prepare / Commit）？】
在 AI 协同编程中，“向用户展示审批卡片”和“实际执行文件写入”之间存在时间差。
如果像传统实现那样，等用户批准后再根据参数重新读取文件、重新生成内容并写入，就会面临两大风险：
1. 内容漂移（Drift）：用户在界面上批准的 Diff 是根据时刻 T1 的文件生成的，但在时刻 T2 真正写入时，
   文件可能已被外部编辑或参数发生微调，导致写入磁盘的内容与用户同意的内容不符；
2. 批准重放（Replay）：某次工具调用的审批结果被重复执行多次，产生不可预期的脏写入。

为了做到“所见即所签，所签即所写”，本服务实行严格的两阶段提交：
- 阶段 1 (Prepare)：在发起审批前，固定当前磁盘内容（Current）、拟修改内容（Proposed），
  生成不可篡改的变更计划（PreparedFileMutation）并渲染出供人类阅读的 Unified Diff 预览；
- 阶段 2 (Commit)：用户批准后，直接拿阶段 1 冻结好的内容，以原子比对替换（CAS）的方式写入磁盘。
  无论写入成功与否，该计划立即被消费并注销，绝不允许二次重放。

┌────────────────────────────────────────────────────────────────────────┐
│                 文件变更两阶段流程：准备 (Prepare) 与提交 (Commit)      │
└────────────────────────────────────────────────────────────────────────┘

   SnapshotFileToolContract            FileMutationService                TextBackend (本地磁盘)
            │                                   │                                 │
   1. 发起修改 (write/edit/delete)               │                                 │
            │──── prepare(metadata, proposed) ─>│                                 │
            │                                   │ 1. 冻结当前内容与拟修改内容      │
            │                                   │ 2. 生成 Unified Diff 预览       │
            │                                   │ 3. 记录参数指纹，防止改参偷换   │
            │<─── 返回 PreparedFileMutation ────│                                 │
            │                                   │                                 │
   2. 呈现给用户审批 (HITL)                     │                                 │
            │── 将 Diff 预览渲染给用户 ─────────│                                 │
            │── 用户点击「批准 (Approve)」──────│                                 │
            │                                   │                                 │
   3. 执行落盘 (Commit)                         │                                 │
            │──── commit(prepared_plan) ───────>│                                 │
            │                                   │ 1. 校验版本指纹 (确认磁盘未变)  │
            │                                   │ 2. 原子写入拟修改内容 ─────────>│
            │                                   │ 3. 消费并废弃该计划 (不可重放)  │
            │                                   │ 4. 回读最新磁盘内容 ───────────>│
            │<─── 返回 CommittedFileMutation ───│<── 返回最新真实文本 ────────────│
"""

from __future__ import annotations

from contextlib import nullcontext
import difflib
import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Literal

from harness_agent.threads.text_backend import (
    ContentIdentity,
    TextDocument,
    TextMutationBackend,
    TextMutationError,
)

MutationOperation = Literal["write", "edit", "delete"]
"""当前 canonical 文件工具允许提交的单文件 mutation 类型。"""

MAX_APPROVAL_DIFF_BYTES = 16 * 1024
"""审批描述中统一 diff 的 UTF-8 字节上限（避免几万行的 Diff 撑爆界面）。"""

MAX_APPROVAL_DIFF_LINES = 200
"""审批描述中统一 diff 的最大显示行数。"""

MAX_PREPARED_MUTATION_BYTES = 8 * 1024 * 1024
"""跨等待审批保留的 current/proposed 文本总内存预算（防止过多未审批计划耗尽内存）。"""

MAX_CONSUMED_PLAN_KEYS = 512
"""仅保存指纹的已消费计划上限，防止旧批准因缓存淘汰而被重新 prepare。"""

_INVALIDATED_PLAN_FINGERPRINT = "invalidated"
"""标记待审批计划曾发生改参；原参数和新参数都不得再提交。"""


@dataclass(frozen=True, slots=True)
class MutationMetadata:
    """不含模型原始参数的单文件提交元数据。"""

    operation: MutationOperation
    path: str
    thread_id: str
    tool_call_id: str
    snapshot_id: str | None = None
    fusion_authorization: tuple[str, int, int] | None = None


@dataclass(frozen=True, slots=True)
class MutationDiff:
    """审批和 post-write drift 共用的有界文本 diff 预览。"""

    text: str
    added_lines: int
    removed_lines: int
    truncated: bool


@dataclass(frozen=True, slots=True)
class FileMutationApprovalDetails:
    """同一 prepared plan 派生的人类摘要与结构化有界展示。"""

    description: str
    presentation: dict[str, object]


@dataclass(frozen=True, slots=True)
class MutationChangedRange:
    """实际落盘版本相对提交前版本的 1-based 源行变化范围。"""

    start_line: int
    end_line: int
    added_lines: int
    removed_lines: int

    def payload(self) -> dict[str, int]:
        """转换为模型可直接引用的新 Snapshot 源行范围。"""
        return {
            "start_line": self.start_line,
            "end_line": self.end_line,
            "added_lines": self.added_lines,
            "removed_lines": self.removed_lines,
        }


@dataclass(frozen=True, slots=True)
class PreparedFileMutation:
    """审批前已经固定的 current/proposed 内容和预期版本。"""

    metadata: MutationMetadata
    current: TextDocument | None
    proposed_content: str | None
    expected_identity: ContentIdentity | None
    diff: MutationDiff
    fingerprint: str

    @property
    def retained_bytes(self) -> int:
        """计算本计划占用的有界内存预算。"""
        current = len(self.current.content.encode("utf-8")) if self.current is not None else 0
        proposed = len(self.proposed_content.encode("utf-8")) if self.proposed_content is not None else 0
        return current + proposed


@dataclass(frozen=True, slots=True)
class CommittedFileMutation:
    """提交后的真实读取结果；drift 只描述实际与已批准内容的差异。"""

    actual: TextDocument | None
    drift: MutationDiff | None
    changed_range: MutationChangedRange


class FileMutationService:
    """文件变更服务：负责拟修改计划的准备 (Prepare)、Diff 预览生成与原子提交 (Commit)。"""

    def __init__(
        self,
        backend: TextMutationBackend,
        *,
        max_prepared_bytes: int = MAX_PREPARED_MUTATION_BYTES,
        mutation_guard: Any | None = None,
    ) -> None:
        """初始化服务，绑定底层文件写入后端，并设置等待审批计划的最大内存预算。
        
        为什么需要限制内存预算？
        如果 Agent 在一次会话中连续生成了许多待审批的文件修改计划，而用户迟迟没有做出决定，
        这些计划保留的完整文本可能会过度消耗内存。因此通过 LRU 淘汰机制限制总保留字节数。
        """
        self._mutation_guard = mutation_guard
        if max_prepared_bytes < 1:
            raise ValueError("PREPARED_MUTATION_LIMIT_INVALID")
        self._backend = backend
        self._max_prepared_bytes = max_prepared_bytes
        self._prepared: OrderedDict[tuple[str, str], PreparedFileMutation] = OrderedDict()
        self._consumed_fingerprints: OrderedDict[tuple[str, str], str] = OrderedDict()
        self._prepared_bytes = 0
        self._lock = threading.RLock()

    def prepared(
        self,
        *,
        thread_id: str,
        tool_call_id: str,
        fingerprint: str,
    ) -> PreparedFileMutation | None:
        """按会话 ID、工具调用 ID 和参数指纹，取回已固定的修改计划。
        
        【防偷换参数检查】：
        如果找到了该调用的待审批计划，但参数指纹与当前传入的不同，说明该调用在用户审批后
        参数被恶意或意外篡改了。为了防止提交“用户未批准的代码”，会立即作废该计划并报错。
        """
        key = (thread_id, tool_call_id)
        with self._lock:
            plan = self._prepared.get(key)
            if plan is None:
                return None
            if plan.fingerprint != fingerprint:
                # Tool Call ID 是审批关联身份；审批后改参不能作为
                # 一次“新计划”现场重建，否则会提交用户未批准的 diff。
                self._prepared.pop(key)
                self._prepared_bytes -= plan.retained_bytes
                self._remember_consumed(key, _INVALIDATED_PLAN_FINGERPRINT)
                raise TextMutationError("COMMIT_CONFLICT", "已审批调用的参数已变化")
            self._prepared.move_to_end(key)
            return plan

    def was_consumed(
        self,
        *,
        thread_id: str,
        tool_call_id: str,
        fingerprint: str,
    ) -> bool:
        """检查该计划是否已经被提交执行过，或已经因为改参而失效（防止重复提交）。"""
        key = (thread_id, tool_call_id)
        with self._lock:
            consumed = self._consumed_fingerprints.get(key)
            if consumed not in {fingerprint, _INVALIDATED_PLAN_FINGERPRINT}:
                return False
            self._consumed_fingerprints.move_to_end(key)
            return True

    def prepare(
        self,
        *,
        metadata: MutationMetadata,
        current: TextDocument | None,
        proposed_content: str | None,
        fingerprint: str,
    ) -> PreparedFileMutation:
        """准备文件变更计划：冻结当前内容与拟修改内容，并生成供人类阅读的 Unified Diff。"""
        self._validate_input(metadata, current, proposed_content)
        plan = PreparedFileMutation(
            metadata=metadata,
            current=current,
            proposed_content=proposed_content,
            expected_identity=current.identity if current is not None else None,
            diff=_render_diff(
                path=metadata.path,
                before="" if current is None else current.content,
                after="" if proposed_content is None else proposed_content,
                operation=metadata.operation,
            ),
            fingerprint=fingerprint,
        )
        self._remember(plan)
        return plan

    def approval_description(self, plan: PreparedFileMutation) -> str:
        """生成供人类在 TUI 或终端查看的有界文本 Diff 说明。"""
        details = self.approval_details(plan)
        operation = {"write": "创建文件", "edit": "编辑文件", "delete": "删除文件"}[
            plan.metadata.operation
        ]
        diff_note = "（预览因上限截断）" if plan.diff.truncated else ""
        return "\n".join(
            (
                details.description,
                f"操作：{operation}",
                f"文件：{plan.metadata.path}",
                f"变更：+{plan.diff.added_lines} / -{plan.diff.removed_lines} 行 {diff_note}".rstrip(),
                "以下是拟议内容的有界 diff 预览；批准将提交本次调用已固定的完整拟议内容：",
                plan.diff.text or "（空文件内容变更）",
            )
        )

    def approval_details(self, plan: PreparedFileMutation) -> FileMutationApprovalDetails:
        """生成供前端组件渲染富文本高亮对比的结构化详情对象。"""
        return FileMutationApprovalDetails(
            description="文件变更需要审批",
            presentation={
                "kind": "file_diff",
                "operation": plan.metadata.operation,
                "path": plan.metadata.path,
                "added_lines": plan.diff.added_lines,
                "removed_lines": plan.diff.removed_lines,
                "truncated": plan.diff.truncated,
                "unified_diff": plan.diff.text,
            },
        )

    def commit(self, plan: PreparedFileMutation) -> CommittedFileMutation:
        """执行实际提交写入，并在执行完毕后强制销毁计划（保证一次批准只执行一次）。"""
        try:
            with self._mutation_guard.commit(plan.metadata) if self._mutation_guard else nullcontext():
                self._commit_guarded(plan)
                actual = self._read_after_commit(plan.metadata.path)
        finally:
            self.discard(plan)

        expected_content = plan.proposed_content
        actual_content = actual.content if actual is not None else None
        changed_range = _changed_range(
            "" if plan.current is None else plan.current.content,
            "" if actual_content is None else actual_content,
        )
        if actual_content == expected_content:
            return CommittedFileMutation(actual=actual, drift=None, changed_range=changed_range)
        return CommittedFileMutation(
            actual=actual,
            drift=_render_diff(
                path=plan.metadata.path,
                before="" if expected_content is None else expected_content,
                after="" if actual_content is None else actual_content,
                operation="edit",
            ),
            changed_range=changed_range,
        )

    def _commit_guarded(self, plan: PreparedFileMutation) -> None:
        """在可选的写者事务内执行原有单文件 CAS。"""
        if plan.metadata.operation == "write":
            self._commit_create(plan)
        elif plan.metadata.operation == "edit":
            self._commit_replace(plan)
        else:
            self._commit_delete(plan)

    def discard(self, plan: PreparedFileMutation) -> None:
        """删除已消费或失败计划，确保批准不可重放。"""
        key = (plan.metadata.thread_id, plan.metadata.tool_call_id)
        with self._lock:
            current = self._prepared.get(key)
            if current is not plan:
                return
            self._prepared.pop(key)
            self._prepared_bytes -= current.retained_bytes
            self._remember_consumed(key, current.fingerprint)

    def _commit_create(self, plan: PreparedFileMutation) -> None:
        """提交 create-if-absent；批准后出现目标统一视作版本冲突。"""
        assert plan.proposed_content is not None
        try:
            self._backend.create_text_document(plan.metadata.path, plan.proposed_content)
        except TextMutationError as exc:
            if exc.code == "FILE_ALREADY_EXISTS":
                raise TextMutationError("COMMIT_CONFLICT", "批准后目标文件已出现") from exc
            raise

    def _commit_replace(self, plan: PreparedFileMutation) -> None:
        """仅以 prepare 时的强 identity 执行 compare-and-replace。"""
        assert plan.expected_identity is not None
        assert plan.proposed_content is not None
        self._backend.compare_and_replace_text(
            plan.metadata.path,
            plan.expected_identity,
            plan.proposed_content,
        )

    def _commit_delete(self, plan: PreparedFileMutation) -> None:
        """仅以 prepare 时的强 identity 执行 compare-and-delete。"""
        assert plan.expected_identity is not None
        self._backend.delete_if_unchanged(plan.metadata.path, plan.expected_identity)

    def _read_after_commit(self, path: str) -> TextDocument | None:
        """提交后重新读取真实文件；删除成功时 FILE_NOT_FOUND 是预期终态。"""
        try:
            return self._backend.read_text_document(path)
        except TextMutationError as exc:
            if exc.code == "FILE_NOT_FOUND":
                return None
            raise TextMutationError("COMMIT_FAILED", "提交后无法重新读取实际文件") from exc

    def _remember(self, plan: PreparedFileMutation) -> None:
        """以 LRU 形式保留待审批计划，超过总预算时淘汰旧计划。"""
        key = (plan.metadata.thread_id, plan.metadata.tool_call_id)
        with self._lock:
            consumed = self._consumed_fingerprints.get(key)
            if consumed in {plan.fingerprint, _INVALIDATED_PLAN_FINGERPRINT}:
                raise TextMutationError("COMMIT_CONFLICT", "已消费的调用 ID 不能重新准备")
            self._consumed_fingerprints.pop(key, None)
            previous = self._prepared.get(key)
            if previous is not None and previous.fingerprint != plan.fingerprint:
                self._prepared.pop(key)
                self._prepared_bytes -= previous.retained_bytes
                self._remember_consumed(key, _INVALIDATED_PLAN_FINGERPRINT)
                raise TextMutationError("COMMIT_CONFLICT", "已准备调用的参数已变化")
            previous = self._prepared.pop(key, None)
            if previous is not None:
                self._prepared_bytes -= previous.retained_bytes
            self._prepared[key] = plan
            self._prepared_bytes += plan.retained_bytes
            while self._prepared and self._prepared_bytes > self._max_prepared_bytes:
                evicted_key, evicted = self._prepared.popitem(last=False)
                self._prepared_bytes -= evicted.retained_bytes
                self._remember_consumed(evicted_key, evicted.fingerprint)

    def _remember_consumed(self, key: tuple[str, str], fingerprint: str) -> None:
        """以小型 LRU 留下无源码的拒绝标记，防止旧批准重放。"""
        self._consumed_fingerprints[key] = fingerprint
        self._consumed_fingerprints.move_to_end(key)
        while len(self._consumed_fingerprints) > MAX_CONSUMED_PLAN_KEYS:
            self._consumed_fingerprints.popitem(last=False)

    @staticmethod
    def _validate_input(
        metadata: MutationMetadata,
        current: TextDocument | None,
        proposed_content: str | None,
    ) -> None:
        """拒绝不完整内部输入，防止 service 被误用为第二个原始写入口。"""
        if not metadata.thread_id or not metadata.tool_call_id or not metadata.path:
            raise ValueError("MUTATION_METADATA_INVALID")
        if metadata.operation == "write":
            if current is not None or proposed_content is None:
                raise ValueError("MUTATION_CREATE_INPUT_INVALID")
            return
        if metadata.operation == "edit":
            if current is None or proposed_content is None:
                raise ValueError("MUTATION_EDIT_INPUT_INVALID")
            return
        if metadata.operation == "delete" and (current is None or proposed_content is not None):
            raise ValueError("MUTATION_DELETE_INPUT_INVALID")


def mutation_fingerprint(name: str, args: dict[str, object]) -> str:
    """为同一模型调用生成稳定参数指纹，避免批准计划被改参复用。"""
    payload = json.dumps({"name": name, "args": args}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _render_diff(
    *,
    path: str,
    before: str,
    after: str,
    operation: MutationOperation,
) -> MutationDiff:
    """生成带行统计且受字节/行数双重限制的 unified diff。"""
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    added = 0
    removed = 0
    for tag, start_before, end_before, start_after, end_after in difflib.SequenceMatcher(
        a=before_lines,
        b=after_lines,
        autojunk=False,
    ).get_opcodes():
        if tag in {"replace", "delete"}:
            removed += end_before - start_before
        if tag in {"replace", "insert"}:
            added += end_after - start_after

    source = "/dev/null" if operation == "write" else path
    target = "/dev/null" if operation == "delete" else path
    raw_lines = list(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile=source,
            tofile=target,
            lineterm="",
        )
    )
    lines = _normalise_diff_lines(raw_lines)
    return MutationDiff(
        text=_truncate_diff(lines),
        added_lines=added,
        removed_lines=removed,
        truncated=_diff_is_truncated(lines),
    )


def _changed_range(before: str, after: str) -> MutationChangedRange:
    """以实际重读内容计算新增/删除及其在新版本中的最小连续范围。"""
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    changed = [
        (tag, start_before, end_before, start_after, end_after)
        for tag, start_before, end_before, start_after, end_after in difflib.SequenceMatcher(
            a=before_lines,
            b=after_lines,
            autojunk=False,
        ).get_opcodes()
        if tag != "equal"
    ]
    if not changed:
        return MutationChangedRange(1, 0, 0, 0)
    added = sum(
        end_after - start_after
        for tag, _start_before, _end_before, start_after, end_after in changed
        if tag in {"replace", "insert"}
    )
    removed = sum(
        end_before - start_before
        for tag, start_before, end_before, _start_after, _end_after in changed
        if tag in {"replace", "delete"}
    )
    start = min(start_after for _tag, _i1, _i2, start_after, _j2 in changed)
    end = max(end_after for _tag, _i1, _i2, _j1, end_after in changed)
    # 纯删除没有新源行；start_line 是删除后的插入点，end_line 小于它表示空范围。
    return MutationChangedRange(
        start_line=start + 1,
        end_line=end,
        added_lines=added,
        removed_lines=removed,
    )


def _truncate_diff(lines: list[str]) -> str:
    """按显示行与 UTF-8 字节限制截断 unified diff，并保留显式提示。"""
    output: list[str] = []
    used_bytes = 0
    for line in lines:
        rendered = f"{line}\n"
        rendered_bytes = len(rendered.encode("utf-8"))
        if len(output) >= MAX_APPROVAL_DIFF_LINES or used_bytes + rendered_bytes > MAX_APPROVAL_DIFF_BYTES:
            break
        output.append(line)
        used_bytes += rendered_bytes
    if len(output) == len(lines):
        return "\n".join(output)
    marker = "[diff 因行数或字节上限截断]"
    marker_bytes = len(marker.encode("utf-8")) + (1 if output else 0)
    while output and used_bytes + marker_bytes > MAX_APPROVAL_DIFF_BYTES:
        removed = output.pop()
        used_bytes -= len(f"{removed}\n".encode("utf-8"))
    output.append(marker)
    return "\n".join(output)


def _normalise_diff_lines(lines: list[str]) -> list[str]:
    """把保留源码换行的 difflib 输出转成逐行显示，显式标记末尾换行差异。"""
    normalised: list[str] = []
    for line in lines:
        has_terminator = line.endswith(("\n", "\r"))
        normalised.append(line.rstrip("\r\n"))
        if (
            not has_terminator
            and line[:1] in {"+", "-", " "}
            and not line.startswith(("--- ", "+++ "))
        ):
            normalised.append("\\ No newline at end of file")
    return normalised


def _diff_is_truncated(lines: list[str]) -> bool:
    """复用截断条件，避免向审批层暴露未经限制的 diff 文本。"""
    used_bytes = 0
    for index, line in enumerate(lines):
        if index >= MAX_APPROVAL_DIFF_LINES:
            return True
        used_bytes += len(f"{line}\n".encode("utf-8"))
        if used_bytes > MAX_APPROVAL_DIFF_BYTES:
            return True
    return False


__all__ = [
    "CommittedFileMutation",
    "FileMutationService",
    "FileMutationApprovalDetails",
    "MutationChangedRange",
    "MAX_APPROVAL_DIFF_BYTES",
    "MAX_APPROVAL_DIFF_LINES",
    "MAX_CONSUMED_PLAN_KEYS",
    "MutationDiff",
    "MutationMetadata",
    "PreparedFileMutation",
    "mutation_fingerprint",
]
