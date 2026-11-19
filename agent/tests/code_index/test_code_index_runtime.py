"""1.1.6 离线 preflight：平台映射、缺包/错版与路径归属。"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from harness_agent.code_index.runtime import (
    CLI_INSTALL_ROOT_ENV,
    NodeCodeIndexRuntime,
    platform_package_name,
    subprocess_spawn_options,
)


def _write_main_package(root: Path, version: str, *, platform: str) -> None:
    name = "@colbymchenry/codegraph"
    package = root / "node_modules" / name
    package.mkdir(parents=True, exist_ok=True)
    (package / "package.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": version,
                "optionalDependencies": {
                    f"@colbymchenry/codegraph-{platform}": version,
                },
            }
        ),
        encoding="utf-8",
    )
    (package / "npm-sdk.js").write_text("module.exports = {}\n", encoding="utf-8")
    (package / "npm-shim.js").write_text("\n", encoding="utf-8")


def _write_platform_package(
    root: Path,
    platform: str,
    version: str,
    *,
    node: bool = True,
    entry: bool = True,
    wasm: bool = True,
) -> None:
    name = f"@colbymchenry/codegraph-{platform}"
    package = root / "node_modules" / name
    package.mkdir(parents=True, exist_ok=True)
    (package / "package.json").write_text(
        json.dumps({"name": name, "version": version}),
        encoding="utf-8",
    )
    if entry:
        entry_path = package / "lib" / "dist" / "bin" / "codegraph.js"
        entry_path.parent.mkdir(parents=True)
        entry_path.write_text("\n", encoding="utf-8")
        (package / "lib" / "dist" / "index.js").write_text("module.exports = {}\n", encoding="utf-8")
    if wasm:
        wasm_path = package / "lib" / "dist" / "extraction" / "wasm" / "tree-sitter-lua.wasm"
        wasm_path.parent.mkdir(parents=True)
        wasm_path.write_bytes(b"wasm")
    if node:
        node_path = package / ("node.exe" if platform.startswith("win32") else "node")
        node_path.write_text("", encoding="utf-8")
        if os.name != "nt":
            node_path.chmod(0o755)


def _layout(tmp_path: Path, *, version: str = "1.1.6", platform: str = "darwin-arm64") -> Path:
    root = tmp_path / "cli"
    root.mkdir(parents=True)
    _write_main_package(root, version, platform=platform)
    _write_platform_package(root, platform, version)
    return root


def test_platform_package_maps_supported_targets() -> None:
    """五个支持 target 解析到精确平台包；musl 与 Windows ARM 明确失败。"""
    assert platform_package_name(system="darwin", machine="arm64") == "@colbymchenry/codegraph-darwin-arm64"
    assert platform_package_name(system="darwin", machine="x86_64") == "@colbymchenry/codegraph-darwin-x64"
    assert platform_package_name(system="linux", machine="x86_64", musl=False) == "@colbymchenry/codegraph-linux-x64"
    assert platform_package_name(system="linux", machine="aarch64", musl=False) == "@colbymchenry/codegraph-linux-arm64"
    assert platform_package_name(system="win32", machine="amd64") == "@colbymchenry/codegraph-win32-x64"
    assert platform_package_name(system="linux", machine="x86_64", musl=True) is None
    assert platform_package_name(system="win32", machine="arm64") is None


def test_subprocess_spawn_options_use_process_groups() -> None:
    """POSIX 新建 session，Windows 使用独立 process group。"""
    assert subprocess_spawn_options(posix=True) == {"start_new_session": True}
    assert subprocess_spawn_options(posix=False) == {"creationflags": 0x00000200}


@pytest.mark.parametrize(
    ("system", "machine", "platform"),
    [
        ("darwin", "arm64", "darwin-arm64"),
        ("darwin", "x86_64", "darwin-x64"),
        ("linux", "x86_64", "linux-x64"),
        ("linux", "aarch64", "linux-arm64"),
        ("win32", "amd64", "win32-x64"),
    ],
)
def test_preflight_accepts_five_supported_platform_layouts(
    tmp_path: Path,
    system: str,
    machine: str,
    platform: str,
) -> None:
    """五个支持 target 的构造布局都能通过离线 preflight。"""
    root = tmp_path / platform / "cli"
    root.mkdir(parents=True)
    _write_main_package(root, "1.1.6", platform=platform)
    _write_platform_package(root, platform, "1.1.6")
    result = NodeCodeIndexRuntime(root).preflight(system=system, machine=machine, musl=False)
    assert result.ok is True
    assert result.error is None


def test_preflight_accepts_matching_116_layout(tmp_path: Path) -> None:
    """主包和平台包都是 1.1.6 且含随包 Node 时通过。"""
    root = _layout(tmp_path)
    result = NodeCodeIndexRuntime(root).preflight(system="darwin", machine="arm64")
    assert result.ok is True
    assert result.error is None


def test_preflight_accepts_space_and_chinese_install_root(tmp_path: Path) -> None:
    """空格和中文安装路径保持可用。"""
    root = tmp_path / "安装 根" / "cli"
    _write_main_package(root, "1.1.6", platform="darwin-arm64")
    _write_platform_package(root, "darwin-arm64", "1.1.6")
    result = NodeCodeIndexRuntime(root).preflight(system="darwin", machine="arm64")
    assert result.ok is True


def test_preflight_rejects_missing_and_mismatched_packages(tmp_path: Path) -> None:
    """缺包、错版、缺文件返回稳定错误，文案不含绝对路径。"""
    missing = NodeCodeIndexRuntime(tmp_path / "empty")
    missing_result = missing.preflight(system="darwin", machine="arm64")
    assert missing_result.ok is False
    assert missing_result.error is not None
    assert missing_result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"
    assert str(tmp_path) not in missing_result.error.message

    mismatched = _layout(tmp_path / "mismatch", version="1.6.0")
    mismatch_result = NodeCodeIndexRuntime(mismatched).preflight(system="darwin", machine="arm64")
    assert mismatch_result.ok is False
    assert mismatch_result.error is not None
    assert mismatch_result.error.code == "CODE_INDEX_VERSION_MISMATCH"

    incomplete = _layout(tmp_path / "incomplete")
    node = incomplete / "node_modules" / "@colbymchenry/codegraph-darwin-arm64" / "node"
    node.unlink()
    incomplete_result = NodeCodeIndexRuntime(incomplete).preflight(system="darwin", machine="arm64")
    assert incomplete_result.ok is False
    assert incomplete_result.error is not None
    assert incomplete_result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"


def test_preflight_rejects_missing_entry_wasm_and_non_executable_node(tmp_path: Path) -> None:
    """平台包缺少编译入口、WASM 或可执行 Node 时失败关闭。"""
    for missing in ("entry", "wasm"):
        root = tmp_path / missing / "cli"
        root.mkdir(parents=True)
        _write_main_package(root, "1.1.6", platform="darwin-arm64")
        _write_platform_package(
            root,
            "darwin-arm64",
            "1.1.6",
            entry=missing != "entry",
            wasm=missing != "wasm",
        )
        result = NodeCodeIndexRuntime(root).preflight(system="darwin", machine="arm64")
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"

    root = _layout(tmp_path / "non-executable")
    node = root / "node_modules" / "@colbymchenry/codegraph-darwin-arm64" / "node"
    node.chmod(0o644)
    result = NodeCodeIndexRuntime(root).preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"


def test_preflight_rejects_malformed_manifest_and_optional_version_skew(tmp_path: Path) -> None:
    """损坏 manifest 与主包 optional dependency 错配都不能越过 preflight。"""
    malformed = _layout(tmp_path / "malformed")
    main_manifest = malformed / "node_modules" / "@colbymchenry/codegraph" / "package.json"
    main_manifest.write_text("{", encoding="utf-8")
    result = NodeCodeIndexRuntime(malformed).preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"

    skewed = _layout(tmp_path / "skewed")
    main_manifest = skewed / "node_modules" / "@colbymchenry/codegraph" / "package.json"
    payload = json.loads(main_manifest.read_text(encoding="utf-8"))
    payload["optionalDependencies"]["@colbymchenry/codegraph-darwin-arm64"] = "1.6.0"
    main_manifest.write_text(json.dumps(payload), encoding="utf-8")
    result = NodeCodeIndexRuntime(skewed).preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_VERSION_MISMATCH"


def test_preflight_rejects_package_symlink_outside_trusted_root(tmp_path: Path) -> None:
    """依赖目录即使文件齐全，解析到可信安装根外也必须拒绝。"""
    external = _layout(tmp_path / "external")
    root = tmp_path / "trusted" / "cli"
    root.mkdir(parents=True)
    (root / "node_modules").symlink_to(external / "node_modules", target_is_directory=True)
    result = NodeCodeIndexRuntime(root).preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_PATH_UNSAFE"


def test_preflight_does_not_use_missing_env_root() -> None:
    """没有内部安装根时失败关闭，不探测系统 Node。"""
    result = NodeCodeIndexRuntime(None).preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"


def test_from_env_rejects_relative_install_root(tmp_path: Path, monkeypatch) -> None:
    """内部安装根必须是 CLI 传入的绝对路径，不能相对 Host 工作目录解析。"""
    _layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(CLI_INSTALL_ROOT_ENV, "cli")
    result = NodeCodeIndexRuntime.from_env().preflight(system="darwin", machine="arm64")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CODE_INDEX_RUNTIME_UNAVAILABLE"


def _write_fake_node(root: Path, body: str) -> None:
    node = root / "node_modules" / "@colbymchenry/codegraph-darwin-arm64" / "node"
    node.write_text(f"#!/usr/bin/env python3\n{body}\n", encoding="utf-8")
    node.chmod(0o755)
    adapter = root / "packages" / "cli" / "src" / "code-index-adapter" / "index.mjs"
    adapter.parent.mkdir(parents=True)
    adapter.write_text("// test adapter placeholder\n", encoding="utf-8")


@pytest.mark.asyncio
async def test_supervisor_accepts_only_valid_jsonl_success(tmp_path: Path) -> None:
    """退出码、结构化成功和合法统计同时成立时才成功。"""
    root = _layout(tmp_path)
    (tmp_path / "workspace").mkdir()
    _write_fake_node(
        root,
        "import json\n"
        "print(json.dumps({'type':'started'}), flush=True)\n"
        "print(json.dumps({'type':'progress','phase':'indexing','completed':2,'total':5}), flush=True)\n"
        "print(json.dumps({'type':'succeeded','stats':{'files':5,'symbols':8,'relationships':3,'db_bytes':40,'wal_bytes':0}}), flush=True)",
    )
    progress: list[dict[str, object]] = []
    result = await NodeCodeIndexRuntime(root).run_index(
        tmp_path / "workspace",
        on_progress=progress.append,
        system="darwin",
        machine="arm64",
    )
    assert result.success is True
    assert result.stats == {"files": 5, "symbols": 8, "relationships": 3, "db_bytes": 40, "wal_bytes": 0}
    assert progress == [{"phase": "indexing", "completed": 2, "total": 5}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "timeout"),
    [
        ("print('not-json', flush=True)", 1.0),
        ("import json,sys\nprint(json.dumps({'type':'succeeded','stats':{}}), flush=True)\nsys.exit(1)", 1.0),
        ("import time\ntime.sleep(5)", 0.05),
    ],
)
async def test_supervisor_fails_closed_on_malformed_nonzero_and_timeout(
    tmp_path: Path,
    body: str,
    timeout: float,
) -> None:
    root = _layout(tmp_path)
    (tmp_path / "workspace").mkdir()
    _write_fake_node(root, body)
    result = await NodeCodeIndexRuntime(root).run_index(
        tmp_path / "workspace",
        on_progress=lambda _progress: None,
        timeout=timeout,
        system="darwin",
        machine="arm64",
    )
    assert result.success is False
    assert result.stats is None
    assert result.error is not None
    assert "CodeGraph" not in result.error.message
    assert str(tmp_path) not in result.error.message


@pytest.mark.asyncio
async def test_supervisor_does_not_treat_unvalidated_terminal_as_success(tmp_path: Path) -> None:
    root = _layout(tmp_path)
    (tmp_path / "workspace").mkdir()
    _write_fake_node(
        root,
        "import json\nprint(json.dumps({'type':'succeeded','stats':{'files':-1,'symbols':0,'relationships':0,'db_bytes':0,'wal_bytes':0}}), flush=True)",
    )
    result = await NodeCodeIndexRuntime(root).run_index(
        tmp_path / "workspace",
        on_progress=lambda _progress: None,
        system="darwin",
        machine="arm64",
    )
    assert result.success is False


@pytest.mark.asyncio
async def test_supervisor_cancellation_terminates_child(tmp_path: Path) -> None:
    """取消协程必须回收进程组，不能让子进程在后台继续写入。"""
    root = _layout(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    marker = tmp_path / "leaked-child"
    _write_fake_node(
        root,
        "import pathlib,time\n"
        "time.sleep(0.2)\n"
        f"pathlib.Path({str(marker)!r}).write_text('leaked')",
    )
    task = asyncio.create_task(
        NodeCodeIndexRuntime(root).run_index(
            workspace,
            on_progress=lambda _progress: None,
            system="darwin",
            machine="arm64",
        )
    )
    await asyncio.sleep(0.03)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.25)
    assert not marker.exists()


@pytest.mark.asyncio
async def test_supervisor_serve_explore_round_trip(tmp_path: Path) -> None:
    """生产 supervisor 通过 JSONL 完成 ready 与 explore，结果不含供应商名。"""
    root = _layout(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_fake_node(
        root,
        "import json,sys\n"
        "print(json.dumps({'type':'ready','watcher':'ready'}), flush=True)\n"
        "line=sys.stdin.readline()\n"
        "req=json.loads(line)\n"
        "print(json.dumps({'type':'result','id':req['id'],'text':'hit UNIQUE_MARK'}), flush=True)\n"
        "sys.stdin.readline()\n",
    )
    runtime = NodeCodeIndexRuntime(root)
    session = await runtime.start_query(workspace, system="darwin", machine="arm64")
    assert session.watcher_status == "ready"
    text = await runtime.explore("UNIQUE_MARK", 3)
    assert text == "hit UNIQUE_MARK"
    assert "CodeGraph" not in text
    await runtime.stop_query()
    await runtime.stop_query()


@pytest.mark.asyncio
async def test_run_index_argv_uses_bundled_node_liftoff_and_offline_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """随包 Node 以 argv 数组启动 adapter，并强制离线/无 daemon。"""
    root = _layout(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    log_path = tmp_path / "argv.json"
    monkeypatch.setenv("HARNESS_ARGV_LOG", str(log_path))
    _write_fake_node(
        root,
        "import json,os,sys\n"
        "open(os.environ['HARNESS_ARGV_LOG'],'w',encoding='utf-8').write(json.dumps({"
        "'argv':sys.argv,"
        "'env':{key:os.environ.get(key) for key in ("
        "'CODEGRAPH_DIR','CODEGRAPH_NO_DAEMON','CODEGRAPH_NO_DOWNLOAD','DO_NOT_TRACK','CODEGRAPH_TELEMETRY')"
        "}}))\n"
        "print(json.dumps({'type':'started'}), flush=True)\n"
        "print(json.dumps({'type':'succeeded','stats':{'files':1,'symbols':1,'relationships':0,'db_bytes':8,'wal_bytes':0}}), flush=True)",
    )
    result = await NodeCodeIndexRuntime(root).run_index(
        workspace,
        on_progress=lambda _progress: None,
        system="darwin",
        machine="arm64",
    )
    assert result.success is True
    payload = json.loads(log_path.read_text(encoding="utf-8"))
    argv = payload["argv"]
    assert "--liftoff-only" in argv
    assert "initialize" in argv
    assert "--workspace" in argv
    assert argv[argv.index("--workspace") + 1] == str(workspace.resolve())
    assert payload["env"] == {
        "CODEGRAPH_DIR": ".harness-index",
        "CODEGRAPH_NO_DAEMON": "1",
        "CODEGRAPH_NO_DOWNLOAD": "1",
        "DO_NOT_TRACK": "1",
        "CODEGRAPH_TELEMETRY": "0",
    }


def test_current_install_root_116_layout_passes_preflight() -> None:
    """当前仓库安装的 1.1.6 主包与平台包通过离线 preflight；许可证仅记录 package.json 的 MIT。"""
    repo = Path(__file__).resolve().parents[4]
    main = repo / "node_modules" / "@colbymchenry" / "codegraph" / "package.json"
    platform = repo / "node_modules" / "@colbymchenry" / "codegraph-darwin-arm64" / "package.json"
    if not main.is_file() or not platform.is_file():
        pytest.skip("local 1.1.6 packages are not installed")
    main_manifest = json.loads(main.read_text(encoding="utf-8"))
    platform_manifest = json.loads(platform.read_text(encoding="utf-8"))
    assert main_manifest["name"] == "@colbymchenry/codegraph"
    assert main_manifest["version"] == "1.1.6"
    assert main_manifest["license"] == "MIT"
    assert not (main.parent / "LICENSE").exists()
    assert platform_manifest["version"] == "1.1.6"
    result = NodeCodeIndexRuntime(repo).preflight()
    assert result.ok is True
    assert result.error is None
