"""Canonical Gemini conversation formatting (single owner for path/markdown/fingerprint)."""

import hashlib
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

_EPOCH_MIN = int(datetime(2015, 1, 1, tzinfo=UTC).timestamp())
_EPOCH_MAX = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp())
_ROLE_LABEL = {"user": "User", "gemini": "Gemini"}


def path_for(conversation_id: str) -> str:
    cid = (conversation_id or "").strip()
    if cid.startswith("c_"):
        cid = cid[2:]
    if not cid:
        raise ValueError("conversation_id required")
    return f"gemini/{cid}.md"


def to_iso_z(ts_sec: int | float | None, ts_nanos: int | float | None = 0) -> str | None:
    """Clamp epoch to a sane range; return second-precision UTC ISO with Z, or None."""
    if ts_sec is None:
        return None
    try:
        sec = int(ts_sec)
    except (TypeError, ValueError):
        return None
    if sec < _EPOCH_MIN or sec > _EPOCH_MAX:
        return None
    dt = datetime.fromtimestamp(sec, tz=UTC).replace(microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def fingerprint(markdown: str) -> str:
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


def _normalize_role(role: str | None) -> str:
    r = (role or "").strip().lower()
    if r in ("user", "human", "prompt"):
        return "user"
    if r in ("gemini", "model", "assistant", "bot"):
        return "gemini"
    return "gemini" if r else "user"


def _turn_sort_key(item: tuple[int, Mapping[str, Any]]) -> tuple[int, int, int]:
    idx, turn = item
    sec = turn.get("ts_sec")
    try:
        sec_i = int(sec) if sec is not None else 0
    except (TypeError, ValueError):
        sec_i = 0
    if sec_i < _EPOCH_MIN or sec_i > _EPOCH_MAX:
        sec_i = 0
    try:
        nano = int(turn.get("ts_nanos") or 0)
    except (TypeError, ValueError):
        nano = 0
    return (0 if sec_i else 1, sec_i, idx if not sec_i else nano)


def _clean_title(title: str | None) -> str:
    t = (title or "").strip() or "Gemini conversation"
    t = re.sub(r"\s+", " ", t)
    t = t.rstrip(".,;:!? ")
    return t or "Gemini conversation"


def format_markdown(title: str | None, turns: Sequence[Mapping[str, Any]]) -> str:
    """Build canonical conversation markdown. Body must not depend on ingest source."""
    lines: list[str] = [f"# {_clean_title(title)}", ""]
    ordered = sorted(enumerate(turns), key=_turn_sort_key)
    for _, turn in ordered:
        role = _normalize_role(str(turn.get("role") or ""))
        label = _ROLE_LABEL[role]
        iso = to_iso_z(turn.get("ts_sec"), turn.get("ts_nanos"))
        header = f"**{label}** ({iso}):" if iso else f"**{label}**:"
        text = str(turn.get("text") or "").strip()
        lines.append(header)
        lines.append("")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def max_turn_iso(turns: Sequence[Mapping[str, Any]]) -> str | None:
    best: str | None = None
    best_sec = -1
    for turn in turns:
        iso = to_iso_z(turn.get("ts_sec"), turn.get("ts_nanos"))
        if not iso:
            continue
        try:
            sec = int(turn.get("ts_sec") or 0)
        except (TypeError, ValueError):
            continue
        if sec > best_sec:
            best_sec = sec
            best = iso
    return best


def build_doc_metadata(
    *,
    conversation_id: str,
    title: str | None,
    ingest: str,
    turns: Sequence[Mapping[str, Any]],
    markdown: str,
) -> dict[str, Any]:
    cid = (conversation_id or "").strip()
    if cid.startswith("c_"):
        cid = cid[2:]
    meta: dict[str, Any] = {
        "source": "gemini",
        "ingest": ingest,
        "conversation_id": cid,
        "title": _clean_title(title),
        "message_count": len(turns),
        "content_fingerprint": fingerprint(markdown),
    }
    updated = max_turn_iso(turns)
    if updated:
        meta["updated_at"] = updated
    return meta
