"""CLI client for Gemini remote commands via the knowledge-base server."""

from __future__ import annotations

import json
import time
from typing import Any

import click
import httpx

from knowledge_base.ext_broker import parse_model_spec

DEFAULT_URL = "http://127.0.0.1:8080"
TERMINAL = frozenset({"done", "error", "timeout"})


def _client(url: str) -> httpx.Client:
    return httpx.Client(base_url=url.rstrip("/"), timeout=httpx.Timeout(650.0, connect=10.0))


def _enqueue(client: httpx.Client, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    r = client.post("/ext/commands", json={"kind": kind, "params": params})
    if r.status_code >= 400:
        raise click.ClickException(r.text or f"HTTP {r.status_code}")
    return r.json()


def _wait_stream(client: httpx.Client, command_id: str, *, print_events: bool = True) -> dict[str, Any]:
    after = 0
    last: dict[str, Any] | None = None
    while True:
        r = client.get(f"/ext/commands/{command_id}/wait", params={"timeout_s": 30})
        if r.status_code == 404:
            raise click.ClickException("command not found")
        r.raise_for_status()
        last = r.json()
        events = last.get("events") or []
        # Refetch with cursor for incremental print
        r2 = client.get(f"/ext/commands/{command_id}", params={"after_seq": after})
        if r2.is_success:
            for ev in r2.json().get("events") or []:
                after = max(after, int(ev.get("seq") or 0))
                if print_events:
                    click.echo(json.dumps(ev, ensure_ascii=False))
        status = last.get("status")
        if status in TERMINAL:
            return last
        time.sleep(0.2)


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
    help="Model id, optionally MODEL:EFFORT (effort defaults to medium).",
)
@click.option("--timeout", "timeout_s", default=180, type=int, show_default=True)
@click.option("--browser-id", default=None)
@click.option("--account", default=None)
@click.pass_context
def query_cmd(
    ctx: click.Context,
    text: str,
    conversation_id: str | None,
    model: str | None,
    timeout_s: int,
    browser_id: str | None,
    account: str | None,
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
        cmd = _enqueue(client, "query", params)
        result = _wait_stream(client, cmd["id"])
    status = result.get("status")
    if status in ("error", "timeout"):
        raise SystemExit(1)
    # Surface model auto-switch clearly on stderr summary
    payload = result.get("result") or {}
    if payload.get("model_changed"):
        click.echo(
            f"# model_changed requested={payload.get('model_requested')} "
            f"actual={payload.get('model_actual')}",
            err=True,
        )


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
        cmd = _enqueue(client, "list-models", params)
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in ("error", "timeout"):
        click.echo(json.dumps(result, indent=2, ensure_ascii=False), err=True)
        raise SystemExit(1)
    body = result.get("result") or {}
    models = body.get("models")
    out: dict[str, Any] = {
        "models": models if models is not None else body,
        "account": body.get("account"),
        "conversation_id": body.get("conversation_id"),
    }
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
        cmd = _enqueue(client, "page-html", params)
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in ("error", "timeout"):
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
    type=click.Choice(["cache", "gemini-live"], case_sensitive=False),
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
        "sources": list(sources) if sources else ["cache", "gemini-live"],
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
        cmd = _enqueue(client, "search", params)
        # Cache-only may already be done
        if cmd.get("status") in TERMINAL:
            click.echo(json.dumps(cmd.get("result") or cmd, indent=2, ensure_ascii=False))
            if cmd.get("status") in ("error", "timeout"):
                raise SystemExit(1)
            return
        result = _wait_stream(client, cmd["id"], print_events=False)
    if result.get("status") in ("error", "timeout"):
        click.echo(json.dumps(result, indent=2, ensure_ascii=False), err=True)
        raise SystemExit(1)
    click.echo(json.dumps(result.get("result") or result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main(obj={})
