"""代码索引运行时：按 OS/arch 解析 1.1.6 包布局，不访问网络或系统 Node。"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import platform
import signal
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable

from harness_agent.code_index.models import (
    DATA_DIRECTORY,
    ENGINE_VERSION,
    CodeIndexBuildResult,
    CodeIndexPreflight,
    CodeIndexQuerySession,
    error_for,
)

CLI_INSTALL_ROOT_ENV = "HARNESS_CLI_INSTALL_ROOT"
MAIN_PACKAGE = "@colbymchenry/codegraph"

_SUPPORTED_TARGETS: dict[tuple[str, str], str] = {
    ("darwin", "arm64"): "darwin-arm64",
    ("darwin", "x86_64"): "darwin-x64",
    ("darwin", "amd64"): "darwin-x64",
    ("linux", "x86_64"): "linux-x64",
    ("linux", "amd64"): "linux-x64",
    ("linux", "aarch64"): "linux-arm64",
    ("linux", "arm64"): "linux-arm64",
    ("win32", "amd64"): "win32-x64",
    ("win32", "x86_64"): "win32-x64",
}
_MAX_STDOUT_LINE = 64 * 1024
_MAX_STDERR = 16 * 1024
_STAT_FIELDS = {"files", "symbols", "relationships", "db_bytes", "wal_bytes"}


def subprocess_spawn_options(*, posix: bool | None = None) -> dict[str, object]:
    """为受管 Node 进程创建独立进程组，取消时可以整组回收。"""
    if (os.name != "nt") if posix is None else posix:
        return {"start_new_session": True}
    return {"creationflags": 0x00000200}  # CREATE_NEW_PROCESS_GROUP


@dataclass(frozen=True, slots=True)
class _RuntimePaths:
    node: Path
    adapter: Path


def detect_musl() -> bool:
    """用动态链接器路径判断 musl；不把探测失败当成已支持。"""
    return any(
        Path(candidate).exists()
        for candidate in (
            "/lib/ld-musl-x86_64.so.1",
            "/lib/ld-musl-aarch64.so.1",
        )
    )


def platform_package_name(
    *,
    system: str | None = None,
    machine: str | None = None,
    musl: bool | None = None,
) -> str | None:
    """把当前 OS/arch 映射到精确平台包名；不支持的目标返回 None。"""
    os_name = (system or sys.platform).lower()
    cpu = (machine or platform.machine()).lower()
    if os_name.startswith("linux") and (musl if musl is not None else detect_musl()):
        return None
    if os_name.startswith("win") and cpu in {"arm64", "aarch64"}:
        return None
    target = _SUPPORTED_TARGETS.get((os_name, cpu))
    if target is None:
        return None
    return f"{MAIN_PACKAGE}-{target}"


class NodeCodeIndexRuntime:
    """生产 adapter：只读取 CLI 安装根下的精确 1.1.6 包，不执行索引。"""

    def __init__(self, install_root: Path | None) -> None:
        self._install_root = install_root

    @classmethod
    def from_env(cls) -> NodeCodeIndexRuntime:
        """仅在实验功能开启后由 Host 调用；缺省环境视为运行时不可用。"""
        raw = os.environ.get(CLI_INSTALL_ROOT_ENV, "").strip()
        if not raw:
            return cls(None)
        candidate = Path(raw)
        if not candidate.is_absolute():
            return cls(None)
        try:
            return cls(candidate.resolve(strict=True))
        except OSError:
            return cls(None)

    def preflight(
        self,
        *,
        system: str | None = None,
        machine: str | None = None,
        musl: bool | None = None,
    ) -> CodeIndexPreflight:
        """校验主包/平台包版本、随包 Node 与路径归属。"""
        if self._install_root is None or not self._install_root.is_dir():
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))
        package_name = platform_package_name(system=system, machine=machine, musl=musl)
        if package_name is None:
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))
        try:
            main_dir = self._contained_package(MAIN_PACKAGE)
            platform_dir = self._contained_package(package_name)
            main_manifest = self._package_manifest(main_dir, MAIN_PACKAGE)
            platform_manifest = self._package_manifest(platform_dir, package_name)
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError, TypeError, OSError):
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))
        except ValueError:
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_PATH_UNSAFE"))
        main_version = main_manifest.get("version")
        platform_version = platform_manifest.get("version")
        if main_version != ENGINE_VERSION or platform_version != ENGINE_VERSION:
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_VERSION_MISMATCH"))
        optional_dependencies = main_manifest.get("optionalDependencies")
        if (
            not isinstance(optional_dependencies, dict)
            or optional_dependencies.get(package_name) != ENGINE_VERSION
        ):
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_VERSION_MISMATCH"))
        node_name = "node.exe" if (system or sys.platform).lower().startswith("win") else "node"
        node_path = platform_dir / node_name
        library_entry = platform_dir / "lib" / "dist" / "index.js"
        cli_entry = platform_dir / "lib" / "dist" / "bin" / "codegraph.js"
        wasm_dir = platform_dir / "lib" / "dist" / "extraction" / "wasm"
        main_files = (main_dir / "npm-sdk.js", main_dir / "npm-shim.js")
        required_files = (node_path, library_entry, cli_entry, *main_files)
        if (
            not all(path.is_file() for path in required_files)
            or not wasm_dir.is_dir()
            or not any(path.is_file() and path.suffix == ".wasm" for path in wasm_dir.iterdir())
            or (node_name == "node" and not os.access(node_path, os.X_OK))
        ):
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))
        if not all(self._is_contained(path) for path in (*required_files, wasm_dir)):
            return CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_PATH_UNSAFE"))
        return CodeIndexPreflight(ok=True)

    async def run_index(
        self,
        workspace: Path,
        *,
        operation: str = "initialize",
        on_progress: Callable[[dict[str, object]], Awaitable[None] | None],
        timeout: float = 1800.0,
        system: str | None = None,
        machine: str | None = None,
        musl: bool | None = None,
    ) -> CodeIndexBuildResult:
        """监督随包 Node 的首建、增量或重建，任何协议或进程异常都失败关闭。"""
        if operation not in {"initialize", "sync", "rebuild"}:
            return CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE"))
        preflight = self.preflight(system=system, machine=machine, musl=musl)
        if not preflight.ok:
            return CodeIndexBuildResult(success=False, error=preflight.error)
        try:
            resolved_workspace = workspace.resolve(strict=True)
            if not resolved_workspace.is_dir():
                raise OSError("workspace is not a directory")
            paths = self._runtime_paths(system=system, machine=machine, musl=musl)
        except (OSError, ValueError, FileNotFoundError):
            return CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))

        environment = dict(os.environ)
        environment.update(
            {
                "CODEGRAPH_DIR": DATA_DIRECTORY,
                "CODEGRAPH_NO_DAEMON": "1",
                "CODEGRAPH_NO_DOWNLOAD": "1",
                "DO_NOT_TRACK": "1",
                "CODEGRAPH_TELEMETRY": "0",
            }
        )
        spawn_options = subprocess_spawn_options()
        try:
            process = await asyncio.create_subprocess_exec(
                str(paths.node),
                "--liftoff-only",
                str(paths.adapter),
                operation,
                "--workspace",
                str(resolved_workspace),
                cwd=resolved_workspace,
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **spawn_options,
            )
        except OSError:
            return CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))

        events: list[dict[str, object]] = []
        malformed = False
        stderr = bytearray()

        async def consume_stdout() -> None:
            nonlocal malformed
            assert process.stdout is not None
            while line := await process.stdout.readline():
                if len(line) > _MAX_STDOUT_LINE:
                    malformed = True
                    continue
                try:
                    value = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    malformed = True
                    continue
                if not isinstance(value, dict):
                    malformed = True
                    continue
                events.append(value)
                if value.get("type") == "progress":
                    progress = self._validated_progress(value)
                    if progress is None:
                        malformed = True
                        continue
                    callback_result = on_progress(progress)
                    if inspect.isawaitable(callback_result):
                        await callback_result

        async def consume_stderr() -> None:
            assert process.stderr is not None
            while chunk := await process.stderr.read(4096):
                remaining = _MAX_STDERR - len(stderr)
                if remaining > 0:
                    stderr.extend(chunk[:remaining])

        stdout_task = asyncio.create_task(consume_stdout())
        stderr_task = asyncio.create_task(consume_stderr())
        timed_out = False
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except TimeoutError:
            timed_out = True
            await self._terminate_process(process)
        except asyncio.CancelledError:
            await self._terminate_process(process)
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            raise
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        terminal = [event for event in events if event.get("type") in {"succeeded", "failed"}]
        started = sum(event.get("type") == "started" for event in events) == 1
        if timed_out or malformed or process.returncode != 0 or not started or len(terminal) != 1:
            return CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE"))
        final = terminal[0]
        stats = self._validated_stats(final.get("stats")) if final.get("type") == "succeeded" else None
        if stats is None:
            return CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE"))
        return CodeIndexBuildResult(success=True, stats=stats)

    async def start_query(
        self,
        workspace: Path,
        *,
        system: str | None = None,
        machine: str | None = None,
        musl: bool | None = None,
    ) -> CodeIndexQuerySession:
        """启动 adapter serve；stdout 只接受 Harness JSONL，不接入用户 MCP。"""
        await self.stop_query()
        preflight = self.preflight(system=system, machine=machine, musl=musl)
        if not preflight.ok:
            raise RuntimeError(preflight.error.code if preflight.error else "CODE_INDEX_RUNTIME_UNAVAILABLE")
        try:
            resolved_workspace = workspace.resolve(strict=True)
            paths = self._runtime_paths(system=system, machine=machine, musl=musl)
        except (OSError, ValueError, FileNotFoundError) as exc:
            raise RuntimeError("CODE_INDEX_RUNTIME_UNAVAILABLE") from exc
        environment = dict(os.environ)
        environment.update(
            {
                "CODEGRAPH_DIR": DATA_DIRECTORY,
                "CODEGRAPH_NO_DAEMON": "1",
                "CODEGRAPH_NO_DOWNLOAD": "1",
                "DO_NOT_TRACK": "1",
                "CODEGRAPH_TELEMETRY": "0",
                "CODEGRAPH_MCP_TOOLS": "codegraph_explore",
            }
        )
        spawn_options = subprocess_spawn_options()
        process = await asyncio.create_subprocess_exec(
            str(paths.node),
            "--liftoff-only",
            str(paths.adapter),
            "serve",
            "--workspace",
            str(resolved_workspace),
            cwd=resolved_workspace,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **spawn_options,
        )
        self._query_process = process
        self._query_results: dict[str, asyncio.Future[str]] = {}
        self._query_ready = asyncio.Event()
        self._query_watcher = "failed"
        self._query_malformed = False
        self._query_reader = asyncio.create_task(self._consume_query_stdout(process))
        self._query_stderr = asyncio.create_task(self._drain_query_stderr(process))
        try:
            await asyncio.wait_for(self._query_ready.wait(), timeout=15.0)
        except TimeoutError as exc:
            await self.stop_query()
            raise RuntimeError("CODE_INDEX_INCOMPLETE") from exc
        if self._query_malformed or process.returncode is not None:
            await self.stop_query()
            raise RuntimeError("CODE_INDEX_INCOMPLETE")
        status = self._query_watcher if self._query_watcher in {"ready", "degraded", "failed"} else "failed"
        return CodeIndexQuerySession(watcher_status=status)

    async def stop_query(self) -> None:
        """幂等终止 serve 进程组。"""
        process = getattr(self, "_query_process", None)
        reader = getattr(self, "_query_reader", None)
        stderr_task = getattr(self, "_query_stderr", None)
        self._query_process = None
        self._query_reader = None
        self._query_stderr = None
        for task in (reader, stderr_task):
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in (reader, stderr_task) if task is not None), return_exceptions=True)
        if process is not None:
            await self._terminate_process(process)
        pending = getattr(self, "_query_results", {})
        self._query_results = {}
        for future in pending.values():
            if not future.done():
                future.set_exception(RuntimeError("CODE_INDEX_INCOMPLETE"))

    async def explore(self, query: str, max_files: int) -> str:
        """向 serve 进程发送一次探索请求并等待结构化结果。"""
        process = getattr(self, "_query_process", None)
        if process is None or process.stdin is None or process.returncode is not None:
            raise RuntimeError("CODE_INDEX_INCOMPLETE")
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        self._query_results[request_id] = future
        payload = json.dumps(
            {"type": "explore", "id": request_id, "query": query, "max_files": max_files},
            ensure_ascii=False,
        )
        process.stdin.write((payload + "\n").encode("utf-8"))
        await process.stdin.drain()
        try:
            return await asyncio.wait_for(future, timeout=30.0)
        except (TimeoutError, RuntimeError) as exc:
            self._query_results.pop(request_id, None)
            raise RuntimeError("CODE_INDEX_INCOMPLETE") from exc

    async def _consume_query_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout is not None
        while line := await process.stdout.readline():
            if len(line) > _MAX_STDOUT_LINE:
                self._query_malformed = True
                continue
            try:
                value = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._query_malformed = True
                continue
            if not isinstance(value, dict):
                self._query_malformed = True
                continue
            event_type = value.get("type")
            if event_type == "ready":
                watcher = value.get("watcher", "failed")
                self._query_watcher = watcher if watcher in {"ready", "degraded", "failed"} else "failed"
                self._query_ready.set()
                continue
            if event_type == "result":
                request_id = value.get("id")
                text = value.get("text")
                future = self._query_results.pop(request_id, None) if isinstance(request_id, str) else None
                if future is not None and not future.done() and isinstance(text, str):
                    future.set_result(text)
                else:
                    self._query_malformed = True

    async def _drain_query_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr is not None
        leftover = bytearray()
        while chunk := await process.stderr.read(4096):
            remaining = _MAX_STDERR - len(leftover)
            if remaining > 0:
                leftover.extend(chunk[:remaining])

    def _runtime_paths(
        self,
        *,
        system: str | None,
        machine: str | None,
        musl: bool | None,
    ) -> _RuntimePaths:
        package_name = platform_package_name(system=system, machine=machine, musl=musl)
        if package_name is None:
            raise FileNotFoundError("platform")
        platform_dir = self._contained_package(package_name)
        node_name = "node.exe" if (system or sys.platform).lower().startswith("win") else "node"
        node = platform_dir / node_name
        root = self._install_root
        assert root is not None
        candidates = (
            root / "packages" / "cli" / "dist" / "code-index-adapter" / "index.mjs",
            root / "packages" / "cli" / "src" / "code-index-adapter" / "index.mjs",
            root / "node_modules" / "@za38" / "cli" / "dist" / "code-index-adapter" / "index.mjs",
        )
        adapter = next((candidate for candidate in candidates if candidate.is_file()), None)
        if adapter is None or not self._is_contained(adapter) or not self._is_contained(node):
            raise FileNotFoundError("adapter")
        return _RuntimePaths(node=node, adapter=adapter)

    @staticmethod
    def _validated_progress(value: dict[str, object]) -> dict[str, object] | None:
        if set(value) - {"type", "phase", "completed", "total"}:
            return None
        phase = value.get("phase")
        completed = value.get("completed")
        total = value.get("total")
        if phase not in {"indexing", "resolving"} or type(completed) is not int or completed < 0:
            return None
        progress: dict[str, object] = {"phase": phase, "completed": completed}
        if total is not None:
            if type(total) is not int or total < completed:
                return None
            progress["total"] = total
        return progress

    @staticmethod
    def _validated_stats(value: object) -> dict[str, int] | None:
        if not isinstance(value, dict) or set(value) != _STAT_FIELDS:
            return None
        if not all(type(item) is int and item >= 0 for item in value.values()):
            return None
        return {field: value[field] for field in _STAT_FIELDS}

    @staticmethod
    async def _terminate_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            if os.name == "nt":
                process.terminate()
            else:
                os.killpg(process.pid, signal.SIGTERM)
            await asyncio.wait_for(process.wait(), timeout=0.5)
            return
        except (OSError, ProcessLookupError, TimeoutError):
            pass
        if process.returncode is None:
            try:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            await process.wait()

    def _contained_package(self, name: str) -> Path:
        root = self._install_root
        assert root is not None
        package = (root / "node_modules" / name).resolve()
        if not self._is_contained(package):
            raise ValueError("package escapes install root")
        if not package.is_dir():
            raise FileNotFoundError(name)
        return package

    def _package_manifest(self, package_dir: Path, expected_name: str) -> dict[str, object]:
        """读取并校验包身份；损坏 manifest 由调用方收敛为运行时不可用。"""
        manifest = package_dir / "package.json"
        if not manifest.is_file():
            raise FileNotFoundError("package.json")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or payload.get("name") != expected_name:
            raise TypeError("package identity")
        return payload

    def _is_contained(self, path: Path) -> bool:
        root = self._install_root
        if root is None:
            return False
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            return False
        return True


class FakeCodeIndexRuntime:
    """测试用进程内 runtime，不触碰文件系统或用户 MCP catalog。"""

    def __init__(
        self,
        preflight_result: CodeIndexPreflight | None = None,
        *,
        explore_text: str = "定位到 UNIQUE_MARK",
        start_query_error: BaseException | None = None,
        explore_error: BaseException | None = None,
        watcher_status: str = "ready",
    ) -> None:
        self.preflight_result = preflight_result or CodeIndexPreflight(ok=True)
        self.preflight_calls = 0
        self.start_query_calls = 0
        self.stop_query_calls = 0
        self.explore_calls: list[tuple[str, int]] = []
        self.query_started = False
        self.explore_text = explore_text
        self.start_query_error = start_query_error
        self.explore_error = explore_error
        self.watcher_status = watcher_status

    def preflight(self) -> CodeIndexPreflight:
        self.preflight_calls += 1
        return self.preflight_result

    async def run_index(
        self,
        workspace: Path,
        *,
        operation: str = "initialize",
        on_progress: Callable[[dict[str, object]], Awaitable[None] | None],
        timeout: float = 1800.0,
    ) -> CodeIndexBuildResult:
        callback = on_progress({"phase": "indexing", "completed": 1})
        if inspect.isawaitable(callback):
            await callback
        return CodeIndexBuildResult(
            success=True,
            stats={"files": 1, "symbols": 2, "relationships": 1, "db_bytes": 8, "wal_bytes": 0},
        )

    async def start_query(self, workspace: Path) -> CodeIndexQuerySession:
        self.start_query_calls += 1
        if self.start_query_error is not None:
            raise self.start_query_error
        self.query_started = True
        status = self.watcher_status if self.watcher_status in {"ready", "degraded", "failed"} else "failed"
        return CodeIndexQuerySession(watcher_status=status)

    async def stop_query(self) -> None:
        self.stop_query_calls += 1
        self.query_started = False

    async def explore(self, query: str, max_files: int) -> str:
        self.explore_calls.append((query, max_files))
        if not self.query_started:
            raise RuntimeError("query session is not started")
        if self.explore_error is not None:
            raise self.explore_error
        return self.explore_text
