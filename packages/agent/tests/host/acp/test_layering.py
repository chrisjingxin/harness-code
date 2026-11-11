"""ACP 分层约束的架构测试：AST 扫描 import，锁定 Spec §4.2 的代码位置规则。

【规则】（Spec §4.2「代码位置」）
1. `harness_agent/host/acp/` 只做 ACP ⇄ HostServicePort 翻译：除标准库与第三方库
   外，只能 import `harness_agent.host.*` 和 9 处白名单（常量、错误类型、数据记录）。
2. 除了 `host/acp/` 与进程入口 `harness_agent/__main__.py`，任何模块都不能
   import 第三方 `acp` 包或 `harness_agent.host.acp`——业务代码不认识 ACP。

【怎么扫】
`scan_imports` 是纯函数：输入「文件路径 → 源码」映射，输出违规列表。
`ast.walk` 会命中函数体内的延迟 import；相对导入按文件所在包换算成绝对
模块名再判定，所以 `from . import x` 与 `from harness_agent.host.acp import x`
走同一套规则。
"""

from __future__ import annotations

import ast
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

import pytest

AGENT_DIR = Path(__file__).resolve().parents[3]
PACKAGE = "harness_agent"
ACP_DIR = "harness_agent/host/acp"
ENTRY = "harness_agent/__main__.py"

# Spec §4.2 白名单：精确到「模块.名字」；`file_tool_catalog` 是模块级，
# 整个模块（及其任意名字）可 import。
ALLOWED_EXTRA_IMPORTS = {
    "harness_agent.__version__",
    "harness_agent.diagnostic_log.runtime.ensure_log",
    "harness_agent.extensions.plugin_skills.SkillError",
    "harness_agent.extensions.skills.SkillError",
    "harness_agent.threads.thread_persistence.ThreadPersistenceError",
    "harness_agent.threads.thread_records.ThreadSummary",
    "harness_agent.protocol.generated.MAX_FRAME_BYTES",
    "harness_agent.policy.tool_risk.TOOL_KIND_MAP",
    "harness_agent.tools.file_tool_catalog",
}

ACP_SDK = "acp"
"""第三方 `agent-client-protocol` 包的顶层名；只允许出现在 host/acp/ 与 __main__。"""

TEMPORARY_EXEMPTIONS: set[str] = set()
"""临时豁免清单：S2 Todo 2.7 后为空——host/acp 不再 import policy.*。"""


def _iter_import_modules(tree: ast.AST, package: str) -> set[str]:
    """收集一棵树里所有 import 目标（含函数内延迟 import），换算成绝对模块名。

    `import X` 产生 `X`；`from X import a` 产生 `X.a`（模块 `X` 本身不判——
    `from harness_agent import __version__` 这种白名单名字级写法不该被
    「`harness_agent` 不在名单」误伤）；`from X import *` 退化为判 `X` 本身。
    """
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                # 相对导入：level=1 是文件所在包本身，level=2 向上一级。
                parts = package.split(".")
                base = ".".join(parts[: len(parts) - node.level + 1]) + (
                    f".{base}" if base else ""
                )
            for alias in node.names:
                if alias.name == "*":
                    modules.add(base)
                elif base:
                    modules.add(f"{base}.{alias.name}")
    return modules


def _is_allowed_in_acp(module: str) -> bool:
    """host/acp/ 内部允许的 import：host.*、白名单（模块级或名字级）、非 harness。"""
    if module.startswith("harness_agent.host"):
        return True
    if module in ALLOWED_EXTRA_IMPORTS:
        return True
    # 名字级白名单的兜底：`from harness_agent.X import Y` 产生的 `harness_agent.X.Y` 若
    # 不在名单，再看其模块 `harness_agent.X` 是否为模块级条目。
    parent = module.rpartition(".")[0]
    if parent in ALLOWED_EXTRA_IMPORTS:
        return True
    return not module.startswith(PACKAGE)


