"""Tiered project binding resolver and session bind store."""

from __future__ import annotations

import os
from pathlib import Path

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import BindingContext


class BindingError(Exception):
    """Raised when project binding cannot be resolved (fail closed)."""


class SessionBindStore:
    """Per-session project directory bindings (from /gsd bind)."""

    def __init__(self) -> None:
        self._by_session: dict[str, str] = {}

    def set(self, session_key: str, project_dir: str) -> None:
        self._by_session[session_key] = str(Path(project_dir).expanduser().resolve())

    def get(self, session_key: str) -> str | None:
        return self._by_session.get(session_key)

    def clear(self, session_key: str) -> None:
        self._by_session.pop(session_key, None)


def _looks_like_gsd_project(path: Path) -> bool:
    return (path / ".gsd").is_dir() or (path / ".planning").is_dir()


def _resolve_channel_binding(
    config: GsdConfig, platform: str | None, channel_id: str | None
) -> str | None:
    if not platform or not channel_id:
        return None
    platform_bindings = config.bindings.get(platform) or {}
    return platform_bindings.get(channel_id)


def _cwd_heuristic(cwd: str | None) -> str | None:
    if not cwd:
        return None
    path = Path(cwd).resolve()
    if _looks_like_gsd_project(path):
        return str(path)
    return None


def resolve_project_dir(
    config: GsdConfig,
    ctx: BindingContext,
    *,
    fail_closed: bool = True,
) -> str:
    """
    Resolve projectDir in order:
      1. cron explicit (cron_project)
      2. slash arg (slash_path)
      3. session bind
      4. channel map
      5. profile default
      6. cwd heuristic
    """
    # Tier order: cron → channel map → /gsd bind (session) → profile default → cwd
    candidates: list[tuple[str, str | None]] = [
        ("cron", ctx.cron_project),
        (
            "channel",
            _resolve_channel_binding(config, ctx.platform, ctx.channel_id),
        ),
        ("session", ctx.session_bind),
        ("slash", ctx.slash_path),
        ("default", config.default_project),
        ("cwd", _cwd_heuristic(ctx.cwd)),
    ]

    for _source, raw in candidates:
        if not raw:
            continue
        path = Path(os.path.expanduser(str(raw))).resolve()
        if not path.is_dir():
            continue
        if _looks_like_gsd_project(path):
            return str(path)

    if fail_closed:
        raise BindingError(
            "No GSD project bound. Use `/gsd bind <path>`, set `default_project` in "
            "~/.hermes/gsd.yaml, or add a channel binding."
        )
    raise BindingError("unreachable")
