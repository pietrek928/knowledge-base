"""CLI client for Gemini remote commands via the knowledge-base server."""

from __future__ import annotations

import json
import random
import signal
import sys
import time
from typing import Any

import click
import httpx

from knowledge_base.ext_broker import parse_model_spec
from knowledge_base.ext_protocol import (
    TERMINAL_STATUSES,
    CommandKind,
    CommandStatus,
    EventType,
    SearchSource,
)

DEFAULT_URL = "http://127.0.0.1:8080"
TERMINAL = TERMINAL_STATUSES
_FAIL_STATUSES = frozenset(
    {CommandStatus.ERROR, CommandStatus.TIMEOUT, CommandStatus.CANCELLED}
)


def _gauss_sleep(mean: float, sigma: float, lo: float, hi: float) -> None:
    """Sleep a clamped Gaussian duration (no flat constant waits)."""
    t = max(lo, min(hi, random.gauss(mean, sigma)))
    time.sleep(t)


def _client(url: str) -> httpx.Client:
    return httpx.Client(base_url=url.rstrip("/"), timeout=httpx.Timeout(650.0, connect=10.0))


def _enqueue(client: httpx.Client, kind: CommandKind | str, params: dict[str, Any]) -> dict[str, Any]:
    r = client.post("/ext/commands", json={"kind": kind, "params": params})
    if r.status_code >= 400:
        raise click.ClickException(r.text or f"HTTP {r.status_code}")
    return r.json()


def _echo_json(obj: Any) -> None:
    """Print one JSON line; ignore BrokenPipe (early tee/close)."""
    try:
        click.echo(json.dumps(obj, ensure_ascii=False))
    except BrokenPipeError:
        return
    except OSError as e:
        if getattr(e, "errno", None) == 32:  # EPIPE
            return
        raise


def _cancel(client: httpx.Client, command_id: str) -> None:
    try:
        client.post(f"/ext/commands/{command_id}/cancel")
    except Exception:
        pass


def _wait_stream(
    client: httpx.Client,
    command_id: str,
    *,
    print_events: bool = True,
) -> dict[str, Any]:
    after = 0
    last: dict[str, Any] | None = None
    cancelled = {"flag": False}

    def _on_cancel(signum: int, frame: Any) -> None:  # noqa: ARG001
        cancelled["flag"] = True
        _cancel(client, command_id)

    prev_int = signal.signal(signal.SIGINT, _on_cancel)
    prev_term = None
    if hasattr(signal, "SIGTERM"):
        prev_term = signal.signal(signal.SIGTERM, _on_cancel)
    try:
        while True:
            if cancelled["flag"]:
                # Give broker a moment to mark cancelled; then return current state.
                _gauss_sleep(0.32, 0.08, 0.12, 0.6)
                r = client.get(f"/ext/commands/{command_id}")
                if r.is_success:
                    last = r.json()
                    if last.get("status") in TERMINAL:
                        return last
                _cancel(client, command_id)
                r2 = client.get(f"/ext/commands/{command_id}")
                if r2.is_success:
                    return r2.json()
                return {
                    "id": command_id,
                    "status": CommandStatus.CANCELLED,
                    "error": "cancelled by client",
                    "result": {"error": "cancelled by client", "cancelled": True},
                }

            r = client.get(f"/ext/commands/{command_id}/wait", params={"timeout_s": 30})
            if r.status_code == 404:
                raise click.ClickException("command not found")
            r.raise_for_status()
            last = r.json()
            # Refetch with cursor for incremental print
            r2 = client.get(f"/ext/commands/{command_id}", params={"after_seq": after})
            if r2.is_success:
                for ev in r2.json().get("events") or []:
                    after = max(after, int(ev.get("seq") or 0))
                    if print_events:
                        _echo_json(ev)
            status = last.get("status")
            if status in TERMINAL:
                return last
            _gauss_sleep(0.22, 0.06, 0.08, 0.45)
    finally:
        signal.signal(signal.SIGINT, prev_int)
        if prev_term is not None and hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, prev_term)


def _store_path_hint(logical_path: str) -> str:
    """Logical gemini/{id}.md → on-disk content/{path}.json under data_dir."""
    safe = str(logical_path or "").lstrip("/")
    return f"content/{safe}.json"


@click.group()
@click.option("--url", default=DEFAULT_URL, show_default=True, envvar="KB_URL")
@click.pass_context
def main(ctx: click.Context, url: str) -> None:
    """Remote-control Gemini via a running knowledge-base server + extension."""
    ctx.ensure_object(dict)
    ctx.obj["url"] = url


@main.command("browsers")
@click.pass_context
def browsers_cmd(ctx: click.Context) -> None:
    """List connected extension browsers."""
    with _client(ctx.obj["url"]) as client:
        r = client.get("/ext/browsers")
        r.raise_for_status()
        click.echo(json.dumps(r.json(), indent=2, ensure_ascii=False))


