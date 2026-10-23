"""真实 Host 中普通模型、Lead、Sidekick 的鉴权错误都给出清楚原因。"""

import asyncio

import httpx
import openai
import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host
from tests.host.test_fusion_streaming import Frames


class LoginFailedModel(FusionModel):
    failed_role: str

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.role == self.failed_role:
            # 会话标题也会使用默认模型；这里只让实际 Run 的模型请求失败。
            try:
                context = get_runtime().context
            except RuntimeError:
                context = None
            if context is None:
                return ChatResult(
                    generations=[
                        ChatGeneration(message=AIMessage(content="故障提示测试"))
                    ]
                )
            self.calls.append((self.role, "failed"))
            detail = {
                "type": "upstream_error",
                "code": 401,
                "message": "[cn-cli] 上游 401：登录态失效，请重新登录。RAW_BODY_SECRET",
            }
            raise openai.AuthenticationError(
                "RAW_GATEWAY_SECRET",
                response=httpx.Response(
                    401,
                    request=httpx.Request(
                        "POST", "https://example.invalid/v1/chat/completions"
                    ),
                ),
                body=detail,
            )
        return super()._generate(messages, stop, run_manager, **kwargs)


@pytest.mark.parametrize("role", ["normal", "lead", "sidekick"])
async def test_authentication_reason_reaches_run_failure_for_each_role(
    tmp_path, monkeypatch, role
):
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls = []
    failed_role = "strong-test" if role == "lead" else "cheap-test"

    def factory(settings, **kwargs):
        model = LoginFailedModel(role=settings.name, calls=[], failed_role=failed_role)
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        params = {
            "thread_id": "t",
            "run_id": "r",
            "mode": "build",
            "approval_mode": "yolo",
            "input": {"kind": "user", "message": "修复 a.py"},
        }
        if role != "normal":
            params["fusion_profile_id"] = "duo"
        await host.dispatch(
            {"jsonrpc": "2.0", "id": "start", "method": "run.start", "params": params}
        )
        assert "error" not in next(f for f in frames.items if f.get("id") == "start")
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 20)
        failures = frames.events("run.failed")
        assert len(failures) == 1 and not frames.events("run.completed")
        error = failures[0]["payload"]["error"]
        assert error["code"] == "PROVIDER_REQUEST_REJECTED"
        assert "上游账号 cn-cli" in error["message"] and "重新登录" in error["message"]
        assert "HTTP 401" in error["message"]
        assert "RAW_" not in str(frames.items)
        assert calls.count((failed_role, "failed")) == 1
        assert (tmp_path / "a.py").read_text() == "before"
        if role != "normal":
            store = (await host._ensure_thread_persistence()).fusion_state_store()
            task = await store.get(run.preparation.fusion_binding.task_id)
            assert task.phase == "PAUSED" and task.data.get("active_run") is None
    finally:
        await host.close()
