"""HC-180 三仓评测的最小可复跑 runner；不建设通用 benchmark 平台。"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

DEFAULT_REPOS = {
    "harness": Path("/Users/zhangjingxin/Code/MyRepo/harness-code"),
    "qwen-code": Path("/Users/zhangjingxin/Code/OpenSource/qwen-code"),
    "deepagents": Path("/Users/zhangjingxin/Code/OpenSource/deepagents"),
}

QUESTIONS = {
    "harness": [
        {
            "id": "H1",
            "query": "CodeIndexManager acquire_query lease generation",
            "expect": "acquire_query",
            "files": [
                "packages/agent/harness_agent/code_index/manager.py",
                "packages/agent/harness_agent/tools/codebase_explore.py",
            ],
        },
        {
            "id": "H2",
            "query": "resolveCliInstallRoot published scoped package",
            "expect": "resolveCliInstallRoot",
            "files": ["packages/cli/src/runtime-binding.ts"],
        },
        {
            "id": "H3",
            "query": "selectCodeIndexView 代码索引 建立中",
            "expect": "selectCodeIndexView",
            "files": ["packages/cli/src/interactive/selectors/index.ts"],
        },
    ],
    "qwen-code": [
        {
            "id": "Q1",
            "query": "GeminiChat sendMessageStream tool",
            "expect": "sendMessageStream",
            "files": ["packages/core/src/core/geminiChat.ts", "packages/core/src/core/client.ts"],
        },
        {
            "id": "Q2",
            "query": "slash command parser",
            "expect": "command",
            "files": ["packages/cli/src/ui/commands", "packages/cli/src/services"],
        },
    ],
    "deepagents": [
        {
            "id": "D1",
            "query": "create_deep_agent tools middleware",
            "expect": "create_deep_agent",
            "files": ["libs/deepagents/deepagents", "libs/deepagents"],
        },
        {
            "id": "D2",
            "query": "FilesystemMiddleware read_file",
            "expect": "FilesystemMiddleware",
            "files": ["libs/deepagents/deepagents"],
        },
    ],
}


def copy_question_files(source: Path, destination: Path, files: list[str]) -> list[str]:
    """把问题相关文件复制到临时工作区；缺失路径记入 skipped。"""
    copied: list[str] = []
    for relative in files:
        origin = source / relative
        if origin.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origin, target)
            copied.append(relative)
        elif origin.is_dir():
            matches = list(origin.rglob("*.py")) + list(origin.rglob("*.ts")) + list(origin.rglob("*.tsx"))
            for item in matches[:12]:
                rel = item.relative_to(source)
                target = destination / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)
                copied.append(str(rel))
    return copied


def baseline_grep(workspace: Path, needle: str) -> list[str]:
    hits: list[str] = []
    for path in workspace.rglob("*"):
        if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if needle in text:
            hits.append(str(path.relative_to(workspace)))
    return hits


def run_index_questions(workspace: Path, questions: list[dict[str, object]]) -> list[dict[str, object]]:
    """若 1.1.6 runtime 可用则建图并探索；否则只返回 skipped。"""
    from harness_agent.code_index.manager import CodeIndexManager
    from harness_agent.code_index.runtime import NodeCodeIndexRuntime

    repo = Path(__file__).resolve().parents[4]
    runtime = NodeCodeIndexRuntime(repo)
    preflight = runtime.preflight()
    if not preflight.ok:
        return [{"skipped": True, "reason": None if preflight.error is None else preflight.error.code} for _ in questions]

    import asyncio

    async def _run() -> list[dict[str, object]]:
        manager = CodeIndexManager(workspace, runtime)
        started = time.monotonic()
        await manager.apply({"action": "ensure", "expected_revision": manager.snapshot()["revision"]})
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and manager.snapshot()["query_status"] != "ready":
            await asyncio.sleep(0.05)
        index_ms = int((time.monotonic() - started) * 1000)
        snapshot = manager.snapshot()
        rows: list[dict[str, object]] = []
        if snapshot["query_status"] != "ready":
            await manager.close()
            return [{"skipped": True, "reason": snapshot.get("error"), "index_ms": index_ms} for _ in questions]
        for question in questions:
            lease = await manager.acquire_query()
            assert lease is not None
            query_started = time.monotonic()
            text = await lease.explore(str(question["query"]), 6)
            await lease.release()
            rows.append(
                {
                    "id": question["id"],
                    "hit": str(question["expect"]).lower() in text.lower(),
                    "query_ms": int((time.monotonic() - query_started) * 1000),
                    "index_ms": index_ms,
                    "chars": len(text),
                    "stats": snapshot.get("stats"),
                }
            )
        await manager.close()
        return rows

    return asyncio.run(_run())


def main() -> int:
    parser = argparse.ArgumentParser(description="HC-180 代码索引最小评测")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"repos": {}, "mode": "copied-question-files"}
    for name, root in DEFAULT_REPOS.items():
        entry: dict[str, object] = {"root": str(root), "available": root.is_dir(), "questions": []}
        if not root.is_dir():
            entry["replacement"] = "path missing"
            report["repos"][name] = entry
            continue
        try:
            commit = (root / ".git").exists()
            entry["git"] = commit
        except OSError:
            entry["git"] = False
        work = out / f"workspace-{name}"
        if work.exists():
            shutil.rmtree(work)
        work.mkdir()
        for question in QUESTIONS[name]:
            copied = copy_question_files(root, work, question["files"])
            started = time.monotonic()
            hits = baseline_grep(work, question["expect"])
            elapsed = time.monotonic() - started
            entry["questions"].append(
                {
                    "id": question["id"],
                    "query": question["query"],
                    "copied_files": copied,
                    "baseline_hits": hits[:8],
                    "baseline_hit": any(question["expect"].lower() in item.lower() for item in hits)
                    or bool(copied),
                    "baseline_ms": int(elapsed * 1000),
                }
            )
        entry["index"] = run_index_questions(work, QUESTIONS[name])
        report["repos"][name] = entry
    (out / "eval-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
