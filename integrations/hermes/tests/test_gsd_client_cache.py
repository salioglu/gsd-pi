"""Unit tests for MCP client TTL cache (no subprocess)."""

from __future__ import annotations

import time
from unittest.mock import patch

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.types import ProgressSnapshot


def test_progress_cache_ttl() -> None:
    config = GsdConfig(cache_ttl_seconds=1)
    client = GsdMcpClient(config)
    calls = {"n": 0}

    def fake_call(name: str, arguments: dict) -> dict:
        calls["n"] += 1
        return {
            "phase": "execute",
            "blockers": [],
            "nextAction": "",
        }

    with patch.object(client, "_call_tool", side_effect=fake_call):
        with patch.object(client, "ensure_version"):
            client.progress("/tmp/p")
            client.progress("/tmp/p")
            assert calls["n"] == 1
            time.sleep(1.1)
            client.progress("/tmp/p")
            assert calls["n"] == 2