@main.command("query")
@click.argument("text")
@click.option("--conversation-id", default=None)
@click.option(
    "--model",
    default=None,
    help="Exact unlocked picker label; optionally LABEL:effort (effort only if list-models shows it).",
)
@click.option("--timeout", "timeout_s", default=180, type=int, show_default=True)
@click.option("--browser-id", default=None)
@click.option("--account", default=None)
@click.option(
    "--final-json",
    is_flag=True,
    default=False,
    help="Print one JSON object (terminal command blob) instead of NDJSON events.",
)
@click.pass_context
def query_cmd(
    ctx: click.Context,
    text: str,
    conversation_id: str | None,
    model: str | None,
    timeout_s: int,
    browser_id: str | None,
    account: str | None,
    final_json: bool,
) -> None:
    """Post a message in a Gemini thread and stream events until generation ends."""
    params: dict[str, Any] = {"text": text, "timeout_s": timeout_s}
    if conversation_id:
        params["conversation_id"] = conversation_id
    if model:
        m, effort = parse_model_spec(model)
        params["model"] = m
        params["effort"] = effort
    if browser_id:
        params["browser_id"] = browser_id
    if account:
        params["account"] = account

    with _client(ctx.obj["url"]) as client:
        cmd = _enqueue(client, CommandKind.QUERY, params)
        result = _wait_stream(client, cmd["id"], print_events=not final_json)
    if final_json:
        click.echo(json.dumps(result, indent=2, ensure_ascii=False))
    status = result.get("status")
    if status in _FAIL_STATUSES:
        raise SystemExit(1)
    # Surface model auto-switch clearly on stderr summary
    payload = result.get("result") or {}
    if payload.get(EventType.MODEL_CHANGED):
        try:
            click.echo(
                f"# {EventType.MODEL_CHANGED} requested={payload.get('model_requested')} "
                f"actual={payload.get('model_actual')}",
                err=True,
            )
        except BrokenPipeError:
            pass


@main.command("list-models")
@click.option("--conversation-id", default=None)
@click.option("--browser-id", default=None)
@click.option("--account", default=None)
@click.option("--timeout", "timeout_s", default=60, type=int, show_default=True)
@click.pass_context
def list_models_cmd(
    ctx: click.Context,
    conversation_id: str | None,
    browser_id: str | None,
    account: str | None,
    timeout_s: int,
) -> None:
    """List unlocked Gemini models/efforts from the live picker."""
    params: dict[str, Any] = {"timeout_s": timeout_s}
    if conversation_id:
        params["conversation_id"] = conversation_id
    if browser_id:
        params["browser_id"] = browser_id
    if account:
        params["account"] = account

    with _client(ctx.obj["url"]) as client:
        cmd = _enqueue(client, CommandKind.LIST_MODELS, params)
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in _FAIL_STATUSES:
        click.echo(json.dumps(result, indent=2, ensure_ascii=False), err=True)
        raise SystemExit(1)
    body = result.get("result") or {}
    models = body.get("models")
    out: dict[str, Any] = {
        "models": models if models is not None else body,
        "locked": body.get("locked") or [],
        "account": body.get("account"),
        "conversation_id": body.get("conversation_id"),
    }
    # Scrape hint only — not permission; agents must use models[].efforts.
    # Prefer top-level; fall back to debug when content.js hasn't been reloaded yet.
    thinking = body.get("thinking_levels")
    if thinking is None and isinstance(body.get("debug"), dict):
        thinking = body["debug"].get("thinking_levels")
    if thinking is not None:
        out["thinking_levels"] = thinking
    if body.get("debug") is not None:
        out["debug"] = body.get("debug")
    click.echo(json.dumps(out, indent=2, ensure_ascii=False))


