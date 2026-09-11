"""Readonly ndarray borrow vs writeable copy fallback for kb_native."""

from pathlib import Path

import numpy as np
import pytest

from knowledge_base.service import KnowledgeBase
from knowledge_base.vectors import as_readonly

kb_native = pytest.importorskip("kb_native")


def test_as_readonly_sets_flag():
    a = np.arange(8, dtype=np.float32)
    assert a.flags.writeable
    r = as_readonly(a)
    assert not r.flags.writeable
    assert np.shares_memory(a, r)


def test_hamming_topk_readonly_and_writeable():
    rng = np.random.default_rng(0)
    matrix = rng.integers(0, 2**63, size=(32, 4), dtype=np.uint64)
    query = rng.integers(0, 2**63, size=(4,), dtype=np.uint64)
    ro_m = as_readonly(matrix)
    ro_q = as_readonly(query.copy())
    top_ro = kb_native.hamming_topk(ro_m, ro_q, 5)
    # writeable path (memcpy fallback)
    top_w = kb_native.hamming_topk(matrix.copy(), query.copy(), 5)
    assert [r for r, _ in top_ro] == [r for r, _ in top_w]


def test_rescore_readonly_and_writeable():
    rng = np.random.default_rng(1)
    dim = 16
    nrows = 20
    query = rng.standard_normal(dim).astype(np.float32)
    query /= np.linalg.norm(query) or 1.0
    rows = rng.integers(-40, 40, size=(nrows, dim), dtype=np.int8)
    scales = rng.random(nrows).astype(np.float32) + 0.1
    ids = list(range(0, nrows, 2))
    a = kb_native.rescore_int8(as_readonly(query), as_readonly(rows), as_readonly(scales), ids)
    b = kb_native.rescore_int8(query.copy(), rows.copy(), scales.copy(), ids)
    assert np.allclose(a, b, rtol=1e-5)


def test_pack_binary_readonly():
    v = np.linspace(-1, 1, 64, dtype=np.float32)
    a = kb_native.pack_binary(as_readonly(v))
    b = kb_native.pack_binary(v.copy())
    assert a == b


@pytest.mark.asyncio
async def test_vectorstore_search_views_readonly_after_upsert(tmp_path: Path):
    cfg = {
        "data_dir": str(tmp_path / "kb"),
        "models": [
            {
                "name": "fake-a",
                "dim": 64,
                "num_ctx": 512,
                "matryoshka_dim": 64,
                "document_prefix": "",
                "query_prefix": "",
            }
        ],
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
        "identifier_fast_path": False,
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
    kb = KnowledgeBase(cfg, fake_ollama=True)
    await kb.start(backfill=False)
    try:
        await kb.store_document("n.md", "alpha beta gamma uniquephrase")
        await kb.drain_embeds()
        vs = kb.vector_stores[0]
        views = vs.search_views()
        assert views is not None
        emb, q8, scales, bits, row_to_hash = views
        assert row_to_hash
        for arr in (emb, q8, scales, bits):
            assert not arr.flags.writeable
        # upsert still works on writeable mmap
        vs.upsert("deadbeef", np.ones(64, dtype=np.float32))
        out = await kb.search({"phrases": ["uniquephrase"], "limit": 5})
        assert out["results"]
    finally:
        await kb.stop()
