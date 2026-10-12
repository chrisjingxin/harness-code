from types import SimpleNamespace
import pytest
from harness_agent.config.config import ExecutionSettings
from harness_agent.policy.concurrency import AsyncRWLock
from harness_agent.runtime.verification import (
    ManagedVerificationPort,
    VerificationRequest,
    VerificationError,
)


async def test_current_plan_permission_blocks_check_before_backend(tmp_path):
    request = VerificationRequest(
        "python -V", "unit", "key", approval_mode_provider=lambda: "plan"
    )
    port = ManagedVerificationPort(
        pool=None,
        settings=ExecutionSettings(),
        workspace=tmp_path,
        rules_provider=lambda: [],
        rwlock=AsyncRWLock(),
        now_ms=lambda: 1,
    )
    with pytest.raises(VerificationError, match="POLICY_DENIED"):
        await port.run(request)


async def test_approval_resume_rechecks_current_permission(tmp_path):
    mode = ["default"]
    called = []

    async def approve(description):
        mode[0] = "plan"
        return True

    request = VerificationRequest(
        "python -V",
        "unit",
        "key",
        approve=approve,
        approval_mode_provider=lambda: mode[0],
    )
    port = ManagedVerificationPort(
        pool=None,
        settings=ExecutionSettings(),
        workspace=tmp_path,
        rules_provider=lambda: [],
        rwlock=AsyncRWLock(),
        now_ms=lambda: 1,
    )
    with pytest.raises(VerificationError, match="POLICY_DENIED"):
        await port.run(request)


async def test_ordinary_check_obeys_workspace_write_guard(tmp_path):
    def blocked():
        raise ValueError("FUSION_LEASE_BUSY")

    port = ManagedVerificationPort(
        pool=None,
        settings=ExecutionSettings(),
        workspace=tmp_path,
        rules_provider=lambda: [],
        rwlock=AsyncRWLock(),
        now_ms=lambda: 1,
        write_guard=blocked,
    )
    with pytest.raises(ValueError, match="FUSION_LEASE_BUSY"):
        await port.run(VerificationRequest("true", "unit", "key"))
