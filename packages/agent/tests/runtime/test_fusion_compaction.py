"""多轮真实摘要后保留当前任务单，丢失历史也能查回原话。"""

import json
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from tests.runtime.test_fusion_service import setup
from tests.support.thread_fixtures import accept_thread
from harness_agent.threads.context_window import ContextWindowMiddleware
from harness_agent.threads.thread_persistence import TranscriptAppend


async def test_current_order_and_original_requirements_survive_repeated_compaction(
    tmp_path,
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        await accept_thread(p, "t", "第一轮")
        task = await store.update(
            task.task_id,
            task.version,
            data={"source_message": "1. 保持接口兼容。\n2. 增加单元测试。"},
        )
        await service.delegate(
            ctx,
            goal="修改实现",
            brief="增加测试",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        order = await store.load_record(task.task_id, "order", "1")
        current = "当前任务单：\n" + json.dumps(
            {key: value for key, value in order.items() if key != "baseline"},
            ensure_ascii=False,
        )
        summary = "## 目标\n保留当前任务\n## 已确认事实\n已查看旧记录\n## 决策\n按当前任务单\n## 改动\n无\n## 测试\n待验收\n## 未决项\n核实结果\n## 归档\n旧记录"
        compact = ContextWindowMiddleware(
            FakeMessagesListChatModel(responses=[AIMessage(content=summary)]),
            context_window_tokens=16384,
            thread_persistence=p,
        )
        messages = [
            HumanMessage(content="较早的调查"),
            AIMessage(content="旧工具输出" + ("a" * 25000)),
            HumanMessage(content="上一轮反馈"),
            HumanMessage(content=current),
        ]
        for i in range(2):
            await p.append_transcript(
                TranscriptAppend(
                    thread_id="t",
                    record_id=f"boundary-{i}",
                    kind="user",
                    content=f"返工 {i}",
                )
            )
            messages, ids, changed = await compact._summarize(
                "t", messages, keep_turns=1
            )
            assert changed and ids
            assert any(
                isinstance(message, HumanMessage) and message.content == current
                for message in messages
            )
            status = await service.status(ctx)
            assert status["requirements"] == order["requirements"]
            assert [item["id"] for item in status["requirements"]] == ["r1", "r2"]
            assert status["requirements"][0]["quote"] == "1. 保持接口兼容。"
            assert status["requirements"][1]["quote"] == "2. 增加单元测试。"
            messages = [
                *messages,
                AIMessage(content="旧结果" + ("b" * 25000)),
                HumanMessage(content=f"过渡反馈 {i}"),
                HumanMessage(content=current),
            ]
    finally:
        await p.close()
