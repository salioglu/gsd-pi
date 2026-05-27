"""Supervisor FSM transition tests with mock MCP."""

from __future__ import annotations

from unittest.mock import MagicMock

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import DeliveryTarget, ProgressSnapshot, SessionStatus


class MockClient:
    def __init__(self) -> None:
        self.status_calls = 0
        self._status = SessionStatus(status="running")
        self._progress = ProgressSnapshot(phase="execute")

    def status(self, _session_id: str) -> SessionStatus:
        self.status_calls += 1
        return self._status

    def progress(self, _project_dir: str) -> ProgressSnapshot:
        return self._progress

    def invalidate_cache(self, _project_dir: str | None = None) -> None:
        pass


def test_supervisor_detects_blocker() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
    )
    client = MockClient()
    client._status = SessionStatus(
        status="running",
        pending_blocker={"id": "b1", "question": "Approve deploy?"},
    )
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    target = DeliveryTarget("slack", "channel", "C123")
    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: target,
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )
    fsm._tick()
    assert ctx.state == SupervisorState.BLOCKED
    assert any("blocker" in t.lower() or "Approve" in t for t in sent)
