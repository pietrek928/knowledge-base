import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from knowledge_base.app import create_app
from knowledge_base.ext_broker import ExtBroker, parse_model_spec


def test_parse_model_spec():
    assert parse_model_spec(None) == (None, None)
    assert parse_model_spec("gemini-2.5-pro") == ("gemini-2.5-pro", "medium")
    assert parse_model_spec("gemini-2.5-pro:high") == ("gemini-2.5-pro", "high")


@pytest.mark.asyncio
async def test_broker_page_html_enqueue_defaults():
    broker = ExtBroker()
    await broker.register("b1", account="a@x.com")
    cmd = await broker.enqueue("page-html", {"selector": "body"})
    assert cmd["kind"] == "page-html"
    assert cmd["timeout_s"] == 60
    assert cmd["params"].get("max_chars") == 200_000
    assert cmd["params"].get("selector") == "body"
    assert cmd["status"] == "pending"


@pytest.mark.asyncio
async def test_broker_register_poll_events():
    broker = ExtBroker()
    with pytest.raises(ValueError):
        await broker.enqueue("query", {"text": "hi"})

    await broker.register("b1", account="a@x.com")
    browsers = broker.live_browsers()
    assert len(browsers) == 1
    assert browsers[0]["account"] == "a@x.com"

    cmd = await broker.enqueue("query", {"text": "hello", "timeout_s": 30})
    assert cmd["status"] == "pending"

    polled = await broker.poll("b1", wait_s=1)
    assert polled is not None
    assert polled["id"] == cmd["id"]
    assert polled["status"] == "claimed"

    await broker.post_event(cmd["id"], type="submitted", payload={})
    await broker.post_event(
        cmd["id"], type="done", payload={"conversation_id": "abc", "turns": []}
    )
    waited = await broker.wait(cmd["id"], timeout_s=5)
    assert waited["status"] == "done"
    assert waited["result"]["conversation_id"] == "abc"


