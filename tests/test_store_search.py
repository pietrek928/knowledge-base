import json
from pathlib import Path

import pytest

from knowledge_base.service import KnowledgeBase


@pytest.fixture
def kb(tmp_path: Path):
    cfg = {
        "data_dir": str(tmp_path / "kb"),
        "models": [
            {
                "name": "fake-a",
                "dim": 64,
                "num_ctx": 2048,
                "matryoshka_dim": 32,
                "document_prefix": "",
                "query_prefix": "",
            },
            {
                "name": "fake-b",
                "dim": 64,
                "num_ctx": 2048,
                "matryoshka_dim": None,
                "document_prefix": "",
                "query_prefix": "",
            },
        ],
        "token_budget": 400,
        "fusion": "cc",
        "fusion_weights": {"exact": 0.25, "fuzzy": 0.15, "bm25": 0.3, "embed": 0.3},
        "rrf_k": 60,
        "adaptive_fusion": True,
        "rescore_multiplier": 8,
        "candidate_k": 20,
        "bm25": {"k1": 0.9, "b": 0.75},
        "sibling_window": 2,
        "sibling_base": 0.15,
        "complement_bonus": 0.2,
        "cross_signal_bonus": 0.1,
        "sibling_inject_max": 2,
        "identifier_fast_path": True,
        "min_confidence": None,
        "date": {"half_life_days": 30, "weight": 0.0},
        "query_cache_size": 32,
        "embed_queue_size": 16,
        "metadata_max_bytes": 16384,
        "ollama": {"base_url": "http://127.0.0.1:9", "keep_alive": "30m", "timeout_s": 1, "batch_size": 8},
    }
    return KnowledgeBase(cfg, fake_ollama=True)


@pytest.mark.asyncio
async def test_store_and_search_exact(kb: KnowledgeBase):
    await kb.start()
    await kb.store_document("notes/a.md", "The quick brown fox jumps over ERR_CONN_TIMEOUT today.")
    await kb.backfill_missing()
    out = await kb.search({"phrases": ["ERR_CONN_TIMEOUT"], "limit": 5})
    assert out["results"]
    assert any("ERR_CONN" in r["text"] for r in out["results"])
    await kb.stop()


@pytest.mark.asyncio
async def test_store_json_on_disk(kb: KnowledgeBase, tmp_path: Path):
    await kb.start()
    await kb.store_document("docs/x.md", "Hello **world** paragraph.")
    path = Path(kb.cfg["data_dir"]) / "content" / "docs" / "x.md.json"
    assert path.exists()
    doc = json.loads(path.read_text())
    assert "blocks" in doc
    assert "path" not in doc
    assert all("format" not in b for b in doc["blocks"])
    await kb.stop()
