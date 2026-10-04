"""Lexical-only mode when models / Ollama are not configured."""

from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from knowledge_base.app import create_app
from knowledge_base.service import KnowledgeBase, embeddings_configured


def _base_cfg(tmp_path: Path, **overrides) -> dict:
    cfg = {
        "data_dir": str(tmp_path / "kb"),
        "models": [],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.25, "fuzzy": 0.15, "bm25": 0.3, "embed": 0.3},
        "rrf_k": 60,
        "adaptive_fusion": False,
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
    cfg.update(overrides)
    return cfg


def test_embeddings_configured_detection():
    assert embeddings_configured({"models": []}) is False
    assert embeddings_configured({}) is False
    assert embeddings_configured({"models": [{"name": "m", "dim": 8}], "ollama": False}) is False
    assert embeddings_configured({"models": [{"name": "m", "dim": 8}], "ollama": None}) is False
    assert (
        embeddings_configured(
            {"models": [{"name": "m", "dim": 8}], "ollama": {"enabled": False}}
        )
        is False
    )
    assert embeddings_configured({"models": [{"name": "m", "dim": 8}]}) is True
    assert (
        embeddings_configured(
            {"models": [{"name": "m", "dim": 8}], "ollama": {"base_url": "http://x"}}
        )
        is True
    )


@pytest.mark.asyncio
async def test_store_and_search_without_models(tmp_path: Path):
    kb = KnowledgeBase(_base_cfg(tmp_path), fake_ollama=True)
    assert kb.embeddings_enabled is False
    await kb.start()
    try:
        out = await kb.store_document("notes/a.md", "UniqueLexicalTokenXYZ is here.")
        assert out["embeddings"] is False
        assert kb.pending_embed_count() == 0
        assert kb.missing_embed_hashes() == []
        assert kb.vector_stores == []
        results = await kb.search({"phrases": ["UniqueLexicalTokenXYZ"], "limit": 5})
        assert results["results"]
        assert any("UniqueLexicalTokenXYZ" in r["text"] for r in results["results"])
    finally:
        await kb.stop()


@pytest.mark.asyncio
async def test_ollama_enabled_false_ignores_models(tmp_path: Path):
    cfg = _base_cfg(
        tmp_path,
        models=[
            {
                "name": "fake-a",
                "dim": 32,
                "num_ctx": 512,
                "matryoshka_dim": None,
                "document_prefix": "",
                "query_prefix": "",
            }
        ],
        ollama={"enabled": False, "base_url": "http://127.0.0.1:9"},
    )
    kb = KnowledgeBase(cfg, fake_ollama=True)
    assert kb.embeddings_enabled is False
    await kb.start()
    try:
        out = await kb.store_document("x.md", "alpha beta UniqueLexicalOnly")
        assert out["embeddings"] is False
        assert kb.pending_embed_count() == 0
        results = await kb.search({"phrases": ["UniqueLexicalOnly"], "limit": 5})
        assert results["results"]
    finally:
        await kb.stop()


@pytest.mark.asyncio
async def test_api_health_and_search_lexical_only(tmp_path: Path):
    app = create_app(_base_cfg(tmp_path), fake_ollama=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "embeddings": False}
        r = await client.post(
            "/store",
            json={"path": "t.md", "content": "LexicalOnlyPhrase for api test"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["embeddings"] is False
        r = await client.post("/search", json={"phrases": ["LexicalOnlyPhrase"], "limit": 5})
        assert r.status_code == 200
        assert r.json()["results"]
