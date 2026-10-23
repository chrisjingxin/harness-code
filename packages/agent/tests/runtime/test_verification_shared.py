import pytest

from harness_agent.config.config import ExecutionSettings
from harness_agent.policy.concurrency import AsyncRWLock
from harness_agent.runtime.verification import (
    ManagedVerificationPort,
    VerificationError,
    VerificationRequest,
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
    events = []

    async def approve(description):
        events.append("approved")
        return True

    def blocked():
        events.append("guard")
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
        await port.run(VerificationRequest("true", "unit", "key", approve=approve))
    assert events == ["approved", "guard"]


async def test_prepared_verification_cannot_run_twice_even_after_backend_failure(
    tmp_path,
):
    async def approve(description):
        return True

    port = ManagedVerificationPort(
        pool=None,
        settings=ExecutionSettings(),
        workspace=tmp_path,
        rules_provider=lambda: [],
        rwlock=AsyncRWLock(),
        now_ms=lambda: 1,
    )
    execute = await port.prepare(
        VerificationRequest("true", "unit", "key", approve=approve)
    )
    with pytest.raises(VerificationError, match="BACKEND_FAILED"):
        await execute()
    with pytest.raises(VerificationError, match="VERIFICATION_ALREADY_EXECUTED"):
        await execute()
