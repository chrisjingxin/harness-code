"""内核包必须提供与 ``python -m harness_agent`` 相同的 console script。"""

from __future__ import annotations

import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

import pytest

from harness_agent.__main__ import UsageError, main

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


def test_select_mode_defaults_to_v3_for_every_other_argument() -> None:
    """无参数与既有参数都走 v3：现状是忽略所有 argv，不能因为新增 acp 改变它。"""
    from harness_agent.__main__ import _select_mode

    assert _select_mode([]) == "v3"
    assert _select_mode(["--version"]) == "v3"
    assert _select_mode(["--help"]) == "v3"
    assert _select_mode(["--config", "custom.toml"]) == "v3"


def test_select_mode_accepts_only_bare_acp() -> None:
    """只有恰好一个 `acp` 参数才进入 ACP 模式。"""
    from harness_agent.__main__ import _select_mode

    assert _select_mode(["acp"]) == "acp"


def test_select_mode_rejects_extra_acp_arguments() -> None:
    """`acp` 带多余参数是用法错误：错参数绝不能污染协议流。"""
    from harness_agent.__main__ import _select_mode

    with pytest.raises(UsageError):
        _select_mode(["acp", "--cwd", "somewhere"])


def test_v3_path_does_not_import_acp_module() -> None:
    """v3 路径运行期不得加载 ACP SDK：缺包环境也必须能正常起 Host。"""
    script = (
        "import sys\n"
        "from harness_agent.__main__ import _select_mode\n"
        "assert _select_mode([]) == 'v3'\n"
        "assert 'acp' not in sys.modules, sorted(m for m in sys.modules if m.startswith('acp'))\n"
        "assert 'harness_agent.host.acp' not in sys.modules\n"
        "print('ok')\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "ok" in completed.stdout


def test_main_claims_protocol_fds_before_running_the_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACP 模式下 `claim_protocol_fds()` 必须先于事件循环与日志初始化执行。"""
    import harness_agent.__main__ as entry
    from harness_agent.host.acp import stdio

    calls: list[str] = []
    claimed = stdio.ProtocolFds(reader=11, writer=12)

    def fake_claim() -> stdio.ProtocolFds:
        calls.append("claim")
        return claimed

    async def fake_run(mode: str = "v3", fds: object = None) -> int:
        calls.append(f"run:{mode}")
        assert fds is claimed
        return 0

    monkeypatch.setattr(entry.sys, "argv", ["harness-agent", "acp"])
    monkeypatch.setattr(stdio, "claim_protocol_fds", fake_claim)
    monkeypatch.setattr(entry, "_run", fake_run)

    entry.main()

    assert calls == ["claim", "run:acp"]


def test_main_exits_two_when_stdio_claim_fails(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """启动阶段失败（stdout 不是管道等）必须明确报错并以 2 退出。"""
    import harness_agent.__main__ as entry
    from harness_agent.host.acp import stdio

    def fail() -> stdio.ProtocolFds:
        raise stdio.StdioStartupError("stdout must be a pipe, socket or tty")

    async def never(*_args: object, **_kwargs: object) -> int:
        raise AssertionError("event loop must not start when startup fails")

    monkeypatch.setattr(entry.sys, "argv", ["harness-agent", "acp"])
    monkeypatch.setattr(stdio, "claim_protocol_fds", fail)
    monkeypatch.setattr(entry, "_run", never)

    with pytest.raises(SystemExit) as exit_info:
        entry.main()

    assert exit_info.value.code == 2
    captured = capsys.readouterr()
    assert "stdout must be a pipe, socket or tty" in captured.err


def test_main_exits_two_for_acp_usage_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """`acp` 后跟多余参数时给用法提示并以 2 退出。"""
    import harness_agent.__main__ as entry

    monkeypatch.setattr(entry.sys, "argv", ["harness-agent", "acp", "--cwd", "somewhere"])

    with pytest.raises(SystemExit) as exit_info:
        entry.main()

    assert exit_info.value.code == 2
    assert "Usage" in capsys.readouterr().err
