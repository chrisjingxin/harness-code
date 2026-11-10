"""acp_replay_probe 冒烟：小线程能跑通且输出条数与耗时字段。"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_replay_probe_smoke() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/acp_replay_probe.py", "--messages", "50",
         "--runs", "1", "--json"],
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-500:]
    (row,) = json.loads(proc.stdout)
    assert row["load_ms"] is not None and row["load_ms"] >= 0
    assert row["updates"] > 0