@main.command("page-html")
@click.option("--conversation-id", default=None)
@click.option("--selector", default=None, help="CSS selector; default = full documentElement.")
@click.option("--max-chars", default=200_000, show_default=True, type=int)
@click.option("-o", "--out", "out_path", default=None, type=click.Path(dir_okay=False), help="Write HTML to file.")
@click.option("--browser-id", default=None)
@click.option("--account", default=None)
@click.option("--timeout", "timeout_s", default=60, type=int, show_default=True)
@click.pass_context
def page_html_cmd(
    ctx: click.Context,
    conversation_id: str | None,
    selector: str | None,
    max_chars: int,
    out_path: str | None,
    browser_id: str | None,
    account: str | None,
    timeout_s: int,
) -> None:
    """Dump live Gemini page HTML for debugging (selector-scoped optional)."""
    params: dict[str, Any] = {"timeout_s": timeout_s, "max_chars": max_chars}
    if conversation_id:
        params["conversation_id"] = conversation_id
    if selector:
        params["selector"] = selector
    if browser_id:
        params["browser_id"] = browser_id
    if account:
        params["account"] = account

    with _client(ctx.obj["url"]) as client:
        cmd = _enqueue(client, CommandKind.PAGE_HTML, params)
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in _FAIL_STATUSES:
        click.echo(json.dumps(result, indent=2, ensure_ascii=False), err=True)
        raise SystemExit(1)
    payload = dict(result.get("result") or {})
    html = payload.pop("html", "") or ""
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        payload["out"] = out_path
        payload["html_chars"] = len(html)
        click.echo(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        payload["html"] = html
        click.echo(json.dumps(payload, indent=2, ensure_ascii=False))


@main.command("search")
@click.option(
    "--source",
    "sources",
    multiple=True,
    type=click.Choice([s.value for s in SearchSource], case_sensitive=False),
    help="Repeatable. Default: both.",
)
@click.option("-q", "--query", default=None)
@click.option("--conversation-id", default=None, help="If set, search messages in that thread.")
@click.option("--limit", default=20, show_default=True, type=int)
@click.option("--offset", default=0, show_default=True, type=int)
@click.option("--account", default=None)
@click.option("--browser-id", default=None)
@click.option("--timeout", "timeout_s", default=120, type=int, show_default=True)
@click.pass_context
def search_cmd(
    ctx: click.Context,
    sources: tuple[str, ...],
    query: str | None,
    conversation_id: str | None,
    limit: int,
    offset: int,
    account: str | None,
    browser_id: str | None,
    timeout_s: int,
) -> None:
    """Search conversations (or messages when --conversation-id is set)."""
    params: dict[str, Any] = {
        "limit": limit,
        "offset": offset,
        "timeout_s": timeout_s,
        "sources": list(sources)
        if sources
        else [SearchSource.CACHE, SearchSource.GEMINI_LIVE],
    }
    if query:
        params["query"] = query
    if conversation_id:
        params["conversation_id"] = conversation_id
    if account:
        params["account"] = account
    if browser_id:
        params["browser_id"] = browser_id

    with _client(ctx.obj["url"]) as client:
        cmd = _enqueue(client, CommandKind.SEARCH, params)
        # Cache-only may already be done
        if cmd.get("status") in TERMINAL:
            body = cmd.get("result") or cmd
            _annotate_store_paths(body)
            click.echo(json.dumps(body, indent=2, ensure_ascii=False))
            if cmd.get("status") in _FAIL_STATUSES:
                raise SystemExit(1)
            return
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in _FAIL_STATUSES:
        click.echo(json.dumps(result, indent=2, ensure_ascii=False), err=True)
        raise SystemExit(1)
    body = result.get("result") or result
    _annotate_store_paths(body)
    click.echo(json.dumps(body, indent=2, ensure_ascii=False))


@main.command("conversations")
@click.option("--prefix", default="gemini/", show_default=True, help="Document path prefix.")
@click.option("--limit", default=50, show_default=True, type=int)
@click.option("--offset", default=0, show_default=True, type=int)
@click.pass_context
def conversations_cmd(
    ctx: click.Context,
    prefix: str,
    limit: int,
    offset: int,
) -> None:
    """List cached Gemini conversations from the KB store (not live browser)."""
    with _client(ctx.obj["url"]) as client:
        r = client.get("/docs", params={"prefix": prefix})
        r.raise_for_status()
        docs = r.json().get("docs") or []
    rows = []
    for d in docs[offset : offset + limit]:
        path = d.get("path") or ""
        meta = d.get("metadata") or {}
        cid = meta.get("conversation_id")
        if not cid and path.startswith("gemini/") and path.endswith(".md"):
            cid = path[len("gemini/") : -len(".md")]
        rows.append(
            {
                "conversation_id": cid,
                "title": meta.get("title"),
                "path": path,
                "store_path": _store_path_hint(path),
                "content_fingerprint": meta.get("content_fingerprint"),
                "block_count": d.get("block_count"),
                "ingest": meta.get("ingest"),
            }
        )
    click.echo(
        json.dumps(
            {
                "conversations": rows,
                "count": len(rows),
                "total": len(docs),
                "note": "Logical path is gemini/{id}.md; on disk under data_dir as content/{path}.json (e.g. ~/.kb/content/gemini/{id}.md.json).",
            },
            indent=2,
            ensure_ascii=False,
        )
    )


def _annotate_store_paths(body: dict[str, Any]) -> None:
    hits = body.get("hits")
    if not isinstance(hits, list):
        return
    for h in hits:
        if isinstance(h, dict) and h.get("path") and "store_path" not in h:
            h["store_path"] = _store_path_hint(h["path"])


if __name__ == "__main__":
    try:
        main(obj={})
    except BrokenPipeError:
        # Downstream closed stdout (e.g. head/tee); exit quietly.
        try:
            sys.stdout.close()
        except Exception:
            pass
        raise SystemExit(0)
