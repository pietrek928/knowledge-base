"""Parse Google Takeout Gemini Activity (HTML/JSON) into structured turns."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from knowledge_base.plainify import to_plain

_APP_ID_RE = re.compile(
    r"https://gemini\.google\.com/app/([a-f0-9]+)", re.IGNORECASE
)
_PROMPTED_RE = re.compile(r"^Prompted[\u00a0\s]+", re.IGNORECASE)
_DATE_LINE_RE = re.compile(
    r"^([A-Za-z]{3}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M)\s*([A-Z]{2,5})\s*$"
)
_TZ_MAP = {
    "UTC": "UTC",
    "GMT": "UTC",
    "CET": "Europe/Warsaw",
    "CEST": "Europe/Warsaw",
    "PST": "America/Los_Angeles",
    "PDT": "America/Los_Angeles",
    "EST": "America/New_York",
    "EDT": "America/New_York",
}


def decode_utf8(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(
            "Takeout file is not valid UTF-8; re-export or convert before importing"
        ) from e


def read_utf8_path(path: Path) -> str:
    return decode_utf8(path.read_bytes())


def parse_activity_datetime(caption: str) -> tuple[int | None, int]:
    """Parse Takeout caption like 'Sep 10, 2026, 6:52:37 PM CEST' → (sec, nanos)."""
    raw = (caption or "").replace("\u202f", " ").replace("\xa0", " ").strip()
    m = _DATE_LINE_RE.match(raw)
    if not m:
        return None, 0
    local_s, tz_abbr = m.group(1).strip(), m.group(2).upper()
    try:
        naive = datetime.strptime(local_s, "%b %d, %Y, %I:%M:%S %p")
    except ValueError:
        try:
            naive = datetime.strptime(local_s, "%b %d, %Y, %H:%M:%S")
        except ValueError:
            return None, 0
    tz_name = _TZ_MAP.get(tz_abbr, "UTC")
    try:
        aware = naive.replace(tzinfo=ZoneInfo(tz_name))
    except Exception:
        aware = naive.replace(tzinfo=ZoneInfo("UTC"))
    return int(aware.timestamp()), 0


def _html_to_text(html: str) -> str:
    if not html or not html.strip():
        return ""
    return to_plain(html, kind="html").strip()


def _split_body(body_html: str) -> tuple[str, str | None, str]:
    """Split Prompted user text, optional date line, and Gemini HTML answer."""
    text = body_html.replace("\u00a0", " ")
    parts = re.split(r"<br\s*/?>", text, maxsplit=2, flags=re.IGNORECASE)
    user_raw = parts[0] if parts else text
    date_cand = _html_to_text(parts[1]).replace("\u202f", " ").strip() if len(parts) > 1 else ""
    answer_html = parts[2] if len(parts) > 2 else ""
    date_line = date_cand if _DATE_LINE_RE.match(date_cand) else None
    if date_line is None and len(parts) > 1:
        # Date line missing; treat remainder as answer
        answer_html = parts[1] + (("<br>" + parts[2]) if len(parts) > 2 else "")
    user = _PROMPTED_RE.sub("", _html_to_text(user_raw)).strip()
    return user, date_line, answer_html


def parse_myactivity_html(html: str) -> dict[str, dict[str, Any]]:
    """
    Return conversations keyed by id:
      { id: { "conversation_id", "title", "turns": [...] } }
    """
    conversations: dict[str, dict[str, Any]] = {}
    chunks = html.split('<div class="outer-cell')
    for chunk in chunks[1:]:
        cell = '<div class="outer-cell' + chunk
        body_m = re.search(
            r'class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">(.*?)</div>'
            r'<div class="content-cell mdl-cell mdl-cell--6-col',
            cell,
            re.S | re.I,
        )
        if not body_m:
            continue
        body = body_m.group(1)
        body_norm = body.replace("\u00a0", " ")
        if "Cleared previous feedback" in body_norm and "Prompted" not in body_norm:
            continue
        if "Prompted" not in body_norm:
            continue
        id_m = _APP_ID_RE.search(cell)
        if not id_m:
            continue
        cid = id_m.group(1).lower()
        user, date_line, answer_html = _split_body(body)
        if not user:
            continue
        ts_sec, ts_nanos = parse_activity_datetime(date_line or "")
        answer = _html_to_text(answer_html)
        conv = conversations.setdefault(
            cid,
            {"conversation_id": cid, "title": user[:80], "turns": []},
        )
        turns: list[dict[str, Any]] = conv["turns"]
        turns.append(
            {"role": "user", "text": user, "ts_sec": ts_sec, "ts_nanos": ts_nanos}
        )
        if answer:
            turns.append(
                {
                    "role": "gemini",
                    "text": answer,
                    "ts_sec": (ts_sec + 1) if ts_sec is not None else None,
                    "ts_nanos": 0,
                }
            )
    return conversations


def parse_myactivity_json(data: Any) -> dict[str, dict[str, Any]]:
    """Best-effort JSON Activity parser (shape varies by Takeout version)."""
    conversations: dict[str, dict[str, Any]] = {}
    items: list[Any]
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("//") or data.get("events") or data.get("items") or []
        if not items and "title" in data:
            items = [data]
    else:
        return conversations

    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "")
        url = str(item.get("titleUrl") or item.get("url") or "")
        id_m = _APP_ID_RE.search(url) or _APP_ID_RE.search(json.dumps(item, ensure_ascii=False))
        if not id_m:
            continue
        cid = id_m.group(1).lower()
        time_s = item.get("time") or item.get("timestamp")
        ts_sec = None
        if isinstance(time_s, str):
            try:
                ts_sec = int(datetime.fromisoformat(time_s.replace("Z", "+00:00")).timestamp())
            except ValueError:
                ts_sec = None
        user = _PROMPTED_RE.sub("", title.replace("\u00a0", " ")).strip()
        if not user:
            continue
        answer = ""
        for key in ("html", "description", "details"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                answer = _html_to_text(val) if "<" in val else val.strip()
                break
        conv = conversations.setdefault(
            cid,
            {"conversation_id": cid, "title": user[:80], "turns": []},
        )
        conv["turns"].append(
            {"role": "user", "text": user, "ts_sec": ts_sec, "ts_nanos": 0}
        )
        if answer:
            conv["turns"].append(
                {
                    "role": "gemini",
                    "text": answer,
                    "ts_sec": (ts_sec + 1) if ts_sec is not None else None,
                    "ts_nanos": 0,
                }
            )
    return conversations


def load_takeout(path: Path) -> dict[str, dict[str, Any]]:
    """Load zip / html / json Takeout path into conversations dict."""
    path = path.expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(path)

    if path.suffix.lower() == ".zip":
        import zipfile

        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            html_name = next(
                (
                    n
                    for n in names
                    if n.endswith("MyActivity.html") and "Gemini" in n
                ),
                None,
            )
            json_name = next(
                (
                    n
                    for n in names
                    if n.endswith("MyActivity.json") and "Gemini" in n
                ),
                None,
            )
            if json_name:
                raw = decode_utf8(zf.read(json_name))
                return parse_myactivity_json(json.loads(raw))
            if html_name:
                return parse_myactivity_html(decode_utf8(zf.read(html_name)))
            # fallback any MyActivity.*
            html_name = next((n for n in names if n.endswith("MyActivity.html")), None)
            json_name = next((n for n in names if n.endswith("MyActivity.json")), None)
            if json_name:
                return parse_myactivity_json(json.loads(decode_utf8(zf.read(json_name))))
            if html_name:
                return parse_myactivity_html(decode_utf8(zf.read(html_name)))
        raise ValueError("No MyActivity.html/.json found in zip")

    text = read_utf8_path(path)
    if path.suffix.lower() == ".json":
        return parse_myactivity_json(json.loads(text))
    return parse_myactivity_html(text)
