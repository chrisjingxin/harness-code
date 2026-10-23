"""恢复旧操作必须明确；带新反馈先交给 Lead，查询和否定不触发执行。"""

import pytest

from harness_agent.runtime.fusion.followup import classify_fusion_followup


@pytest.mark.parametrize(
    "message",
    [
        "继续",
        "继续等待",
        "继续排队",
        "继续原任务",
        "继续返工",
        "继续执行",
        "继续修复",
        "恢复执行",
        "请继续返工。",
        "麻烦继续等待！",
        "continue",
        "Resume.",
        "please continue",
        "continue rework",
    ],
)
def test_explicit_resume_without_new_feedback(message):
    assert classify_fusion_followup(message) == "resume"


@pytest.mark.parametrize(
    "message",
    [
        "继续返工，把问题修好",
        "请修复 a.py 的边界问题",
        "返工：补充空输入测试",
        "继续，把输出改为 JSON",
        "请帮我修改 README 中的示例",
        "修复测试失败",
        "Please fix the empty input case",
        "continue rework with the new format",
        "请让 Sidekick 返工，把空输入修好",
        "让 Sidekick 重新返工：补上测试",
        "返工",
        "重新返工",
        "继续返工：\n1. 修复空输入。\n2. 补充测试。",
        "Please fix the input case:\nKeep the public API.\nAdd tests.",
    ],
)
def test_new_feedback_is_not_an_automatic_replay(message):
    assert classify_fusion_followup(message) == "revise"


@pytest.mark.parametrize(
    "message",
    [
        "",
        "检查谁占用了文件",
        "看看代码",
        "为什么不能继续返工？",
        "继续会修改文件吗",
        "是否可以继续",
        "不要继续",
        "请不要继续返工",
        "别返工了",
        "暂时不要修复",
        "继续之前先检查",
        "继续前先看看代码",
        "继续不了是什么原因",
        "返工是什么意思",
        "“继续返工”是什么意思",
        "`继续`",
        "> 继续返工",
        "请解释如何继续返工",
        "先检查再继续",
        "请继续等待吗",
        "Can you continue?",
        "do not continue",
        "continue only after I confirm",
        "continue after checking the process",
        "continue or cancel?",
        "resume if safe",
        "返工前先核查一下",
        "继续返工，不用修改文件",
        "继续返工，但先别修改文件",
        "continue but don't change files yet",
        "fix later when I confirm",
    ],
)
def test_questions_negations_and_quoted_commands_do_not_resume(message):
    assert classify_fusion_followup(message) == "inspect"
