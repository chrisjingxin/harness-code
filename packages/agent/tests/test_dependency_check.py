"""验证零 Anthropic 依赖门禁能读取两种锁文件。"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/dependencies/check_dependencies.py"
SPEC = importlib.util.spec_from_file_location("check_dependencies", SCRIPT)
assert SPEC and SPEC.loader
CHECK = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHECK
SPEC.loader.exec_module(CHECK)


def test_npm_lock_check_rejects_forbidden_packages(tmp_path: Path) -> None:
    lock = tmp_path / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "fixture"},
                    "node_modules/marked": {
                        "version": "17.0.1",
                        "resolved": "https://npm.intranet.example/marked.tgz",
                    },
                    "node_modules/@anthropic-ai/sdk": {
                        "version": "0.1.0",
                        "resolved": "https://npm.intranet.example/sdk.tgz",
                    },
                    "node_modules/other/node_modules/anthropic-sdk": {"version": "0.1.0"},
                },
            }
        ),
        encoding="utf-8",
    )

    assert CHECK.check_npm_lock(lock) == [
        "forbidden package in npm lockfile: @anthropic-ai/sdk",
        "forbidden package in npm lockfile: anthropic-sdk",
    ]


def test_npm_lock_check_requires_lockfile(tmp_path: Path) -> None:
    missing = tmp_path / "package-lock.json"
    assert CHECK.check_npm_lock(missing) == [f"missing npm lockfile: {missing}"]


def test_is_forbidden_normalizes_python_distribution_names() -> None:
    assert CHECK.is_forbidden("LangChain_Anthropic") is True
    assert CHECK.is_forbidden("claude_agent_sdk") is True
    assert CHECK.is_forbidden("langchain-openai") is False


def test_installed_check_follows_links_and_ignores_unlinked_cache(tmp_path: Path) -> None:
    root = tmp_path
    cache_package = root / "node_modules/.bun/@anthropic-ai+sdk@0.1.0/node_modules/@anthropic-ai/sdk"
    cache_package.mkdir(parents=True)
    (cache_package / "package.json").write_text(
        json.dumps({"name": "@anthropic-ai/sdk", "version": "0.1.0"}),
        encoding="utf-8",
    )
    # 历史安装残留的缓存目录不是安装树，未被普通 node_modules 链接时必须忽略。
    assert CHECK.check_installed_packages(root) == []

    linked_package = root / "node_modules/@anthropic-ai/sdk"
    linked_package.parent.mkdir(parents=True)
    try:
        linked_package.symlink_to(cache_package, target_is_directory=True)
        cycle = cache_package / "node_modules/loop"
        cycle.parent.mkdir()
        cycle.symlink_to(root / "node_modules", target_is_directory=True)
    except OSError as error:
        if os.name == "nt":
            pytest.skip(f"Windows symlink capability unavailable: {error}")
        raise

    errors = CHECK.check_installed_packages(root)
    assert len(errors) == 1
    assert "forbidden installed npm package: @anthropic-ai/sdk@0.1.0" in errors[0]


def test_installed_check_scans_each_workspace_link(tmp_path: Path) -> None:
    root = tmp_path
    cache_package = root / "node_modules/.bun/anthropic-sdk@0.1.0/node_modules/anthropic-sdk"
    cache_package.mkdir(parents=True)
    (cache_package / "package.json").write_text(
        json.dumps({"name": "anthropic-sdk", "version": "0.1.0"}),
        encoding="utf-8",
    )
    linked_package = root / "packages/cli/node_modules/anthropic-sdk"
    linked_package.parent.mkdir(parents=True)
    try:
        linked_package.symlink_to(cache_package, target_is_directory=True)
    except OSError as error:
        if os.name == "nt":
            pytest.skip(f"Windows symlink capability unavailable: {error}")
        raise

    errors = CHECK.check_installed_packages(root)
    assert len(errors) == 1
    assert "forbidden installed npm package: anthropic-sdk@0.1.0" in errors[0]
