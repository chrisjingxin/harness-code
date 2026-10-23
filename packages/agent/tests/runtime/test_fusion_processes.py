"""两个真实 Python 进程共享目录和数据库，同时预留不同文件。"""

import asyncio
import os
import sys
from pathlib import Path

from harness_agent.threads.thread_persistence import ThreadPersistence

CHILD = """
import asyncio,sys
from pathlib import Path
from harness_agent.threads.thread_persistence import ThreadPersistence
async def main():
    root,home,label=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
    p=await ThreadPersistence.open(project=root,home=home)
    store=p.fusion_state_store()
    lease=None
    try:
        task=await store.create(thread_id=label,profile={},workspace=root,source_message='修改')
        lease=await store.acquire_lease(task.task_id,'sidekick',paths=[label+'.py'])
        print('ready',flush=True)
        await asyncio.to_thread(sys.stdin.readline)
    finally:
        if lease: await store.release_lease(lease.task_id,lease.generation)
        await p.close()
asyncio.run(main())
"""


async def test_independent_processes_hold_different_files_concurrently(tmp_path):
    root, home = tmp_path / "workspace", tmp_path / "home"
    root.mkdir()
    p = await ThreadPersistence.open(project=root, home=home)
    children = []
    try:
        env = dict(
            os.environ,
            PYTHONPATH=str(Path(__file__).resolve().parents[2]),
            PYTHONDONTWRITEBYTECODE="1",
        )
        for label in ("a", "b"):
            children.append(
                await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-c",
                    CHILD,
                    str(root),
                    str(home),
                    label,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                )
            )
        for child in children:
            assert await asyncio.wait_for(child.stdout.readline(), 10) == b"ready\n"
        store = p.fusion_state_store()
        async with store.lock:
            records = await (
                await store.connection.execute(
                    "SELECT paths_json FROM fusion_reservations WHERE owner IS NOT NULL"
                )
            ).fetchall()
        assert len(records) == 2 and {row[0] for row in records} == {
            '["a.py"]',
            '["b.py"]',
        }
        for child in children:
            child.stdin.write(b"continue\n")
            await child.stdin.drain()
        for child in children:
            _, errors = await asyncio.wait_for(child.communicate(), 10)
            assert child.returncode == 0, errors.decode()
    finally:
        for child in children:
            if child.returncode is None:
                child.terminate()
                await asyncio.wait_for(child.wait(), 5)
        await p.close()
