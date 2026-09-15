"""内核包必须提供与 ``python -m harness_agent`` 相同的 console script。"""

from __future__ import annotations

import subprocess
import tomllib
import zipfile
from pathlib import Path

from harness_agent.__main__ import main

AGENT_ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_declares_harness_agent_console_script() -> None:
    pyproject = tomllib.loads((AGENT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["scripts"]["harness-agent"] == "harness_agent.__main__:main"


def test_console_script_target_is_the_same_main() -> None:
    assert callable(main)
    assert main.__name__ == "main"


def test_wheel_declares_harness_agent_script(tmp_path: Path) -> None:
    completed = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path)],
        cwd=AGENT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(tmp_path.glob("za38_agent-*.whl"))
    assert wheels, completed.stdout + completed.stderr
    with zipfile.ZipFile(wheels[0]) as archive:
        entry_name = next(name for name in archive.namelist() if name.endswith("entry_points.txt"))
        text = archive.read(entry_name).decode("utf-8")
    assert "harness-agent" in text
    assert "harness_agent.__main__:main" in "".join(text.split())
