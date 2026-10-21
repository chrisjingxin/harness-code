"""复现加密代码按位运算被误判为后台命令，以及报告后的冗余模型请求。"""

from types import SimpleNamespace

import pytest
from harness_agent.policy.bash_parser import strip_wrappers
from harness_agent.runtime.fusion.guard import FusionEffectMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from tests.runtime.test_fusion_guard import setup


@pytest.mark.parametrize(
    "command",
    [
        "bash -lc 'echo foreground'",
        "sh -ec 'echo foreground'",
        "bash --noprofile -c 'echo foreground'",
    ],
)
def test_shell_wrapper_preserves_combined_options(command):
    assert strip_wrappers(command) == "echo foreground"


@pytest.mark.parametrize(
    "command",
    [
        "bash script.sh -c 'echo foreground'",
        "bash -- -c 'echo foreground'",
    ],
)
def test_script_operands_are_not_mistaken_for_shell_options(command):
    assert strip_wrappers(command) == command


@pytest.mark.parametrize(
    "command",
    [
        'python3 -c "print(0xff & 0x0f)"',
        "python3 - <<'PY'\nprint(0xff & 0x0f)\nPY",
        'python3 -c "print(3 & 1)" && python3 -c "print(7 & 3)"',
    ],
)
async def test_bitwise_code_is_foreground_execution(tmp_path, command):
    persistence, store, task, lease, context, guard = await setup(tmp_path)
    invoked = []
    try:

        async def handler(request):
            invoked.append(request)
            return ToolMessage(
                content="15\n[Command succeeded with exit code 0]",
                name="execute",
                tool_call_id="check",
            )

        result = await FusionEffectMiddleware(guard, store).awrap_tool_call(
            SimpleNamespace(
                tool_call={
                    "name": "execute",
                    "id": "check",
                    "args": {"command": command},
                },
                runtime=SimpleNamespace(context=context),
            ),
            handler,
        )
        assert len(invoked) == 1, "按位 & 不是 Shell 后台启动，不能阻塞正常 SM4 检查"
        assert result.status != "error"
        assert all(effect["stopped"] for effect in await store.effects(task.task_id))
    finally:
        await persistence.close()


@pytest.mark.parametrize(
    "command",
    [
        "sleep 10 &",
        "sh -c 'sleep 10 &'",
        'echo "$(sleep 10 &)"',
        "python3 - <<PY\nprint('$(sleep 10 &)')\nPY",
        "nohup sleep 10",
        "git add a.py",
        "sh -c 'git add a.py'",
        "python3 -c 'print(1)' &",
        "echo 'unterminated",
        "bash -lc 'sleep 10 &'",
        "env MODE=test sh -c 'sleep 10 &'",
        "timeout 1 sh -c 'sleep 10 &'",
        "busybox sh -c 'sleep 10 &'",
        "find . -exec sh -c 'sleep 10 &' \\;",
        "cmd /c 'start worker & exit'",
    ],
)
async def test_real_background_and_git_mutation_remain_blocked(tmp_path, command):
    persistence, store, task, lease, context, guard = await setup(tmp_path)
    try:

        async def forbidden(request):
            pytest.fail("后台命令或 Git 修改不能执行")

        result = await FusionEffectMiddleware(guard, store).awrap_tool_call(
            SimpleNamespace(
                tool_call={
                    "name": "execute",
                    "id": "blocked",
                    "args": {"command": command},
                },
                runtime=SimpleNamespace(context=context),
            ),
            forbidden,
        )
        assert result.status == "error"
        assert result.content.startswith("FUSION_COMMAND_INVALID")
        assert not await store.effects(task.task_id)
    finally:
        await persistence.close()


async def test_submitted_report_ends_worker_before_another_model_call(tmp_path):
    persistence, store, task, lease, context, guard = await setup(tmp_path)
    try:
        await store.update(
            task.task_id, task.version, data={"report_id": "recorded-report"}
        )
        result = await FusionEffectMiddleware(guard, store).abefore_model(
            {}, SimpleNamespace(context=context)
        )
        assert result is not None and result.get("jump_to") == "end", (
            "报告已保存后不应再等待模型生成结尾"
        )
    finally:
        await persistence.close()


@pytest.mark.parametrize(
    "boundary", ["success", "human", "different_tool", "different_code", "two_only"]
)
async def test_rejection_counter_resets_at_a_real_boundary(tmp_path, boundary):
    persistence, store, task, lease, context, guard = await setup(tmp_path)
    try:
        messages = [
            ToolMessage(
                content="FUSION_COMMAND_INVALID",
                name="execute",
                tool_call_id=f"old-{index}",
                status="error",
            )
            for index in range(3)
        ]
        if boundary == "success":
            messages.append(
                ToolMessage(content="ok", name="read_file", tool_call_id="success")
            )
        elif boundary == "human":
            messages.append(HumanMessage(content="这是新一轮任务"))
        elif boundary == "different_tool":
            messages[-2] = ToolMessage(
                content="FUSION_COMMAND_INVALID",
                name="write_file",
                tool_call_id="other",
                status="error",
            )
        elif boundary == "different_code":
            messages[-2] = ToolMessage(
                content="FUSION_PATH_INVALID",
                name="execute",
                tool_call_id="other",
                status="error",
            )
        else:
            messages.pop()
        messages.append(AIMessage(content="等待下一步"))
        result = await FusionEffectMiddleware(guard, store).abefore_model(
            {"messages": messages}, SimpleNamespace(context=context)
        )
        assert result is None
        assert not (await store.get(task.task_id)).data.get("report_id")
    finally:
        await persistence.close()
