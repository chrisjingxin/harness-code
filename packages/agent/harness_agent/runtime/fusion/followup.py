"""区分暂停后的查看、继续原操作和新修改；供 Host 冻结本轮恢复行为。

只有没有新反馈的明确继续指令可自动恢复旧派单或检查；新修改先交给 Lead。
该判断不改变结果不明状态，也不能代替停止凭据、工具审批或路径授权。
"""

from __future__ import annotations

import re
from typing import Literal

FusionFollowupIntent = Literal["inspect", "resume", "revise"]

_RESUME = frozenset(
    {
        "继续",
        "继续等待",
        "继续排队",
        "继续原任务",
        "继续任务",
        "继续执行",
        "继续返工",
        "继续修复",
        "继续修改",
        "继续处理",
        "恢复执行",
        "恢复任务",
        "恢复返工",
        "continue",
        "resume",
        "continue rework",
        "continue execution",
        "resume execution",
        "resume rework",
    }
)
_POLITE = re.compile(r"^(?:(?:请帮我|请你|麻烦你|请|麻烦|帮我)\s*|please\s+)+")
_WORKER_REQUEST = re.compile(r"^(?:让|叫|安排)\s*sidekick\s*")
_QUESTION = re.compile(
    r"^(?:请问|为什么|为何|怎么|如何|是否|能否|可不可以|能不能|要不要)"
    r"|(?:什么意思|是什么原因|吗|呢|么)$"
)
_ACTION = re.compile(
    r"^(?:继续(?:返工|修复|修改|执行|处理)?|恢复(?:执行|返工|任务)|(?:重新)?(?:返工|修复|修改|修正|调整|补充))"
    r"(?P<feedback>.*)$",
    re.DOTALL,
)
_ENGLISH_ACTION = re.compile(
    r"^(?:continue(?:\s+(?:rework|fixing|execution|working))?|resume(?:\s+(?:execution|rework))?"
    r"|rework|fix|revise|update|implement)\b(?P<feedback>.*)$",
    re.DOTALL,
)
_DEFERRED_OR_READ = re.compile(
    r"^(?:前|之前|以后|之后|不了|的|是否|先|等|检查|查看|看看|阅读|核查|解释|说明|分析"
    r"|不要|不用|不必|别|暂时|确认|但(?:先|不要|不用|别)|不过"
    r"|only\b|after\b|before\b|if\b|when\b|once\b|until\b|or\b|later\b|but\b"
    r"|don't\b|do\s+not\b|check\b|inspect\b|read\b|explain\b)"
)


def classify_fusion_followup(message: str) -> FusionFollowupIntent:
    """识别明确指令，未识别的表述按查看处理；不从引用、疑问或条件句推断执行授权。"""
    text = message.strip().casefold().rstrip("。.!！;；").strip()
    text = _POLITE.sub("", text)
    text = _WORKER_REQUEST.sub("", text)
    if not text or "?" in text or "？" in text or _QUESTION.search(text):
        return "inspect"
    if text in _RESUME:
        return "resume"
    match = _ACTION.match(text) or _ENGLISH_ACTION.match(text)
    if match is None:
        return "inspect"
    feedback = match["feedback"].lstrip(" ，,：:；;、\n")
    if feedback and _DEFERRED_OR_READ.match(feedback):
        return "inspect"
    return "revise"
