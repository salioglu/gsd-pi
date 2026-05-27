"""Golden snapshot test for pre_llm_call formatting."""

from __future__ import annotations

from pathlib import Path

from open_gsd_hermes.snapshot import format_snapshot
from open_gsd_hermes.types import ProgressSnapshot

GOLDEN = Path(__file__).parent / "golden" / "snapshot.txt"


def test_snapshot_golden() -> None:
    progress = ProgressSnapshot(
        active_milestone={"id": "M001", "title": "Hermes Integration"},
        active_slice={"id": "S01", "title": "Gateway MVP"},
        active_task={"id": "T01", "title": "Plugin scaffold"},
        phase="execute",
        milestones={"total": 1, "done": 0, "active": 1, "pending": 0, "parked": 0},
        slices={"total": 0, "done": 0, "active": 0, "pending": 0},
        tasks={"total": 0, "done": 0, "pending": 0},
        requirements={"active": 2, "validated": 0, "deferred": 0, "outOfScope": 0},
        blockers=[],
        next_action="Run contract tests for binding and snapshot golden.",
    )
    rendered = format_snapshot(progress)
    expected = GOLDEN.read_text(encoding="utf-8").strip()
    # Phase maps "execution" -> execute in MCP; golden uses execute
    assert rendered.strip() == expected
