"""In-memory extension command broker (register / poll / events / wait)."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from knowledge_base.ext_protocol import (
    TERMINAL_STATUSES,
    CommandKind,
    CommandStatus,
    Effort,
    EventType,
    SearchSource,
    normalize_command_kind,
)

log = logging.getLogger(__name__)

BROWSER_TTL_S = 60.0
POLL_MAX_S = 25.0
DEFAULT_QUERY_TIMEOUT_S = 180
MIN_TIMEOUT_S = 10
MAX_TIMEOUT_S = 600
TERMINAL = TERMINAL_STATUSES  # alias for callers/tests


def clamp_timeout(v: Any, default: int = DEFAULT_QUERY_TIMEOUT_S) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return max(MIN_TIMEOUT_S, min(MAX_TIMEOUT_S, n))


def parse_model_spec(spec: str | None) -> tuple[str | None, str | None]:
    """Parse `model` or `model:effort` (default effort medium when model set).

    Model may be a full picker label or a short case-insensitive core
    (e.g. ``argon``, ``flash-lite``) that chip-matches via token-tail equality.
    Effort is always lowercased (``High`` → ``high``).
    """
    if not spec or not str(spec).strip():
        return None, None
    raw = str(spec).strip()
    if ":" in raw:
        model, effort = raw.rsplit(":", 1)
        model = model.strip() or None
        effort_raw = (effort.strip() or str(Effort.MEDIUM)).lower()
        return model, effort_raw
    return raw, str(Effort.MEDIUM).lower()


@dataclass
class BrowserReg:
    browser_id: str
    account: str | None = None
    capabilities: list[str] = field(default_factory=list)
    last_seen: float = field(default_factory=time.monotonic)
    busy: bool = False
    conversation_ids: set[str] = field(default_factory=set)


@dataclass
class Command:
    id: str
    kind: str
    params: dict[str, Any]
    status: str = CommandStatus.PENDING
    created_at: float = field(default_factory=time.monotonic)
    # Wall-clock for timeout starts when work begins (running), not enqueue —
    # extension pacing before "running" must not eat the CLI timeout budget.
    started_at: float | None = None
    timeout_s: int = DEFAULT_QUERY_TIMEOUT_S
    target_browser_id: str | None = None
    target_account: str | None = None
    claimed_by: str | None = None
    parent_id: str | None = None
    child_ids: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    sources_cache_hits: list[dict[str, Any]] = field(default_factory=list)


class ExtBroker:
    def __init__(self, *, list_docs: Callable[..., list] | None = None, get_document: Callable[..., Any] | None = None):
        self._browsers: dict[str, BrowserReg] = {}
        self._commands: dict[str, Command] = {}
        self._pending: asyncio.Queue[str] = asyncio.Queue()
        self._lock = asyncio.Lock()
        self._list_docs = list_docs
        self._get_document = get_document
        self._poll_waiters: list[asyncio.Event] = []

    def _now(self) -> float:
        return time.monotonic()

    def _prune_browsers(self) -> None:
        cutoff = self._now() - BROWSER_TTL_S
        dead = [bid for bid, b in self._browsers.items() if b.last_seen < cutoff]
        for bid in dead:
            acc = self._browsers[bid].account
            del self._browsers[bid]
            log.info(
                "extension disconnected browser_id=%s account=%s",
                bid[:8],
                acc or "-",
            )

    def _cmd_age_s(self, cmd: Command) -> float:
        """Seconds counted against timeout_s.

        Prefer started_at (set on first ``running`` event) so extension
        reading-time pacing before work does not consume the CLI budget.
        Claimed-but-not-running gets a 180s grace for that pacing dwell.
        """
        if cmd.started_at is not None:
            return self._now() - cmd.started_at
        if cmd.status == CommandStatus.CLAIMED:
            return max(0.0, self._now() - cmd.created_at - 180.0)
        return self._now() - cmd.created_at

    def _reap_stale_commands(self) -> None:
        """Mark timed-out commands and free busy browsers (even if no client is waiting)."""
        now = self._now()
        for cmd in list(self._commands.values()):
            if cmd.status in TERMINAL:
                continue
            # Pending/claimed-but-not-running: still use created_at so abandoned
            # commands don't sit forever; once started_at is set, pacing is excluded.
            if self._cmd_age_s(cmd) < cmd.timeout_s:
                continue
            cmd.status = CommandStatus.TIMEOUT
            cmd.error = "command timed out"
            cmd.result = {"error": "command timed out"}
            cmd.events.append(
                {
                    "seq": len(cmd.events) + 1,
                    "type": EventType.TIMEOUT,
                    "payload": cmd.result,
                    "ts": time.time(),
                }
            )
            if cmd.claimed_by and cmd.claimed_by in self._browsers:
                self._browsers[cmd.claimed_by].busy = False
            cmd.wake.set()
            log.info(
                "command timeout id=%s kind=%s (reaper)",
                cmd.id[:8],
                cmd.kind,
            )
        # Clear busy if no non-terminal claimed command for that browser
        for bid, reg in self._browsers.items():
            if not reg.busy:
                continue
            active = any(
                c.claimed_by == bid and c.status not in TERMINAL
                for c in self._commands.values()
            )
            if not active:
                reg.busy = False
                log.info("cleared stale busy flag browser_id=%s", bid[:8])

    def live_browsers(self) -> list[dict[str, Any]]:
        self._prune_browsers()
        self._reap_stale_commands()
        out = []
        for b in self._browsers.values():
            out.append(
                {
                    "browser_id": b.browser_id,
                    "account": b.account,
                    "capabilities": list(b.capabilities),
                    "last_seen": b.last_seen,
                    "busy": b.busy,
                    "age_s": round(self._now() - b.last_seen, 2),
                }
            )
        return out

    async def register(
        self,
        browser_id: str,
        *,
        account: str | None = None,
        capabilities: list[str] | None = None,
        conversation_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            self._reap_stale_commands()
            is_new = browser_id not in self._browsers
            reg = self._browsers.get(browser_id) or BrowserReg(browser_id=browser_id)
            prev_account = reg.account
            reg.last_seen = self._now()
            if account is not None:
                reg.account = account
            if capabilities is not None:
                reg.capabilities = list(capabilities)
            if conversation_ids is not None:
                reg.conversation_ids = set(conversation_ids)
            self._browsers[browser_id] = reg
            self._wake_pollers()
            if is_new:
                log.info(
                    "extension connected browser_id=%s account=%s caps=%s",
                    browser_id[:8],
                    reg.account or "-",
                    ",".join(reg.capabilities) or "-",
                )
            elif account is not None and account != prev_account:
                log.info(
                    "extension account updated browser_id=%s account=%s",
                    browser_id[:8],
                    reg.account or "-",
                )
            return {"ok": True, "browser_id": browser_id, "account": reg.account}

    async def heartbeat(
        self,
        browser_id: str,
        *,
        account: str | None = None,
        conversation_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        return await self.register(
            browser_id, account=account, conversation_ids=conversation_ids
        )

    def _wake_pollers(self) -> None:
        for ev in self._poll_waiters:
            ev.set()

    def _cmd_public(self, cmd: Command, *, after_seq: int = 0) -> dict[str, Any]:
        events = [e for e in cmd.events if e.get("seq", 0) > after_seq]
        return {
            "id": cmd.id,
            "kind": cmd.kind,
            "params": cmd.params,
            "status": cmd.status,
            "timeout_s": cmd.timeout_s,
            "target_browser_id": cmd.target_browser_id,
            "claimed_by": cmd.claimed_by,
            "parent_id": cmd.parent_id,
            "child_ids": list(cmd.child_ids),
            "events": events,
            "result": cmd.result,
            "error": cmd.error,
        }

    def _pick_browser(
        self,
        *,
        browser_id: str | None,
        account: str | None,
        conversation_id: str | None,
    ) -> str | None:
        self._prune_browsers()
        live = list(self._browsers.values())
        if not live:
            return None
        if browser_id:
            return browser_id if browser_id in self._browsers else None
        if account:
            matched = [b for b in live if (b.account or "").lower() == account.lower()]
            if matched:
                live = matched
        if conversation_id:
            holding = [b for b in live if conversation_id in b.conversation_ids]
            idle = [b for b in holding if not b.busy] or holding
            if idle:
                return idle[0].browser_id
        idle = [b for b in live if not b.busy] or live
        return idle[0].browser_id

    def cache_search(
        self,
        *,
        query: str | None,
        conversation_id: str | None,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        if not self._list_docs:
            return []
        q = (query or "").strip().lower()
        hits: list[dict[str, Any]] = []

        if conversation_id:
            path = f"gemini/{conversation_id}.md"
            if not path.endswith(".md"):
                path = f"gemini/{conversation_id}.md"
            # normalize id without .md
            cid = conversation_id.replace(".md", "").split("/")[-1]
            path = f"gemini/{cid}.md"
            doc = self._get_document(path) if self._get_document else None
            if not doc:
                # try list match
                for d in self._list_docs(prefix="gemini/"):
                    meta = d.get("metadata") or {}
                    if meta.get("conversation_id") == cid or d.get("path") == path:
                        doc = self._get_document(d["path"]) if self._get_document else None
                        break
            if not doc:
                return []
            meta = doc.get("metadata") or {}
            title = meta.get("title") or cid
            rows: list[dict[str, Any]] = []
            for block in doc.get("blocks") or []:
                text = block.get("text") or block.get("source") or ""
                source = block.get("source") or text
                # Parse **User** / **Gemini** style turns from markdown source
                for role, body in _iter_md_turns(source):
                    if q and q not in body.lower():
                        continue
                    rows.append(
                        {
                            "source": SearchSource.CACHE,
                            "conversation_id": cid,
                            "title": title,
                            "role": role,
                            "text": body,
                        }
                    )
            if not rows and (not q or q in (doc.get("text") or "").lower() or q in title.lower()):
                # fallback: whole blocks as messages
                for block in doc.get("blocks") or []:
                    text = (block.get("text") or "").strip()
                    if not text:
                        continue
                    if q and q not in text.lower():
                        continue
                    rows.append(
                        {
                            "source": SearchSource.CACHE,
                            "conversation_id": cid,
                            "title": title,
                            "role": "unknown",
                            "text": text,
                        }
                    )
            return rows[offset : offset + limit]

        for d in self._list_docs(prefix="gemini/"):
            meta = d.get("metadata") or {}
            cid = meta.get("conversation_id") or _cid_from_path(d.get("path") or "")
            if not cid:
                continue
            title = meta.get("title") or cid
            if q and q not in title.lower() and q not in cid.lower():
                continue
            hits.append(
                {
                    "source": SearchSource.CACHE,
                    "conversation_id": cid,
                    "title": title,
                    "path": d.get("path"),
                    "message_count": meta.get("message_count"),
                    "updated_at": meta.get("updated_at"),
                }
            )
        return hits[offset : offset + limit]

    async def enqueue(self, kind: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = dict(params or {})
        kind = normalize_command_kind(kind)
        raw_timeout = params.pop("timeout_s", None)
        if raw_timeout is None:
            raw_timeout = params.pop("timeout", None)
        # page-html defaults to a short timeout when unspecified
        if raw_timeout is None and kind == CommandKind.PAGE_HTML:
            timeout_s = clamp_timeout(60)
        else:
            timeout_s = clamp_timeout(raw_timeout)
        browser_id = params.pop("browser_id", None)
        account = params.pop("account", None)

        match kind:
            case CommandKind.QUERY:
                model = params.get("model")
                effort = params.get("effort")
                if model and ":" in str(model) and not effort:
                    m, e = parse_model_spec(str(model))
                    params["model"] = m
                    params["effort"] = e
                elif model and not effort:
                    params["effort"] = Effort.MEDIUM
                target = self._pick_browser(
                    browser_id=browser_id,
                    account=account,
                    conversation_id=params.get("conversation_id"),
                )
                if browser_id and not target:
                    raise ValueError(f"browser not connected: {browser_id}")
                if not target and not self.live_browsers():
                    raise ValueError("no extension browsers connected")
                cmd = Command(
                    id=str(uuid.uuid4()),
                    kind=kind,
                    params=params,
                    timeout_s=timeout_s,
                    target_browser_id=target or browser_id,
                    target_account=account,
                )
                async with self._lock:
                    self._commands[cmd.id] = cmd
                    await self._pending.put(cmd.id)
                    self._wake_pollers()
                log.info(
                    "command queued id=%s kind=%s target=%s",
                    cmd.id[:8],
                    kind,
                    (cmd.target_browser_id or "-")[:8],
                )
                return self._cmd_public(cmd)

            case CommandKind.LIST_MODELS | CommandKind.PAGE_HTML:
                # page-html: do not inject max_chars — content targets chat turns;
                # optional ceiling only when the client sends it.
                target = self._pick_browser(
                    browser_id=browser_id,
                    account=account,
                    conversation_id=params.get("conversation_id"),
                )
                if not target and not self.live_browsers():
                    raise ValueError("no extension browsers connected")
                cmd = Command(
                    id=str(uuid.uuid4()),
                    kind=kind,
                    params=params,
                    timeout_s=timeout_s,
                    target_browser_id=target or browser_id,
                    target_account=account,
                )
                async with self._lock:
                    self._commands[cmd.id] = cmd
                    await self._pending.put(cmd.id)
                    self._wake_pollers()
                log.info(
                    "command queued id=%s kind=%s target=%s",
                    cmd.id[:8],
                    kind,
                    (cmd.target_browser_id or "-")[:8],
                )
                return self._cmd_public(cmd)

            case CommandKind.SEARCH:
                return await self._enqueue_search(
                    params,
                    timeout_s=timeout_s,
                    browser_id=browser_id,
                    account=account,
                )

            case _:
                raise ValueError(f"unknown command kind: {kind}")

    async def _enqueue_search(
        self,
        params: dict[str, Any],
        *,
        timeout_s: int,
        browser_id: str | None,
        account: str | None,
    ) -> dict[str, Any]:
        kind = CommandKind.SEARCH
        sources = params.get("sources") or [SearchSource.CACHE, SearchSource.GEMINI_LIVE]
        if isinstance(sources, str):
            sources = [sources]
        sources = [str(s).strip().lower() for s in sources]
        params["sources"] = sources
        limit = int(params.get("limit") or 20)
        offset = int(params.get("offset") or 0)
        query = params.get("query") or params.get("q")
        conversation_id = params.get("conversation_id")

        cache_hits: list[dict[str, Any]] = []
        if SearchSource.CACHE in sources:
            cache_hits = self.cache_search(
                query=query,
                conversation_id=conversation_id,
                limit=limit,
                offset=offset,
            )

        need_live = SearchSource.GEMINI_LIVE in sources
        self._prune_browsers()
        live = list(self._browsers.values())
        if account:
            live = [b for b in live if (b.account or "").lower() == account.lower()]
        if browser_id:
            live = [b for b in live if b.browser_id == browser_id]

        if not need_live:
            cmd = Command(
                id=str(uuid.uuid4()),
                kind=kind,
                params=params,
                timeout_s=timeout_s,
                status=CommandStatus.DONE,
                result={"hits": cache_hits, "sources": sources},
                sources_cache_hits=cache_hits,
            )
            cmd.events.append(
                {
                    "seq": 1,
                    "type": EventType.DONE,
                    "payload": cmd.result,
                    "ts": time.time(),
                }
            )
            cmd.wake.set()
            async with self._lock:
                self._commands[cmd.id] = cmd
            return self._cmd_public(cmd)

        if not live:
            if cache_hits:
                cmd = Command(
                    id=str(uuid.uuid4()),
                    kind=kind,
                    params=params,
                    timeout_s=timeout_s,
                    status=CommandStatus.DONE,
                    result={
                        "hits": cache_hits,
                        "sources": sources,
                        "warning": "no live browsers; cache only",
                    },
                    sources_cache_hits=cache_hits,
                )
                cmd.events.append(
                    {
                        "seq": 1,
                        "type": EventType.DONE,
                        "payload": cmd.result,
                        "ts": time.time(),
                    }
                )
                cmd.wake.set()
                async with self._lock:
                    self._commands[cmd.id] = cmd
                return self._cmd_public(cmd)
            raise ValueError("no extension browsers connected for gemini-live search")

        parent = Command(
            id=str(uuid.uuid4()),
            kind=kind,
            params=params,
            timeout_s=timeout_s,
            status=CommandStatus.RUNNING,
            sources_cache_hits=cache_hits,
            target_account=account,
        )
        children: list[Command] = []
        for b in live:
            child = Command(
                id=str(uuid.uuid4()),
                kind=CommandKind.SEARCH,
                params={
                    **params,
                    "sources": [SearchSource.GEMINI_LIVE],
                    "_fanout": True,
                },
                timeout_s=timeout_s,
                target_browser_id=b.browser_id,
                parent_id=parent.id,
            )
            children.append(child)
            parent.child_ids.append(child.id)

        async with self._lock:
            self._commands[parent.id] = parent
            for child in children:
                self._commands[child.id] = child
                await self._pending.put(child.id)
            self._wake_pollers()
        log.info(
            "command queued id=%s kind=%s sources=%s live_browsers=%d",
            parent.id[:8],
            CommandKind.SEARCH,
            ",".join(sources),
            len(children),
        )
        return self._cmd_public(parent)

    async def poll(self, browser_id: str, *, wait_s: float = POLL_MAX_S) -> dict[str, Any] | None:
        await self.register(browser_id)
        deadline = self._now() + max(0.0, min(POLL_MAX_S, wait_s))
        while True:
            async with self._lock:
                self._reap_stale_commands()
                # Prefer targeted commands for this browser
                claimed = await self._try_claim(browser_id)
                if claimed:
                    return self._cmd_public(claimed)
            remaining = deadline - self._now()
            if remaining <= 0:
                return None
            ev = asyncio.Event()
            self._poll_waiters.append(ev)
            try:
                await asyncio.wait_for(ev.wait(), timeout=min(remaining, 1.0))
            except TimeoutError:
                pass
            finally:
                if ev in self._poll_waiters:
                    self._poll_waiters.remove(ev)

    async def _try_claim(self, browser_id: str) -> Command | None:
        # Drain pending looking for match
        skipped: list[str] = []
        found: Command | None = None
        while not self._pending.empty():
            try:
                cid = self._pending.get_nowait()
            except asyncio.QueueEmpty:
                break
            cmd = self._commands.get(cid)
            if not cmd or cmd.status != CommandStatus.PENDING:
                continue
            if cmd.target_browser_id and cmd.target_browser_id != browser_id:
                skipped.append(cid)
                continue
            if cmd.target_account:
                reg = self._browsers.get(browser_id)
                if not reg or (reg.account or "").lower() != cmd.target_account.lower():
                    skipped.append(cid)
                    continue
            cmd.status = CommandStatus.CLAIMED
            cmd.claimed_by = browser_id
            reg = self._browsers.get(browser_id)
            if reg:
                reg.busy = True
                reg.last_seen = self._now()
            found = cmd
            log.info(
                "command claimed id=%s kind=%s browser_id=%s",
                cmd.id[:8],
                cmd.kind,
                browser_id[:8],
            )
            break
        for cid in skipped:
            await self._pending.put(cid)
        return found

    async def post_event(
        self,
        command_id: str,
        *,
        type: str,
        payload: dict[str, Any] | None = None,
        seq: int | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            cmd = self._commands.get(command_id)
            if not cmd:
                raise KeyError(command_id)
            # Terminal is sticky: late done/error must not reopen cancelled/timeout
            # (or any other terminal status). Keep busy consistent with terminal.
            status_changing = type in (
                EventType.RUNNING,
                EventType.CLAIMED,
                EventType.DONE,
                EventType.ERROR,
                EventType.TIMEOUT,
                EventType.CANCELLED,
            )
            if cmd.status in TERMINAL and status_changing:
                if cmd.claimed_by and cmd.claimed_by in self._browsers:
                    self._browsers[cmd.claimed_by].busy = False
                log.info(
                    "ignoring late %s on terminal command id=%s status=%s",
                    type,
                    cmd.id[:8],
                    cmd.status,
                )
                return {
                    "ignored": True,
                    "status": cmd.status,
                    "type": type,
                    "payload": payload or {},
                }
            next_seq = (cmd.events[-1]["seq"] + 1) if cmd.events else 1
            event = {
                "seq": seq or next_seq,
                "type": type,
                "payload": payload or {},
                "ts": time.time(),
            }
            cmd.events.append(event)
            match type:
                case EventType.RUNNING | EventType.CLAIMED:
                    cmd.status = CommandStatus.RUNNING
                    if type == EventType.RUNNING and cmd.started_at is None:
                        cmd.started_at = self._now()
                case EventType.DONE | EventType.ERROR | EventType.TIMEOUT | EventType.CANCELLED:
                    cmd.status = CommandStatus(type)
                    if type == EventType.DONE:
                        cmd.result = payload or {}
                    else:
                        cmd.error = (
                            (payload or {}).get("error")
                            or (payload or {}).get("message")
                            or type
                        )
                        cmd.result = payload or {"error": cmd.error}
                    if cmd.claimed_by and cmd.claimed_by in self._browsers:
                        self._browsers[cmd.claimed_by].busy = False
                    if cmd.parent_id:
                        await self._maybe_finish_parent(cmd.parent_id)
                    cmd.wake.set()
                    err = cmd.error or (payload or {}).get("error")
                    log.info(
                        "command %s id=%s kind=%s%s",
                        type,
                        cmd.id[:8],
                        cmd.kind,
                        f" error={err}" if err else "",
                    )
                case EventType.DELTA:
                    pass
                case _:
                    log.info("command event id=%s type=%s", cmd.id[:8], type)
            return event

    async def _maybe_finish_parent(self, parent_id: str) -> None:
        parent = self._commands.get(parent_id)
        if not parent or parent.status in TERMINAL:
            return
        children = [self._commands[cid] for cid in parent.child_ids if cid in self._commands]
        if not children or any(c.status not in TERMINAL for c in children):
            return
        hits = list(parent.sources_cache_hits)
        seen: set[tuple[Any, ...]] = set()
        for h in hits:
            key = (h.get("source"), h.get("conversation_id"), h.get("text"), h.get("role"))
            seen.add(key)
        for c in children:
            live_hits = (c.result or {}).get("hits") or []
            for h in live_hits:
                row = {
                    **h,
                    "source": h.get("source") or SearchSource.GEMINI_LIVE,
                    "browser_id": c.claimed_by,
                }
                key = (
                    row.get("source"),
                    row.get("account"),
                    row.get("conversation_id"),
                    row.get("text"),
                    row.get("role"),
                )
                if key in seen:
                    continue
                seen.add(key)
                hits.append(row)
        limit = int(parent.params.get("limit") or 20)
        offset = int(parent.params.get("offset") or 0)
        # Children already paginated locally; for fan-out re-slice merged
        sliced = hits[offset : offset + limit] if not parent.sources_cache_hits else hits[: limit]
        # Prefer: cache already offset; live may duplicate — keep simple slice of merged
        if parent.sources_cache_hits and any(
            (c.result or {}).get("hits") for c in children
        ):
            # re-apply offset/limit on full merge excluding double-counting
            sliced = hits[offset : offset + limit]
        parent.result = {
            "hits": sliced,
            "sources": parent.params.get("sources"),
            "browsers": [c.claimed_by for c in children],
        }
        parent.status = CommandStatus.DONE
        parent.events.append(
            {
                "seq": len(parent.events) + 1,
                "type": EventType.DONE,
                "payload": parent.result,
                "ts": time.time(),
            }
        )
        parent.wake.set()

    def get(self, command_id: str, *, after_seq: int = 0) -> dict[str, Any] | None:
        cmd = self._commands.get(command_id)
        if not cmd:
            return None
        return self._cmd_public(cmd, after_seq=after_seq)

    async def cancel(self, command_id: str, *, reason: str = "cancelled by client") -> dict[str, Any]:
        """Mark a non-terminal command cancelled and free the browser busy flag."""
        async with self._lock:
            cmd = self._commands.get(command_id)
            if not cmd:
                raise KeyError(command_id)
            if cmd.status in TERMINAL:
                return self._cmd_public(cmd)
            cmd.status = CommandStatus.CANCELLED
            cmd.error = reason
            cmd.result = {"error": reason, "cancelled": True}
            cmd.events.append(
                {
                    "seq": len(cmd.events) + 1,
                    "type": EventType.CANCELLED,
                    "payload": cmd.result,
                    "ts": time.time(),
                }
            )
            if cmd.claimed_by and cmd.claimed_by in self._browsers:
                self._browsers[cmd.claimed_by].busy = False
            if cmd.parent_id:
                await self._maybe_finish_parent(cmd.parent_id)
            cmd.wake.set()
            log.info("command cancelled id=%s kind=%s", cmd.id[:8], cmd.kind)
            return self._cmd_public(cmd)

    async def wait(self, command_id: str, *, timeout_s: float | None = None) -> dict[str, Any]:
        cmd = self._commands.get(command_id)
        if not cmd:
            raise KeyError(command_id)
        # Enforce command timeout from started_at (or created_at + claim grace)
        remaining_cmd = cmd.timeout_s - self._cmd_age_s(cmd)
        wait_budget = timeout_s if timeout_s is not None else max(1.0, remaining_cmd + 5)
        wait_budget = min(wait_budget, max(1.0, remaining_cmd + 5))

        while cmd.status not in TERMINAL:
            left = cmd.timeout_s - self._cmd_age_s(cmd)
            if left <= 0:
                async with self._lock:
                    if cmd.status not in TERMINAL:
                        cmd.status = CommandStatus.TIMEOUT
                        cmd.error = "command timed out"
                        cmd.result = {"error": "command timed out"}
                        cmd.events.append(
                            {
                                "seq": len(cmd.events) + 1,
                                "type": EventType.TIMEOUT,
                                "payload": cmd.result,
                                "ts": time.time(),
                            }
                        )
                        if cmd.claimed_by and cmd.claimed_by in self._browsers:
                            self._browsers[cmd.claimed_by].busy = False
                        if cmd.parent_id:
                            await self._maybe_finish_parent(cmd.parent_id)
                        cmd.wake.set()
                break
            try:
                await asyncio.wait_for(cmd.wake.wait(), timeout=min(1.0, left, wait_budget))
            except TimeoutError:
                wait_budget -= 1.0
                if wait_budget <= 0 and cmd.status not in TERMINAL:
                    break
                cmd.wake.clear()
                continue
            cmd.wake.clear()
        return self._cmd_public(cmd)


_TURN_RE = re.compile(
    r"(?m)^\*\*(User|Gemini)\*\*(?:\s*\([^)]*\))?:\s*\n+([\s\S]*?)(?=^\*\*(?:User|Gemini)\*\*|\Z)"
)


def _iter_md_turns(source: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for m in _TURN_RE.finditer(source or ""):
        role = m.group(1).lower()
        if role == "gemini":
            role = "gemini"
        body = m.group(2).strip()
        if body:
            out.append((role, body))
    return out


def _cid_from_path(path: str) -> str | None:
    m = re.search(r"gemini/([^/]+)\.md$", path or "")
    return m.group(1) if m else None
