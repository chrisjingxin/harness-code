"""本轮权威耗时包含准备、终态冻结，并与 Trace 共用。"""

from types import SimpleNamespace
import pytest

from harness_agent.host.run_coordinator import RunCoordinator, RunTimingLedger
from harness_agent.runtime.run_usage import RunUsage
from harness_agent.tracing import TraceRecorder
from tests.threads.test_run_usage_store import immediate


def test_ledger_freezes_at_result_completion_including_preparation():
    now = [10.0]
    timing = RunTimingLedger(clock=lambda: now[0], started_at=10.0)
    now[0] = 10.092
    active = timing.begin_active()
    now[0] = 12.764
    timing.end_active(active)
    timing.finish()
    now[0] = 20.0
    timing.finish()
    assert timing.snapshot()["duration_ms"] == 2764
    assert timing.snapshot()["active_ms"] == 2672


@pytest.mark.parametrize("outcome", ["completed", "failed", "cancelled"])
def test_terminal_freezes_before_save_and_trace_uses_same_duration(outcome):
    now, saved, emitted, records = [10.0], [], [], []
    timing = RunTimingLedger(clock=lambda: now[0], started_at=10.0)

    class Persistence:
        async def save_run_summary(self, thread_id, run_id, status, usage, duration_ms):
            saved.append(duration_ms)
            now[0] += 5

    coordinator = object.__new__(RunCoordinator)
    coordinator._goal_terminal_reconciler = None
    def finish(run, status, payload):
        run.status = status
        emitted.append(payload["duration_ms"])
        run.completion = SimpleNamespace(status=status, duration_ms=payload["duration_ms"], usage=payload["usage"], error=None)
    coordinator._finish = finish
    recorder = TraceRecorder(session_id="thread", run_id="run", log_dir="unused", writer=SimpleNamespace(append=lambda session, record: records.append(record)))
    context = recorder.start_trace()
    run = SimpleNamespace(completion=None, context_summary={}, timing=timing, usage_collector=RunUsage(), persistence=Persistence(), ref=SimpleNamespace(thread_id="thread", run_id="run"), trace_context=context, status="completed")
    now[0] = 12.764
    immediate(coordinator._finish_after_goal_reconcile(run, outcome, {"duration_ms": 2600}))
    now[0] += 10
    coordinator._complete_trace(run)
    assert saved == emitted == [2764]
    assert records[-1]["attributes"]["run_duration_ms"] == 2764