@pytest.mark.asyncio
async def test_broker_cancel_clears_busy():
    broker = ExtBroker()
    await broker.register("b1", account="a@x.com")
    cmd = await broker.enqueue("query", {"text": "hello", "timeout_s": 60})
    polled = await broker.poll("b1", wait_s=1)
    assert polled is not None
    assert broker.live_browsers()[0]["busy"] is True

    cancelled = await broker.cancel(cmd["id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["result"]["cancelled"] is True
    assert broker.live_browsers()[0]["busy"] is False

    # Idempotent on already-terminal
    again = await broker.cancel(cmd["id"])
    assert again["status"] == "cancelled"


@pytest.mark.asyncio
async def test_ext_cancel_http(tmp_path):
    cfg = {
        "data_dir": str(tmp_path / "kb-cancel"),
        "models": [],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.5, "fuzzy": 0.2, "bm25": 0.3, "embed": 0.0},
        "rrf_k": 60,
        "adaptive_fusion": False,
        "rescore_multiplier": 2,
        "candidate_k": 5,
        "bm25": {"k1": 0.9, "b": 0.75},
        "sibling_window": 0,
        "sibling_base": 0.0,
        "complement_bonus": 0.0,
        "cross_signal_bonus": 0.0,
        "sibling_inject_max": 0,
        "identifier_fast_path": True,
        "min_confidence": None,
        "date": {"half_life_days": 30, "weight": 0.0},
        "query_cache_size": 4,
        "metadata_max_bytes": 4096,
        "ollama": {
            "enabled": False,
            "base_url": "http://127.0.0.1:9",
            "keep_alive": "1m",
            "timeout_s": 1,
            "batch_size": 1,
        },
    }
    app = create_app(cfg, fake_ollama=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post("/ext/register", json={"browser_id": "ext-c", "account": "u@x.com"})
        r = await client.post(
            "/ext/commands",
            json={"kind": "query", "params": {"text": "hi", "timeout_s": 60}},
        )
        cmd_id = r.json()["id"]
        poll = await client.get("/ext/poll", params={"browser_id": "ext-c", "wait_s": 2})
        assert poll.status_code == 200
        busy = await client.get("/ext/browsers")
        assert any(b["busy"] for b in busy.json()["browsers"])
        c = await client.post(f"/ext/commands/{cmd_id}/cancel")
        assert c.status_code == 200
        assert c.json()["status"] == "cancelled"
        busy2 = await client.get("/ext/browsers")
        assert all(not b["busy"] for b in busy2.json()["browsers"])


@pytest.mark.asyncio
async def test_broker_cache_search_only(tmp_path):
    cfg = {
        "data_dir": str(tmp_path / "kb"),
        "models": [],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.5, "fuzzy": 0.2, "bm25": 0.3, "embed": 0.0},
        "rrf_k": 60,
        "adaptive_fusion": False,
        "rescore_multiplier": 2,
        "candidate_k": 5,
        "bm25": {"k1": 0.9, "b": 0.75},
        "sibling_window": 0,
        "sibling_base": 0.0,
        "complement_bonus": 0.0,
        "cross_signal_bonus": 0.0,
        "sibling_inject_max": 0,
        "identifier_fast_path": True,
        "min_confidence": None,
        "date": {"half_life_days": 30, "weight": 0.0},
        "query_cache_size": 4,
        "metadata_max_bytes": 4096,
        "ollama": {"enabled": False, "base_url": "http://127.0.0.1:9", "keep_alive": "1m", "timeout_s": 1, "batch_size": 1},
    }
    app = create_app(cfg, fake_ollama=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/ingest/gemini",
            json={
                "conversation_id": "aabbccddeeff0011",
                "title": "Parallel Module",
                "ingest": "extension",
                "turns": [
                    {"role": "user", "text": "explain batch_size"},
                    {"role": "gemini", "text": "batch_size controls throughput"},
                ],
            },
        )
        r = await client.post(
            "/ext/commands",
            json={
                "kind": "search",
                "params": {"sources": ["cache"], "query": "Parallel", "limit": 10},
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "done"
        hits = body["result"]["hits"]
        assert any(h["conversation_id"] == "aabbccddeeff0011" for h in hits)

        r = await client.post(
            "/ext/commands",
            json={
                "kind": "search",
                "params": {
                    "sources": ["cache"],
                    "conversation_id": "aabbccddeeff0011",
                    "query": "batch_size",
                    "limit": 10,
                },
            },
        )
        assert r.status_code == 200
        msg_hits = r.json()["result"]["hits"]
        assert msg_hits
        assert any("batch_size" in (h.get("text") or "") for h in msg_hits)


@pytest.mark.asyncio
async def test_ext_query_roundtrip_simulated(tmp_path):
    cfg = {
        "data_dir": str(tmp_path / "kb2"),
        "models": [],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.5, "fuzzy": 0.2, "bm25": 0.3, "embed": 0.0},
        "rrf_k": 60,
        "adaptive_fusion": False,
        "rescore_multiplier": 2,
        "candidate_k": 5,
        "bm25": {"k1": 0.9, "b": 0.75},
        "sibling_window": 0,
        "sibling_base": 0.0,
        "complement_bonus": 0.0,
        "cross_signal_bonus": 0.0,
        "sibling_inject_max": 0,
        "identifier_fast_path": True,
        "min_confidence": None,
        "date": {"half_life_days": 30, "weight": 0.0},
        "query_cache_size": 4,
        "metadata_max_bytes": 4096,
        "ollama": {"enabled": False, "base_url": "http://127.0.0.1:9", "keep_alive": "1m", "timeout_s": 1, "batch_size": 1},
    }
    app = create_app(cfg, fake_ollama=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/ext/register",
            json={"browser_id": "ext-1", "account": "u@example.com"},
        )
        r = await client.get("/ext/browsers")
        assert r.status_code == 200
        assert any(b["browser_id"] == "ext-1" for b in r.json()["browsers"])

        r = await client.post(
            "/ext/commands",
            json={"kind": "query", "params": {"text": "hi", "timeout_s": 30}},
        )
        assert r.status_code == 200
        cmd_id = r.json()["id"]

        async def extension():
            poll = await client.get("/ext/poll", params={"browser_id": "ext-1", "wait_s": 5})
            assert poll.status_code == 200
            cmd = poll.json()
            assert cmd["id"] == cmd_id
            await client.post(
                "/ext/events",
                json={"command_id": cmd_id, "type": "submitted", "payload": {}},
            )
            await client.post(
                "/ext/events",
                json={
                    "command_id": cmd_id,
                    "type": "done",
                    "payload": {
                        "conversation_id": "deadbeefcafebabe",
                        "turns": [{"role": "user", "text": "hi"}, {"role": "gemini", "text": "yo"}],
                        "model_changed": False,
                    },
                },
            )

        ext_task = asyncio.create_task(extension())
        waited = await client.get(f"/ext/commands/{cmd_id}/wait", params={"timeout_s": 10})
        await ext_task
        assert waited.status_code == 200
        assert waited.json()["status"] == "done"
        assert waited.json()["result"]["conversation_id"] == "deadbeefcafebabe"
