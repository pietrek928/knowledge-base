"""Golden + unit tests for gemini_format and ingest_gemini."""

import pytest
from httpx import ASGITransport, AsyncClient

from knowledge_base.app import create_app
from knowledge_base.gemini_format import (
    fingerprint,
    format_markdown,
    path_for,
    to_iso_z,
)


def _cfg(tmp_path):
    return {
        "data_dir": str(tmp_path / "kb"),
        "models": [
            {
                "name": "fake-a",
                "dim": 32,
                "num_ctx": 1024,
                "matryoshka_dim": None,
                "document_prefix": "",
                "query_prefix": "",
            }
        ],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.25, "fuzzy": 0.15, "bm25": 0.3, "embed": 0.3},
        "rrf_k": 60,
        "adaptive_fusion": True,
        "rescore_multiplier": 4,
        "candidate_k": 10,
        "bm25": {"k1": 0.9, "b": 0.75},
        "sibling_window": 1,
        "sibling_base": 0.1,
        "complement_bonus": 0.1,
        "cross_signal_bonus": 0.05,
        "sibling_inject_max": 1,
        "identifier_fast_path": True,
        "min_confidence": None,
        "date": {"half_life_days": 30, "weight": 0.0},
        "query_cache_size": 8,
        "metadata_max_bytes": 4096,
        "ollama": {
            "base_url": "http://127.0.0.1:9",
            "keep_alive": "1m",
            "timeout_s": 1,
            "batch_size": 4,
        },
    }


def test_path_for_strips_c_prefix():
    assert path_for("abc123") == "gemini/abc123.md"
    assert path_for("c_abc123") == "gemini/abc123.md"


def test_to_iso_z_golden():
    assert to_iso_z(1718461323, 0) == "2024-06-15T14:22:03Z"
    assert to_iso_z(100) is None  # too early
    assert to_iso_z(None) is None


def test_format_markdown_golden():
    turns = [
        {"role": "user", "text": "Hello ąęółżźćń", "ts_sec": 1718461323, "ts_nanos": 0},
        {
            "role": "gemini",
            "text": "Cześć!\n\n```python\nprint(1)\n```",
            "ts_sec": 1718461331,
            "ts_nanos": 0,
        },
    ]
    md = format_markdown("Test chat", turns)
    expected = (
        "# Test chat\n"
        "\n"
        "**User** (2024-06-15T14:22:03Z):\n"
        "\n"
        "Hello ąęółżźćń\n"
        "\n"
        "**Gemini** (2024-06-15T14:22:11Z):\n"
        "\n"
        "Cześć!\n"
        "\n"
        "```python\n"
        "print(1)\n"
        "```\n"
    )
    assert md == expected
    assert fingerprint(md) == fingerprint(expected)


def test_format_sorts_by_timestamp():
    turns = [
        {"role": "gemini", "text": "second", "ts_sec": 1718461331},
        {"role": "user", "text": "first", "ts_sec": 1718461323},
    ]
    md = format_markdown("Ordered", turns)
    assert md.index("**User**") < md.index("**Gemini**")


@pytest.fixture
def app(tmp_path):
    return create_app(_cfg(tmp_path), fake_ollama=True)


@pytest.mark.asyncio
async def test_ingest_gemini_skip_and_docs(app, tmp_path):
    transport = ASGITransport(app=app)
    payload = {
        "conversation_id": "deadbeef",
        "title": "Mortgage",
        "ingest": "extension",
        "turns": [
            {"role": "user", "text": "budget ąę", "ts_sec": 1718461323, "ts_nanos": 0},
            {"role": "gemini", "text": "ok", "ts_sec": 1718461331, "ts_nanos": 0},
        ],
    }
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/ingest/gemini", json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["path"] == "gemini/deadbeef.md"
        assert body["skipped"] is False
        assert body["message_count"] == 2
        fp = body["content_fingerprint"]

        r2 = await client.post("/ingest/gemini", json=payload)
        assert r2.json()["skipped"] is True
        assert r2.json()["content_fingerprint"] == fp

        docs = await client.get("/docs", params={"prefix": "gemini/"})
        assert docs.status_code == 200
        listed = docs.json()["docs"]
        assert len(listed) == 1
        assert listed[0]["path"] == "gemini/deadbeef.md"
        assert listed[0]["metadata"]["content_fingerprint"] == fp
        assert listed[0]["metadata"]["source"] == "gemini"

        # doc metadata once on disk, not on every block
        import orjson

        disk = orjson.loads(
            (tmp_path / "kb" / "content" / "gemini" / "deadbeef.md.json").read_bytes()
        )
        assert disk["metadata"]["conversation_id"] == "deadbeef"
        for b in disk["blocks"]:
            assert "source" not in (b.get("metadata") or {})

        # search meta filter uses doc metadata
        search = await client.post(
            "/search",
            json={"phrases": ["budget"], "limit": 5, "meta": {"source": "gemini"}},
        )
        assert search.status_code == 200
        hits = search.json()["results"]
        assert hits
        assert hits[0]["metadata"]["conversation_id"] == "deadbeef"
        assert "ąę" in hits[0]["text"] or "ąę" in hits[0].get("source", "")


@pytest.mark.asyncio
async def test_store_doc_metadata_not_copied_to_blocks(app, tmp_path):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post(
            "/store",
            json={
                "path": "notes/a.md",
                "content": "hello world",
                "metadata": {"project": "x"},
                "block_metadata": {"chunk_tag": "y"},
            },
        )
        assert r.status_code == 200
        import orjson

        disk = orjson.loads((tmp_path / "kb" / "content" / "notes" / "a.md.json").read_bytes())
        assert disk["metadata"] == {"project": "x"}
        assert disk["blocks"][0]["metadata"]["chunk_tag"] == "y"
        assert "project" not in disk["blocks"][0]["metadata"]
