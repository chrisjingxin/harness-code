"""Python Agent 后台核心服务启动入口（``python -m harness_agent``）。

【这是做什么的？】
当用户在命令行执行 za38 时，前端 CLI 会自动在子进程中拉起本入口。
本模块负责初始化本地诊断日志、读取项目配置文件，并启动 AgentHost 主服务，
通过标准输入输出（stdio）持续监听来自前端 CLI 的 JSON-RPC 请求并进行调度处理。

同一个入口还有第二种模式：`harness acp` 传入唯一的 `acp` 参数，此时把
stdout 变成标准 ACP 协议通道（见 `host/acp/`）。两种模式共用一套日志初始化，
但 ACP 分支才惰性导入 ACP SDK——v3 路径运行期不会加载它。

【分派规则】
    argv == ["acp"]        → ACP 模式
    argv[0] == "acp" 且更多 → 用法错误，退出码 2
    其它（含无参数）        → v3 模式（与改造前一致：忽略所有 argv）
"""

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

from harness_agent.config.config import ConfigError, DiagnosticsSettings, load_config
from harness_agent.diagnostic_log.runtime import (
    DiagnosticSettings,
    create_diagnostic_log,
    default_process_fields,
)
from harness_agent.diagnostic_log.stdlib import install_harness_stdlib_handler
from harness_agent.host.agent_host import AgentHost
from harness_agent.threads.thread_persistence import workspace_fingerprint

if TYPE_CHECKING:
    from harness_agent.host.acp.stdio import ProtocolFds

ACP_USAGE = "Usage: harness acp"
"""ACP 模式的用法提示；`acp` 不接受任何额外参数。"""


class UsageError(Exception):
    """命令行用法错误；调用方据此打印提示并以退出码 2 结束。"""


def _select_mode(argv: list[str]) -> str:
    """按 argv 选择运行模式：`acp` 或 `v3`。

    输入：`sys.argv[1:]`。
    输出：`"acp"` / `"v3"`。
    异常：`UsageError`——`acp` 后跟任何多余参数（错参数绝不能污染协议流）。
    """
    if not argv or argv[0] != "acp":
        return "v3"
    if len(argv) > 1:
        raise UsageError(ACP_USAGE)
    return "acp"


def main() -> None:
    """创建服务端并在 asyncio 事件循环中持续处理 CLI 请求。"""
    try:
        mode = _select_mode(sys.argv[1:])
    except UsageError as exc:
        sys.stderr.write(f"{exc}\n")
        sys.stderr.flush()
        sys.exit(2)
    fds = None
    if mode == "acp":
        # 必须在事件循环与任何库初始化之前抢走 fd 1，否则库的 print 会污染协议帧。
        from harness_agent.host.acp.stdio import StdioStartupError, claim_protocol_fds

        try:
            fds = claim_protocol_fds()
        except StdioStartupError as exc:
            sys.stderr.write(f"harness-agent acp: {exc}\n")
            sys.stderr.flush()
            sys.exit(2)
    code = asyncio.run(_run(mode, fds))
    if code:
        sys.exit(code)


async def _run(mode: str = "v3", fds: "ProtocolFds | None" = None) -> int:
    """在运行中的 event loop 内创建异步 writer，并保证退出时有界关闭。

    输出：进程退出码；v3 路径恒为 0（异常照旧向上抛）。
    """
    workspace = Path.cwd().resolve()
    config_path = os.environ.get("HARNESS_AGENT_CONFIG_PATH")
    try:
        effective = load_config(workspace=workspace, config_path=config_path).diagnostics
    except ConfigError:
        # 诊断配置损坏不能挡住 Agent 启动：降级用环境变量级别，业务配置
        # 的严格校验仍在 Host 内部做，这里只求日志先跑起来。
        level = os.environ.get("HARNESS_LOG_LEVEL", "info")
        effective = DiagnosticsSettings(
            level=level if level in {"debug", "info", "warn", "error"} else "info"
        )
    log, lifecycle = create_diagnostic_log(
        component="agent",
        project_fingerprint=workspace_fingerprint(workspace),
        settings=DiagnosticSettings(
            level=effective.level,
            retention_days=effective.retention_days,
            max_total_bytes=effective.max_total_mib * 1024 * 1024,
            max_file_bytes=effective.max_file_mib * 1024 * 1024,
        ),
    )
    command_kind = os.environ.get("HARNESS_COMMAND_KIND", "acp" if mode == "acp" else "agent")
    log.info("process.started", default_process_fields(command_kind))
    install_harness_stdlib_handler(log)
    server = AgentHost(
        workspace=workspace,
        config_path=config_path,
        diagnostic_log=log,
    )
    started_at = time.monotonic()
    outcome = "completed"
    exit_code = 0
    try:
        if mode == "acp":
            # 惰性导入：v3 路径永不加载 ACP SDK，缺包环境也能正常起 Host。
            from harness_agent.host.acp import run_acp_stdio

            exit_code = await run_acp_stdio(server, log=log, fds=fds)
        else:
            await server.run()
    except BaseException:
        outcome = "failed"
        exit_code = 1
        raise
    finally:
        level = log.error if outcome == "failed" else log.info
        level(
            "process.stopped",
            {
                "outcome": outcome,
                "exit_code": exit_code,
                "duration_ms": max(0, round((time.monotonic() - started_at) * 1000)),
            },
        )
        await lifecycle.close()
    return exit_code


if __name__ == "__main__":
    main()
