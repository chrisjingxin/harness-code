"""HC-238 ACP 多模态图片输入协议、校验与 Run 组装测试。"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage

from harness_agent.host.run_coordinator import PromptImage, StartRun, UserRunInput
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    make_host,
    prompt_response,
    text,
)

# 1x1 透明 PNG 的最小合法 Base64 负载。
_PNG_B64 = base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
    b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
).decode("ascii")
_JPEG_B64 = base64.b64encode(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\xff\xd9").decode("ascii")


async def _init_session(acp: InProcessAcp) -> tuple[dict[str, Any], str]:
    init = await acp.client.request(
        1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )
    assert "result" in init, init
    created = await acp.client.request(
        2, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
    )
    assert "result" in created, created
    return init["result"], created["result"]["sessionId"]


async def test_acp_image_prompt_forwards_multimodal_human_message_and_keeps_transcript_text_only(
    tmp_path: Path,
) -> None:
    """文本 + 图片块到达模型层时转成 image_url 多模态 HumanMessage，Transcript 仅保留文本。"""
    agent = ScriptedAgent([text("收到图片")])
    host = make_host(tmp_path, agent=agent)
    started_inputs: list[UserRunInput] = []
    original_start_run = host.start_run

    async def spy_start_run(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        if isinstance(request.input, UserRunInput):
            started_inputs.append(request.input)
        return await original_start_run(connection, request, on_accepted=on_accepted)

    host.start_run = spy_start_run  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        init_result, session_id = await _init_session(acp)
        assert init_result["agentCapabilities"]["promptCapabilities"] == {
            "image": True,
            "audio": False,
            "embeddedContext": True,
        }
        res = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "text", "text": "帮我看看这张截图"},
                    {"type": "image", "data": _PNG_B64, "mimeType": "image/png"},
                ],
            },
        )
        assert prompt_response(res).stop_reason == "end_turn"

    assert len(started_inputs) == 1
    assert started_inputs[0].message == "帮我看看这张截图"
    assert len(started_inputs[0].images) == 1
    assert started_inputs[0].images[0].mime_type == "image/png"

    assert len(agent.inputs) == 1
    stream_input = agent.inputs[0]
    assert isinstance(stream_input, dict)
    msg = stream_input["messages"][0]
    assert isinstance(msg, HumanMessage)
    assert msg.content == [
        {"type": "text", "text": "帮我看看这张截图"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_PNG_B64}"}},
    ]


async def test_acp_image_only_prompt_succeeds_without_text_block(tmp_path: Path) -> None:
    """纯图片（无 text 块）允许提交，Transcript 写入简洁占位文案，模型仍收图像块。"""
    agent = ScriptedAgent([text("看清了")])
    host = make_host(tmp_path, agent=agent)
    started_inputs: list[UserRunInput] = []
    original_start_run = host.start_run

    async def spy_start_run(connection: Any, request: Any, on_accepted: Any = None) -> Any:
        if isinstance(request.input, UserRunInput):
            started_inputs.append(request.input)
        return await original_start_run(connection, request, on_accepted=on_accepted)

    host.start_run = spy_start_run  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        _, session_id = await _init_session(acp)
        res = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "image", "data": _PNG_B64, "mimeType": "image/png"},
                    {"type": "image", "data": _JPEG_B64, "mimeType": "image/jpeg"},
                ],
            },
        )
        assert prompt_response(res).stop_reason == "end_turn"

    assert started_inputs[0].message == "[附 2 张图片]"
    assert _PNG_B64 not in started_inputs[0].message
    msg = agent.inputs[0]["messages"][0]  # type: ignore[index]
    assert isinstance(msg, HumanMessage)
    assert len(msg.content) == 3
    assert msg.content[0] == {"type": "text", "text": "[附 2 张图片]"}
    assert msg.content[1]["image_url"]["url"] == f"data:image/png;base64,{_PNG_B64}"  # type: ignore[index]
    assert msg.content[2]["image_url"]["url"] == f"data:image/jpeg;base64,{_JPEG_B64}"  # type: ignore[index]


async def test_acp_image_validation_rejects_bad_mime_bad_base64_and_oversize(
    tmp_path: Path,
) -> None:
    """非法 MIME、畸形/空 Base64、单张或累计超限与超数量均应拒绝并返回明确错误码。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        _, session_id = await _init_session(acp)

        bad_mime = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "image", "data": _PNG_B64, "mimeType": "image/svg+xml"}],
            },
        )
        assert bad_mime["error"]["code"] == -32602
        assert bad_mime["error"]["data"]["code"] == "INVALID_IMAGE_BLOCK"

        bad_b64 = await acp.client.request(
            4,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "image", "data": "not-valid-base64!!!", "mimeType": "image/png"}],
            },
        )
        assert bad_b64["error"]["code"] == -32602
        assert bad_b64["error"]["data"]["code"] == "INVALID_IMAGE_BLOCK"

        empty_b64 = await acp.client.request(
            5,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "image", "data": "   ", "mimeType": "image/png"}],
            },
        )
        assert empty_b64["error"]["code"] == -32602
        assert empty_b64["error"]["data"]["code"] == "INVALID_IMAGE_BLOCK"

        too_big = base64.b64encode(b"x" * (4 * 1024 * 1024 + 1)).decode("ascii")
        oversize = await acp.client.request(
            6,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "image", "data": too_big, "mimeType": "image/png"}],
            },
        )
        assert oversize["error"]["code"] == -32602
        assert oversize["error"]["data"]["code"] == "IMAGE_TOO_LARGE"

        under_two_megs = base64.b64encode(b"y" * 1_900_000).decode("ascii")
        total_oversize = await acp.client.request(
            7,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "image", "data": under_two_megs, "mimeType": "image/png"},
                    {"type": "image", "data": under_two_megs, "mimeType": "image/png"},
                    {"type": "image", "data": under_two_megs, "mimeType": "image/png"},
                ],
            },
        )
        assert total_oversize["error"]["code"] == -32602
        assert total_oversize["error"]["data"]["code"] == "IMAGE_TOO_LARGE"

        too_many = await acp.client.request(
            8,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "image", "data": _PNG_B64, "mimeType": "image/png"}
                    for _ in range(11)
                ],
            },
        )
        assert too_many["error"]["code"] == -32602
        assert too_many["error"]["data"]["code"] == "IMAGE_TOO_LARGE"


def test_start_run_fingerprint_distinguishes_distinct_images() -> None:
    """相同占位文案但不同图片的两次 Run 指纹不同，避免误判幂等复用。"""
    run_a = StartRun(
        thread_id="t-1",
        run_id="r-1",
        mode="build",
        input=UserRunInput(
            "[附 1 张图片]",
            images=(PromptImage(mime_type="image/png", data=_PNG_B64),),
        ),
    )
    run_b = StartRun(
        thread_id="t-1",
        run_id="r-1",
        mode="build",
        input=UserRunInput(
            "[附 1 张图片]",
            images=(PromptImage(mime_type="image/jpeg", data=_JPEG_B64),),
        ),
    )
    assert run_a.fingerprint() != run_b.fingerprint()
