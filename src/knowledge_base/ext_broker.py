"""In-memory extension command broker (register / poll / events / wait)."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger(__name__)

BROWSER_TTL_S = 60.0
POLL_MAX_S = 25.0
DEFAULT_QUERY_TIMEOUT_S = 180
MIN_TIMEOUT_S = 10
MAX_TIMEOUT_S = 600
TERMINAL = frozenset({"done", "error", "timeout"})


def clamp_timeout(v: Any, default: int = DEFAULT_QUERY_TIMEOUT_S) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return max(MIN_TIMEOUT_S, min(MAX_TIMEOUT_S, n))


def parse_model_spec(spec: str | None) -> tuple[str | None, str | None]:
    """Parse `model` or `model:effort` (default effort medium when model set)."""
    if not spec or not str(spec).strip():
        return None, None
    raw = str(spec).strip()
    if ":" in raw:
        model, effort = raw.rsplit(":", 1)
        model, effort = model.strip(), effort.strip() or "medium"
        return model or None, effort
    return raw, "medium"


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
    status: str = "pending"  # pending|claimed|running|done|error|timeout
    created_at: float = field(default_factory=time.monotonic)
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

    def _reap_stale_commands(self) -> None:
        """Mark timed-out commands and free busy browsers (even if no client is waiting)."""
        now = self._now()
        for cmd in list(self._commands.values()):
            if cmd.status in TERMINAL:
                continue
            if now - cmd.created_at < cmd.timeout_s:
                continue
            cmd.status = "timeout"
            cmd.error = "command timed out"
            cmd.result = {"error": "command timed out"}
            cmd.events.append(
                {
                    "seq": len(cmd.events) + 1,
                    "type": "timeout",
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
                            "source": "cache",
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
                            "source": "cache",
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
                    "source": "cache",
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
        kind = kind.strip().lower().replace("_", "-")
        raw_timeout = params.pop("timeout_s", None)
        if raw_timeout is None:
            raw_timeout = params.pop("timeout", None)
        # page-html defaults to a short timeout when unspecified
        if raw_timeout is None and kind == "page-html":
            timeout_s = clamp_timeout(60)
        else:
            timeout_s = clamp_timeout(raw_timeout)
        browser_id = params.pop("browser_id", None)
        account = params.pop("account", None)

        if kind == "query":
            model = params.get("model")
            effort = params.get("effort")
            if model and ":" in str(model) and not effort:
                m, e = parse_model_spec(str(model))
                params["model"] = m
                params["effort"] = e
            elif model and not effort:
                params["effort"] = "medium"
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

        if kind in ("list-models", "page-html"):
            if kind == "page-html" and params.get("max_chars") is None:
                params["max_chars"] = 200_000
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

        if kind == "search":
            sources = params.get("sources") or ["cache", "gemini-live"]
            if isinstance(sources, str):
                sources = [sources]
            sources = [str(s).strip().lower() for s in sources]
            params["sources"] = sources
            limit = int(params.get("limit") or 20)
            offset = int(params.get("offset") or 0)
            query = params.get("query") or params.get("q")
            conversation_id = params.get("conversation_id")

            cache_hits: list[dict[str, Any]] = []
            if "cache" in sources:
                cache_hits = self.cache_search(
                    query=query,
                    conversation_id=conversation_id,
                    limit=limit,
                    offset=offset,
                )

            need_live = "gemini-live" in sources
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
                    status="done",
                    result={"hits": cache_hits, "sources": sources},
                    sources_cache_hits=cache_hits,
                )
                cmd.events.append(
                    {"seq": 1, "type": "done", "payload": cmd.result, "ts": time.time()}
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
                        status="done",
                        result={
                            "hits": cache_hits,
                            "sources": sources,
                            "warning": "no live browsers; cache only",
                        },
                        sources_cache_hits=cache_hits,
                    )
                    cmd.events.append(
                        {"seq": 1, "type": "done", "payload": cmd.result, "ts": time.time()}
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
                status="running",
                sources_cache_hits=cache_hits,
                target_account=account,
            )
            children: list[Command] = []
            for b in live:
                child = Command(
                    id=str(uuid.uuid4()),
                    kind="search",
                    params={
                        **params,
                        "sources": ["gemini-live"],
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
                "command queued id=%s kind=search sources=%s live_browsers=%d",
                parent.id[:8],
                ",".join(sources),
                len(children),
            )
            return self._cmd_public(parent)

        raise ValueError(f"unknown command kind: {kind}")

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
            if not cmd or cmd.status != "pending":
                continue
            if cmd.target_browser_id and cmd.target_browser_id != browser_id:
                skipped.append(cid)
                continue
            if cmd.target_account:
                reg = self._browsers.get(browser_id)
                if not reg or (reg.account or "").lower() != cmd.target_account.lower():
                    skipped.append(cid)
                    continue
            cmd.status = "claimed"
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
            next_seq = (cmd.events[-1]["seq"] + 1) if cmd.events else 1
            event = {
                "seq": seq or next_seq,
                "type": type,
                "payload": payload or {},
                "ts": time.time(),
            }
            cmd.events.append(event)
            if type in ("running", "claimed"):
                cmd.status = "running"
            if type in TERMINAL:
                cmd.status = type
                if type == "done":
                    cmd.result = payload or {}
                elif type in ("error", "timeout"):
                    cmd.error = (payload or {}).get("error") or (payload or {}).get("message") or type
                    cmd.result = payload or {}
                if cmd.claimed_by and cmd.claimed_by in self._browsers:
                    self._browsers[cmd.claimed_by].busy = False
                # Merge parent search when all children terminal
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
            elif type not in ("delta",):
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
                row = {**h, "source": h.get("source") or "gemini-live", "browser_id": c.claimed_by}
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
        parent.status = "done"
        parent.events.append(
            {"seq": len(parent.events) + 1, "type": "done", "payload": parent.result, "ts": time.time()}
        )
        parent.wake.set()

    def get(self, command_id: str, *, after_seq: int = 0) -> dict[str, Any] | None:
        cmd = self._commands.get(command_id)
        if not cmd:
            return None
        return self._cmd_public(cmd, after_seq=after_seq)

    async def wait(self, command_id: str, *, timeout_s: float | None = None) -> dict[str, Any]:
        cmd = self._commands.get(command_id)
        if not cmd:
            raise KeyError(command_id)
        # Also enforce command timeout from creation
        remaining_cmd = cmd.timeout_s - (self._now() - cmd.created_at)
        wait_budget = timeout_s if timeout_s is not None else max(1.0, remaining_cmd + 5)
        wait_budget = min(wait_budget, max(1.0, remaining_cmd + 5))

        while cmd.status not in TERMINAL:
            left = cmd.timeout_s - (self._now() - cmd.created_at)
            if left <= 0:
                async with self._lock:
                    if cmd.status not in TERMINAL:
                        cmd.status = "timeout"
                        cmd.error = "command timed out"
                        cmd.result = {"error": "command timed out"}
                        cmd.events.append(
                            {
                                "seq": len(cmd.events) + 1,
                                "type": "timeout",
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
