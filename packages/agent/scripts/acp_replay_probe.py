"""ACP session/load 回放耗时测量（Todo 2.10，Spec §12.3 目标 ≤ 1.5s）。

播种一个有 N 条消息的线程（user/assistant/tool 混合，tool 带
tool_call_id/arguments/status），子进程跑 `python -m harness_agent acp`，
initialize → session/load，计 load 请求发出→响应到达的耗时与 update 条数。

  .venv/bin/python scripts/acp_replay_probe.py [--messages N] [--runs N] [--json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from acp_startup_probe import _probe_binding, read_frames, spawn_agent  # noqa: E402

RUN_DEADLINE_S = 60.0


async def _seed_thread(workspace: Path, home: Path, count: int) -> str:
    """播一条 N 消息线程：每 3 条一组（assistant 带 tool_calls → tool → user）。"""
    from harness_agent.threads.thread_persistence import AcceptRun, ThreadPersistence
    from harness_agent.threads.thread_records import TranscriptAppend

    thread_id = "probe-replay-00001"
    store = await ThreadPersistence.open(project=workspace, home=home)
    try:
        await store.accept_run(
            AcceptRun(message="seed", binding=_probe_binding(thread_id, "probe-run-1", 0))
        )
        for i in range(count):
            kind = ("assistant", "tool", "user")[i % 3]
            if kind == "assistant":
                await store.append_transcript(TranscriptAppend(
                    thread_id=thread_id, record_id=f"a{i}", kind="assistant",
                    content=f"正文 {i}", run_id="probe-run-1",
                    tool_calls=({"id": f"c{i}", "name": "execute",
                                 "args": {"command": f"cmd {i}"}},),
                ))
            elif kind == "tool":
                await store.append_transcript(TranscriptAppend(
                    thread_id=thread_id, record_id=f"t{i}", kind="tool",
                    content=f"输出 {i}", run_id="probe-run-1",
                    tool_call_id=f"c{i-1}", tool_name="execute",
                    tool_status="error" if i % 7 == 0 else "success",
                ))
            else:
                await store.append_transcript(TranscriptAppend(
                    thread_id=thread_id, record_id=f"u{i}", kind="user",
                    content=f"提问 {i}", run_id="probe-run-1",
                ))
    finally:
        await store.close()
    return thread_id


def _send(proc, frame) -> float:
    payload = (json.dumps(frame) + "\n").encode()
    sent = time.monotonic() * 1000  # 与 read_frames 的 at_ms 同单位（ms）
    proc.stdin.write(payload)
    proc.stdin.flush()
    return sent


def measure_once(index: int, *, messages: int, tmp_root: Path) -> dict:
    """一次：播种 → spawn → initialize → session/load → 计时与统计。"""
    workspace = Path(tempfile.mkdtemp(prefix=f"replay-ws{index}-", dir=tmp_root))
    home = Path(tempfile.mkdtemp(prefix=f"replay-home{index}-", dir=tmp_root))
    thread_id = asyncio.run(_seed_thread(workspace, home, messages))
    proc = spawn_agent(workspace, home)
    updates = 0
    try:
        _send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": 1, "clientCapabilities": {}}})
        carry: dict[str, bytes] = {}
        frames, _ = read_frames(proc, time.monotonic() + RUN_DEADLINE_S,
                                stop=lambda f: f.get("id") == 1, carry=carry)
        sent = _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "session/load",
                            "params": {"sessionId": thread_id, "cwd": str(workspace),
                                       "mcpServers": []}})
        frames, _ = read_frames(proc, sent + RUN_DEADLINE_S,
                                stop=lambda f: f.get("id") == 2, carry=carry)
        t_resp = next((ms for ms, f in frames if f.get("id") == 2), None)
        updates = sum(
            1 for _, f in frames
            if f.get("method") == "session/update"
            and f.get("params", {}).get("sessionId") == thread_id
        )
        return {"run": index, "load_ms": None if t_resp is None else t_resp - sent,
                "updates": updates}
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--messages", type=int, default=5000)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    tmp_root = Path(tempfile.mkdtemp(prefix="acp-replay-probe-"))
    results = [measure_once(i + 1, messages=args.messages, tmp_root=tmp_root)
               for i in range(args.runs)]
    if args.json:
        print(json.dumps(results, ensure_ascii=False))
        return 0
    print(f"{'run':>4} | {'load_ms':>10} | {'updates':>8}")
    for r in results:
        print(f"{r['run']:>4} | {r['load_ms'] if r['load_ms'] is not None else 'null':>10} | {r['updates']:>8}")
    meds = statistics.median(r["load_ms"] for r in results if r["load_ms"] is not None)
    print(f"{'med':>4} | {meds:>10.1f} |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
