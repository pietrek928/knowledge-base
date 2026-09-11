"""Concurrency / hang-fix tests for embed submit and stop(drain=False)."""

import asyncio
from pathlib import Path

import pytest

from knowledge_base.service import KnowledgeBase


def _cfg(tmp_path: Path) -> dict:
    return {
        "data_dir": str(tmp_path / "kb"),
        "models": [
            {
                "name": "fake-a",
                "dim": 32,
                "num_ctx": 512,
                "matryoshka_dim": None,
                "document_prefix": "",
                "query_prefix": "",
            },
            {
                "name": "fake-b",
                "dim": 32,
                "num_ctx": 512,
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


@pytest.mark.asyncio
async def test_store_does_not_block_when_ollama_wedged(tmp_path: Path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    kb.ollama.enable_hang()
    await kb.start(backfill=False)
    try:
        # Many stores must finish even though embeds never complete.
        for i in range(20):
            await asyncio.wait_for(
                kb.store_document(f"notes/{i}.md", f"paragraph {i} about ERR_CONN_TIMEOUT"),
                timeout=5.0,
            )
        assert kb.pending_embed_count() > 0
    finally:
        await asyncio.wait_for(kb.stop(drain=False), timeout=5.0)


@pytest.mark.asyncio
async def test_stop_drain_false_returns_promptly(tmp_path: Path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    kb.ollama.enable_hang()
    await kb.start(backfill=False)
    await kb.store_document("a.md", "hello world block", rebuild_index=False)
    assert kb.pending_embed_count() >= 1
    await asyncio.wait_for(kb.stop(drain=False), timeout=5.0)


@pytest.mark.asyncio
async def test_batch_embeds_both_models(tmp_path: Path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    await kb.start(backfill=False)
    try:
        await kb.store_document("x.md", "The quick brown fox jumps over the lazy dog.")
        await kb.drain_embeds()
        hashes = [b.hash for b in kb.store.all_blocks()]
        assert hashes
        for vs in kb.vector_stores:
            for h in hashes:
                assert vs.has(h)
    finally:
        await kb.stop()


@pytest.mark.asyncio
async def test_deferred_rebuild_then_search(tmp_path: Path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    await kb.start(backfill=False)
    try:
        await kb.store_document(
            "notes/a.md",
            "UniqueTokenXYZ appears here.",
            embed=True,
            rebuild_index=False,
        )
        await kb.rebuild_index()
        await kb.drain_embeds()
        out = await kb.search({"phrases": ["UniqueTokenXYZ"], "limit": 5})
        assert out["results"]
        assert any("UniqueTokenXYZ" in r["text"] for r in out["results"])
    finally:
        await kb.stop()
