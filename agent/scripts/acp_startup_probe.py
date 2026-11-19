"""ACP 启动耗时测量脚本（HC-200 S1）：用真实子进程量出四段关键耗时。

【这是做什么的？】
以 subprocess 启动 ``python -m harness_agent acp``，走真实 stdio JSON-RPC，
测量 Plan「停点 1」要优化的四段耗时，输出每次的明细与中位数：

    ① init_ms        spawn → initialize 响应
    ② new_ms         发出 session/new → 响应；new_abs_ms 是相对 spawn 的绝对值
    ③ commands_ms    session/new 响应 → 首个 available_commands_update
                     （对端不发命令表时为 null——改前基线即如此）
    ④ list_ms        发出 session/list → 响应

【用法】
    .venv/bin/python scripts/acp_startup_probe.py [--runs N] [--seed-threads N]
        [--home temp|real] [--json]

【隔离与播种约定】
- ``--home temp``（默认）：子进程 HOME 指向临时目录、cwd 是临时空目录（进程
  cwd 即 Host workspace），不注入任何 API Key，不读用户真实配置。
- ``--home real``：沿用当前环境 HOME 只读配置；此时 ``--seed-threads``
  被拒绝（绝不写用户真实线程库）。
- 播种用 ``ThreadPersistence.open(project=workspace, home=home)`` +
  ``accept_run`` 在临时库写入 N 条线程索引，而不是手工拼 SQL。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import select
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

AGENT_DIR = Path(__file__).resolve().parents[1]
READ_CHUNK = 65536
RUN_DEADLINE_S = 60.0
COMMANDS_WAIT_S = 5.0
STDERR_KEEP = 10


# ---------- 线程库播种（真实持久层 API，非手写 SQL） ----------


def _probe_binding(thread_id: str, run_id: str, created_at_ms: int):
    """构造最小合法 RunExecutionBinding；字段与 tests/support/thread_fixtures 同款。"""
    from harness_agent.runtime.execution_binding import (
        RunExecutionBinding,
        SafeModelProfile,
        SelectionOrigin,
        ThreadExecutionSelection,
    )

    return RunExecutionBinding(
        thread_id=thread_id,
        run_id=run_id,
        requested_selection=ThreadExecutionSelection("probe"),
        actual_primary=SafeModelProfile(
            profile_id="probe",
            model="probe-model",
            provider_label="Probe",
            context_window_tokens=128_000,
            capabilities=("streaming", "tool-calling"),
            is_default=True,
            available=True,
            unavailable_reason=None,
            source="probe",
        ),
        selection_origin=SelectionOrigin.REQUEST,
        runtime_profile_id="probe-runtime",
        created_at_ms=created_at_ms,
    )


async def _seed_async(workspace: Path, home: Path, count: int) -> None:
    """在 ``home/.harness/threads.sqlite3`` 里为 ``workspace`` 播种 ``count`` 条线程。"""
    from harness_agent.threads.thread_persistence import AcceptRun, ThreadPersistence

    store = await ThreadPersistence.open(project=workspace, home=home)
    try:
        base_ms = int(time.time() * 1000) - count  # 递增 updated_at_ms，避免全同刻
        for i in range(count):
            thread_id = f"probe-seed-{i:05d}"
            await store.accept_run(
                AcceptRun(
                    message=f"seed {i}",
                    binding=_probe_binding(thread_id, f"probe-run-{i:05d}", base_ms + i),
                )
            )
    finally:
        await store.close()


def seed_threads(workspace: Path, home: Path, count: int) -> None:
    """同步入口：包一层 asyncio.run，供 argparse 主流程调用。"""
    asyncio.run(_seed_async(workspace, home, count))


# ---------- 子进程与帧读取 ----------


def spawn_agent(workspace: Path, home: Path | None) -> subprocess.Popen[bytes]:
    """启动 ``python -m harness_agent acp``；``home=None`` 表示沿用当前 HOME。"""
    env = dict(os.environ)
    env.pop("HARNESS_ECHO_MODE", None)
    env.pop("HARNESS_AGENT_CONFIG_PATH", None)
    if home is not None:
        env["HOME"] = str(home)
    return subprocess.Popen(
        [sys.executable, "-m", "harness_agent", "acp"],
        cwd=workspace,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def read_frames(
    proc: subprocess.Popen[bytes],
    deadline: float,
    stop: "Any | None" = None,
    carry: dict[str, bytes] | None = None,
) -> tuple[list[tuple[float, dict[str, Any]]], list[str]]:
    """按行读 stdout JSON 帧直到 EOF、deadline 或 stop(帧) 命中；顺带收 stderr。

    输出：(按到达顺序的 (相对 RUN_T0 毫秒, 帧), stderr 行)。
    ``stop`` 是 ``(frame) -> bool`` 谓词：首个满足它的帧到达后立即返回，
    不傻等 deadline——握手各阶段的「等 id=N 响应」全靠它截停。
    """
    frames: list[tuple[float, dict[str, Any]]] = []
    stderr_lines: list[str] = []
    out_fd, err_fd = proc.stdout.fileno(), proc.stderr.fileno()  # type: ignore[union-attr]
    # carry 串起多次调用：stop 命中时 buf 里可能还压着同 chunk 的下一帧
    # （如 session/new 响应与 available_commands_update 同批到达）。
    bufs = (
        {out_fd: carry.get("out", b""), err_fd: carry.get("err", b"")}
        if carry is not None
        else {out_fd: b"", err_fd: b""}
    )
    open_fds = {out_fd, err_fd}
    stopped = False

    def drain(fd: int) -> None:
        nonlocal stopped
        while b"\n" in bufs[fd] and not stopped:
            line, bufs[fd] = bufs[fd].split(b"\n", 1)
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            if fd == err_fd:
                stderr_lines.append(text)
                continue
            at_ms = (time.monotonic() - RUN_T0) * 1000
            try:
                frame: dict[str, Any] = json.loads(text)
            except json.JSONDecodeError:
                frame = {"__non_json__": text}
            frames.append((at_ms, frame))
            if stop is not None and stop(frame):
                stopped = True

    # carry 里可能已经压着整行（上一段同 chunk 未消费的帧），先排干再进 select。
    drain(out_fd)
    drain(err_fd)
    while open_fds and time.monotonic() < deadline and not stopped:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select(list(open_fds), [], [], remaining)
        if not ready:
            break
        for fd in ready:
            try:
                chunk = os.read(fd, READ_CHUNK)
            except OSError:
                chunk = b""
            if not chunk:
                open_fds.discard(fd)
                continue
            bufs[fd] += chunk
            drain(fd)
    if carry is not None:
        carry["out"], carry["err"] = bufs[out_fd], bufs[err_fd]
    return frames, stderr_lines


RUN_T0 = 0.0


def _is_response(frame: dict[str, Any], request_id: int) -> bool:
    """判定该帧是 ``request_id`` 的终态响应（result 或 error）。"""
    return frame.get("id") == request_id and ("result" in frame or "error" in frame)


def _is_commands_update(frame: dict[str, Any]) -> bool:
    """判定该帧是 available_commands_update 的 session/update。"""
    if frame.get("method") != "session/update":
        return False
    params = frame.get("params")
    return (
        isinstance(params, dict)
        and isinstance(params.get("update"), dict)
        and params["update"].get("sessionUpdate") == "available_commands_update"
    )


def _send(proc: subprocess.Popen[bytes], frame: dict[str, Any]) -> float:
    """写一帧并 flush；返回发送时刻相对 RUN_T0 的毫秒。"""
    assert proc.stdin is not None
    proc.stdin.write((json.dumps(frame) + "\n").encode())
    proc.stdin.flush()
    return (time.monotonic() - RUN_T0) * 1000


def measure_once(
    index: int,
    *,
    seed_count: int,
    home_mode: str,
    tmp_root: Path,
) -> dict[str, Any]:
    """跑一次完整握手流程，返回四段耗时记录。"""
    global RUN_T0
    workspace = Path(tempfile.mkdtemp(prefix=f"acp-probe-ws{index}-", dir=tmp_root))
    home: Path | None = None
    if home_mode == "temp":
        home = Path(tempfile.mkdtemp(prefix=f"acp-probe-home{index}-", dir=tmp_root))
        if seed_count:
            seed_threads(workspace, home, seed_count)
    proc = spawn_agent(workspace, home)
    stderr_lines: list[str] = []
    result: dict[str, Any] = {"run": index, "workspace": str(workspace)}
    try:
        RUN_T0 = time.monotonic()
        _send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": 1, "clientCapabilities": {}},
            },
        )
        frame_carry: dict[str, bytes] = {}
        frames, err1 = read_frames(proc, RUN_T0 + RUN_DEADLINE_S, stop=lambda f: _is_response(f, 1),
                                   carry=frame_carry)
        stderr_lines += err1
        t_init = next((ms for ms, f in frames if _is_response(f, 1)), None)
        init_frame = next((f for _, f in frames if _is_response(f, 1)), None)
        result["init_ms"] = t_init
        if init_frame is not None and "error" in init_frame:
            result["init_error"] = init_frame["error"]

        new_sent = _send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": str(workspace), "mcpServers": []},
            },
        )
        frames, err2 = read_frames(proc, RUN_T0 + RUN_DEADLINE_S, stop=lambda f: _is_response(f, 2), carry=frame_carry)
        stderr_lines += err2
        t_new = next((ms for ms, f in frames if _is_response(f, 2)), None)
        new_frame = next((f for _, f in frames if _is_response(f, 2)), None)
        result["new_ms"] = None if t_new is None else t_new - new_sent
        result["new_abs_ms"] = t_new
        if new_frame is not None and "error" in new_frame:
            result["new_error"] = new_frame["error"]

        # 命令表通知可能先于/晚于 session/new 响应到达：先检查响应读回
        # 的帧里是否已吃到它，没有再继续读直到命中或等满 5 秒。
        t_cmd = next((ms for ms, f in frames if _is_commands_update(f)), None)
        if t_cmd is None:
            frames2, err3 = read_frames(
                proc, time.monotonic() + COMMANDS_WAIT_S, stop=_is_commands_update,
                carry=frame_carry,
            )
            stderr_lines += err3
            t_cmd = next((ms for ms, f in frames2 if _is_commands_update(f)), None)
        # 通知先于响应到达时 delta 略为负，按 0 计（相对响应到达时刻）。
        result["commands_ms"] = (
            None if (t_cmd is None or t_new is None) else max(0.0, t_cmd - t_new)
        )
        result["commands_abs_ms"] = t_cmd
        if t_cmd is None and t_new is not None:
            result["commands_timeout"] = True
            stderr_lines.append("[probe] available_commands_update timeout")

        list_sent = _send(
            proc,
            {"jsonrpc": "2.0", "id": 3, "method": "session/list", "params": {}},
        )
        frames, err4 = read_frames(proc, RUN_T0 + RUN_DEADLINE_S, stop=lambda f: _is_response(f, 3),
                                   carry=frame_carry)
        stderr_lines += err4
        t_list = next((ms for ms, f in frames if _is_response(f, 3)), None)
        list_frame = next((f for _, f in frames if _is_response(f, 3)), None)
        result["list_ms"] = None if t_list is None else t_list - list_sent
        if list_frame is not None and "error" in list_frame:
            result["list_error"] = list_frame["error"]
        elif isinstance(list_frame, dict):
            sessions = (list_frame.get("result") or {}).get("sessions")
            if isinstance(sessions, list):
                result["list_count"] = len(sessions)
    finally:
        proc.terminate()
        try:
            result["exit_code"] = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            result["exit_code"] = proc.wait(timeout=5)
        result["stderr_tail"] = stderr_lines[-STDERR_KEEP:]
    return result


def _median(values: list[float | None]) -> float | None:
    """忽略 null 的中位数；全 null 时返回 None。"""
    present = [v for v in values if v is not None]
    return statistics.median(present) if present else None


def build_parser() -> argparse.ArgumentParser:
    """命令行参数：runs / seed-threads / home / json。"""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=5, help="测量轮数（默认 5）")
    parser.add_argument("--seed-threads", type=int, default=0, help="临时线程库预置条数（仅 --home temp）")
    parser.add_argument("--home", choices=("temp", "real"), default="temp", help="temp=临时 HOME（默认）；real=沿用真实 HOME 只读配置")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是表格")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.runs < 1:
        print("--runs 必须 >= 1", file=sys.stderr)
        return 2
    if args.home == "real" and args.seed_threads:
        print("--seed-threads 禁止与 --home real 同用（绝不写用户真实线程库）", file=sys.stderr)
        return 2

    report: dict[str, Any] = {
        "env": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "home_mode": args.home,
            "seed_threads": args.seed_threads,
        },
        "runs": [],
    }
    with tempfile.TemporaryDirectory(prefix="acp-probe-") as tmp:
        tmp_root = Path(tmp)
        for i in range(1, args.runs + 1):
            report["runs"].append(
                measure_once(i, seed_count=args.seed_threads, home_mode=args.home, tmp_root=tmp_root)
            )
    keys = ("init_ms", "new_ms", "new_abs_ms", "commands_ms", "list_ms")
    report["median"] = {k: _median([r.get(k) for r in report["runs"]]) for k in keys}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    env = report["env"]
    print(f"# ACP 启动耗时测量（python {env['python']} / {env['platform']}）")
    print(f"# home={env['home_mode']} seed_threads={env['seed_threads']} runs={args.runs}")
    print(f"{'run':>4} | {'init_ms':>10} | {'new_ms':>8} | {'new_abs_ms':>10} | {'commands_ms':>11} | {'list_ms':>8}")
    print("-" * 72)
    for r in report["runs"]:
        fmt = lambda v: "null" if v is None else f"{v:.1f}"  # noqa: E731
        print(f"{r['run']:>4} | {fmt(r.get('init_ms')):>10} | {fmt(r.get('new_ms')):>8} | "
              f"{fmt(r.get('new_abs_ms')):>10} | {('timeout' if r.get('commands_timeout') else fmt(r.get('commands_ms'))):>11} | {fmt(r.get('list_ms')):>8}")
    print("-" * 72)
    med = report["median"]
    print(f"{'med':>4} | {fmt(med['init_ms']):>10} | {fmt(med['new_ms']):>8} | "
          f"{fmt(med['new_abs_ms']):>10} | {fmt(med['commands_ms']):>11} | {fmt(med['list_ms']):>8}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
