"""scripts/acp_startup_probe.py 冒烟测试：脚本能跑通一轮并输出四段字段。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1]
SCRIPT = AGENT_DIR / "scripts" / "acp_startup_probe.py"


def test_probe_runs_one_round_and_reports_four_metrics() -> None:
    """`--runs 1 --home temp --seed-threads 3 --json` 退出码 0 且四段字段齐全。"""
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--runs",
            "1",
            "--home",
            "temp",
            "--seed-threads",
            "3",
            "--json",
        ],
        cwd=AGENT_DIR,
        capture_output=True,
        text=True,
        timeout=120,
        env=dict(os.environ),
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    report = json.loads(completed.stdout)
    assert report["runs"], "应至少有一条测量记录"
    run = report["runs"][0]
    for key in ("init_ms", "new_ms", "new_abs_ms", "commands_ms", "list_ms"):
        assert key in run, f"缺字段 {key}"
    # 脚本对子进程固定走非 echo 路径（spawn 时会剥掉 HARNESS_ECHO_MODE），
    # 所以 init/new/list 都应是真实数值。
    assert run["init_ms"] is not None
    assert run["new_ms"] is not None
    # 服务端 session/new 后必推一次 available_commands_update（含空表），探针必须测到。
    assert run["commands_ms"] is not None
    assert "median" in report