def scan_imports(sources: Mapping[str, str]) -> list[str]:
    """扫描「posix 路径 → 源码」，返回违规描述列表（空 = 无违规）。

    违规两类：
    - host/acp/ 文件 import 了 `harness_agent.*` 中既非 `host.*` 也非白名单的目标；
    - host/acp/ 与 `__main__.py` 之外的文件 import 了 `acp` 或 `harness_agent.host.acp`。
    """
    violations: list[str] = []
    seen: set[str] = set()
    for path, source in sorted(sources.items()):
        if not path.endswith(".py"):
            continue
        package = str(PurePosixPath(path).parent).replace("/", ".")
        try:
            tree = ast.parse(source, filename=path)
        except SyntaxError:
            violations.append(f"{path}: unparsable")
            continue
        in_acp = path.startswith(f"{ACP_DIR}/")
        is_entry = path == ENTRY
        for module in sorted(_iter_import_modules(tree, package)):
            if not module:
                continue
            if in_acp:
                if not _is_allowed_in_acp(module) and module not in TEMPORARY_EXEMPTIONS:
                    message = (
                        f"{path}: host/acp 不允许 import {module}"
                        "（只能 host.* 或白名单）"
                    )
                    if message not in seen:
                        seen.add(message)
                        violations.append(message)
            elif not is_entry:
                if module == ACP_SDK or module.startswith(f"{ACP_SDK}."):
                    message = f"{path}: host/acp 与 __main__ 之外不允许 import acp"
                    if message not in seen:
                        seen.add(message)
                        violations.append(message)
                elif module == "harness_agent.host.acp" or module.startswith(
                    "harness_agent.host.acp."
                ):
                    message = f"{path}: host/acp 与 __main__ 之外不允许 import {module}"
                    if message not in seen:
                        seen.add(message)
                        violations.append(message)
    return violations


def _real_sources() -> dict[str, str]:
    """读取真实 `harness_agent/` 源码树（跳过 __pycache__）。"""
    root = AGENT_DIR / "harness_agent"
    return {
        path.relative_to(AGENT_DIR).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*.py"))
        if "__pycache__" not in path.parts
    }


def test_real_tree_has_no_layering_violations() -> None:
    """真实目录应当零违规（白名单 + 临时豁免之外）。"""
    assert scan_imports(_real_sources()) == []


def test_scanner_catches_acp_importing_business_module() -> None:
    """host/acp/ 里 import 非白名单的 `harness_agent.*` 必须被拦下。"""
    sources = {
        "harness_agent/host/acp/evil.py": (
            "import harness_agent.runtime.run_coordinator\n"
            "from harness_agent.runtime import x\n"
        ),
    }
    violations = scan_imports(sources)
    assert violations, "应检出违规"
    assert any("harness_agent.runtime" in v and "evil.py" in v for v in violations)


def test_scanner_catches_business_module_importing_acp() -> None:
    """host/acp/ 之外的模块 import `acp` 或 `harness_agent.host.acp` 必须被拦下。"""
    sources = {
        "harness_agent/tools/evil.py": "import acp.schema\n",
        "harness_agent/host/evil.py": "from harness_agent.host.acp import run_acp_stdio\n",
    }
    violations = scan_imports(sources)
    assert len(violations) == 2
    assert any("tools/evil.py" in v for v in violations)
    assert any("host/evil.py" in v for v in violations)


def test_scanner_accepts_whitelist_and_entrypoint() -> None:
    """白名单名字、`host.*`、延迟 import 与 `__main__` 的豁免路径都不算违规。"""
    sources = {
        "harness_agent/host/acp/ok.py": (
            "from harness_agent import __version__\n"
            "from harness_agent.diagnostic_log.runtime import ensure_log\n"
            "from harness_agent.extensions.plugin_skills import SkillError\n"
            "from harness_agent.extensions.skills import SkillError as A\n"
            "from harness_agent.threads.thread_persistence import ThreadPersistenceError\n"
            "from harness_agent.threads.thread_records import ThreadSummary\n"
            "from harness_agent.protocol.generated import MAX_FRAME_BYTES\n"
            "from harness_agent.policy.tool_risk import TOOL_KIND_MAP\n"
            "from harness_agent.tools.file_tool_catalog import tool_title\n"
            "from harness_agent.host.service_types import HostSnapshot\n"
            "from .tool_display import PathLocator\n"
            "import acp.schema\n"
            "def f():\n"
            "    from harness_agent.policy.workspace_boundary import X\n"
        ),
        "harness_agent/__main__.py": (
            "from harness_agent.host.acp import run_acp_stdio\nimport acp.core\n"
        ),
        "harness_agent/tools/clean.py": "import json\nimport pytest\n",
    }
    # 注意：函数体内 `workspace_boundary` 不在白名单，预期被检出——这正是本测试
    # 要锁定的行为（延迟 import 也逃不过）。
    violations = scan_imports(sources)
    assert violations == [
        "harness_agent/host/acp/ok.py: host/acp 不允许 import "
        "harness_agent.policy.workspace_boundary.X（只能 host.* 或白名单）"
    ]
