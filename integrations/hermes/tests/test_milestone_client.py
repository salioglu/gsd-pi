"""Tests for GsdMcpClient milestone creation (subprocess-owned, stream-driven).

These tests pin the A1 design from issue #1162's grilling:
- create_milestone spawns `gsd headless --supervised new-milestone`
- a background stream-reader drives NotificationService on blocker/terminal events
- cancel_milestone SIGTERMs the held subprocess
- respond_to_milestone_blocker writes an extension_ui_response to stdin
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient


def _config() -> GsdConfig:
    return GsdConfig(cli_path="/usr/local/bin/gsd")


# ---------------------------------------------------------------------------
# create_milestone — argument construction
# ---------------------------------------------------------------------------


class _FakeProc:
    """Minimal stand-in for subprocess.Popen used by create_milestone."""

    def __init__(self) -> None:
        self.pid = 4242
        self.stdin = MagicMock()
        self.stdout = MagicMock()
        self.stderr = MagicMock()
        self.poll = MagicMock(return_value=None)
        self.terminate = MagicMock()
        self.wait = MagicMock(return_value=0)
        self.kill = MagicMock()


def test_create_milestone_builds_supervised_new_milestone_command_with_context_text() -> None:
    """create_milestone must invoke `gsd headless --supervised new-milestone --context-text <spec>`."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):  # type: ignore[no-untyped-def]
        captured["args"] = args
        captured["cwd"] = kwargs.get("cwd")
        captured["env"] = kwargs.get("env")
        return fake_proc

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", side_effect=fake_popen):
            with patch.object(client, "_milestone_stream_loop"):
                client.create_milestone("/proj", context_text="Build a REST API")

    args = captured["args"]
    assert args[0] == "/usr/local/bin/gsd"
    assert "headless" in args
    assert "--supervised" in args
    assert "new-milestone" in args
    assert "--context-text" in args
    text_idx = args.index("--context-text")
    assert args[text_idx + 1] == "Build a REST API"
    assert captured["cwd"] == "/proj"


def test_create_milestone_builds_command_with_context_file() -> None:
    """--file form passes --context <path> instead of --context-text."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()
    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):  # type: ignore[no-untyped-def]
        captured["args"] = args
        return fake_proc

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", side_effect=fake_popen):
            with patch.object(client, "_milestone_stream_loop"):
                client.create_milestone("/proj", context_file="/path/to/spec.md")

    args = captured["args"]
    assert "--context" in args
    ctx_idx = args.index("--context")
    assert args[ctx_idx + 1] == "/path/to/spec.md"
    assert "--context-text" not in args


def test_create_milestone_requires_either_context_text_or_file() -> None:
    """No spec at all is a usage error, raised before any subprocess spawns."""
    client = GsdMcpClient(_config())
    with pytest.raises(ValueError, match="spec"):
        client.create_milestone("/proj")


def test_create_milestone_rejects_both_context_text_and_file() -> None:
    """Ambiguous input (both forms) is a usage error."""
    client = GsdMcpClient(_config())
    with pytest.raises(ValueError, match="spec"):
        client.create_milestone(
            "/proj", context_text="x", context_file="/p.md"
        )


# ---------------------------------------------------------------------------
# Stream reader — sessionId capture, blocker, terminal
# ---------------------------------------------------------------------------


def test_create_milestone_returns_local_session_id_from_pid() -> None:
    """create_milestone returns a local session id without waiting for init_result."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", return_value=fake_proc):
            with patch.object(client, "_milestone_stream_loop"):
                session_id = client.create_milestone("/proj", context_text="spec")

    assert session_id == "milestone-4242"


def test_stream_loop_captures_session_id_from_init_result() -> None:
    """The reader must pull sessionId out of the init_result stream event."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()
    # stdout yields one init_result line then EOF
    fake_proc.stdout.readline.side_effect = [
        (json.dumps({"type": "init_result", "sessionId": "S-789"}) + "\n").encode(),
        b"",
    ]

    with patch.object(client, "_milestone_proc", fake_proc):
        client._milestone_stream_loop(fake_proc)

    assert client.milestone_session_id() == "S-789"


def test_stream_loop_notifies_blocker_on_supervised_select_request() -> None:
    """Supervised planning prompts (select/input/confirm) must fire notify_blocker."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    blocker_event = {
        "type": "extension_ui_request",
        "method": "select",
        "id": "sel-1",
        "title": "Choose milestone scope",
        "options": ["A", "B"],
    }
    fake_proc.stdout.readline.side_effect = [
        (json.dumps(blocker_event) + "\n").encode(),
        b"",
    ]

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_blocker.assert_called_once()
    assert client.milestone_pending_blocker_id() == "sel-1"


def test_stream_loop_notifies_blocker_on_extension_ui_request() -> None:
    """An extension_ui_request that is a blocked-notice must fire notify_blocker."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    # Realistic blocked-notice message — must match the stop-notice vocabulary
    # the headless event loop emits (see stop-notice.ts isBlockedNoticeMessage).
    blocker_event = {
        "type": "extension_ui_request",
        "method": "notify",
        "id": "blk-1",
        "message": "Auto-mode paused — blocked: choose an option",
    }
    fake_proc.stdout.readline.side_effect = [
        (json.dumps(blocker_event) + "\n").encode(),
        b"",
    ]

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_blocker.assert_called_once()
    # pending blocker id tracked for /gsd reply routing
    assert client.milestone_pending_blocker_id() == "blk-1"


def test_stream_loop_notifies_terminal_on_process_exit() -> None:
    """When the stream ends (process exited), a terminal notification fires."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.stdout.readline.side_effect = [b""]

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_terminal.assert_called_once()


# ---------------------------------------------------------------------------
# cancel_milestone / respond_to_milestone_blocker / milestone_active
# ---------------------------------------------------------------------------


def test_cancel_milestone_terminates_held_subprocess() -> None:
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "_milestone_proc", fake_proc):
        client.cancel_milestone()

    fake_proc.terminate.assert_called_once()


def test_cancel_milestone_when_no_proc_is_a_noop() -> None:
    """Calling cancel with no active milestone proc must not raise."""
    client = GsdMcpClient(_config())
    # should not raise
    client.cancel_milestone()


def test_respond_to_milestone_blocker_writes_extension_ui_response_to_stdin() -> None:
    """The reply must write the supervised-mode stdin JSONL protocol."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_pending_blocker_id", "blk-7"):
            client.respond_to_milestone_blocker("use option B")

    assert fake_proc.stdin.write.called
    written = fake_proc.stdin.write.call_args[0][0]
    payload = json.loads(written.decode() if isinstance(written, bytes) else written)
    assert payload["type"] == "extension_ui_response"
    assert payload["id"] == "blk-7"
    assert payload["value"] == "use option B"


def test_respond_to_milestone_blocker_without_pending_blocker_raises() -> None:
    """No pending blocker id means nothing to reply to — fail loud, don't pretend."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()
    with patch.object(client, "_milestone_proc", fake_proc):
        with pytest.raises(RuntimeError, match="No pending blocker"):
            client.respond_to_milestone_blocker("answer")


def test_milestone_active_reflects_held_proc() -> None:
    client = GsdMcpClient(_config())
    assert client.milestone_active() is False
    with patch.object(client, "_milestone_proc", _FakeProc()):
        assert client.milestone_active() is True
    assert client.milestone_active() is False
