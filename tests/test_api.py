import pytest
from httpx import ASGITransport, AsyncClient

from knowledge_base.app import create_app
from knowledge_base.service import KnowledgeBase


@pytest.fixture
def app(tmp_path):
    cfg = {
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
        "embed_queue_size": 8,
        "metadata_max_bytes": 4096,
        "ollama": {"base_url": "http://127.0.0.1:9", "keep_alive": "1m", "timeout_s": 1, "batch_size": 4},
    }
    return create_app(cfg, fake_ollama=True)


@pytest.mark.asyncio
async def test_health_and_store_search(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/health")
        assert r.status_code == 200
        r = await client.post("/store", json={"path": "t.md", "content": "alpha beta gamma"})
        assert r.status_code == 200
        r = await client.post("/search", json={"phrases": ["alpha"], "limit": 5})
        assert r.status_code == 200
        assert "results" in r.json()
