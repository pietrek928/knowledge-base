"""Per-class bench floors — synthetic corpus, fake embeddings."""

import json
from pathlib import Path

import pytest

from knowledge_base.service import KnowledgeBase

CORPUS = {
    "code/auth.py": '''
def login(user, password):
    """Authenticate a user against the directory."""
    token = issue_token(user)
    return token

def issue_token(user):
    return f"tok-{user}"
''',
    "docs/auth.md": "# Auth\n\nUsers sign in with a password. The login flow issues a token.\n",
    "ops/errors.md": "When the socket fails we raise ERR_CONN_TIMEOUT and retry.\nAlso ENOMEM means out of memory.\n",
    "ops/sku.txt": "SKU-99881 is the replacement part for the north warehouse.\n",
    "notes/paraphrase.md": "How people gain access to the system after proving identity.\n",
}

QUERIES = [
    {"id": "identifier", "phrases": ["ERR_CONN_TIMEOUT"], "expect_path_substr": "errors"},
    {"id": "sku", "phrases": ["SKU-99881"], "expect_path_substr": "sku"},
    {"id": "code_symbol", "phrases": ["issue_token"], "expect_path_substr": "auth.py"},
    {"id": "prose", "phrases": ["login flow issues a token"], "expect_path_substr": "auth"},
    {"id": "paraphrase", "phrases": ["how does authentication work"], "expect_path_substr": "auth"},
]


def _cfg(tmp_path: Path) -> dict:
    return {
        "data_dir": str(tmp_path / "kb"),
        "models": [
            {
                "name": "fake-a",
                "dim": 128,
                "num_ctx": 2048,
                "matryoshka_dim": 64,
                "document_prefix": "",
                "query_prefix": "",
            },
            {
                "name": "fake-b",
                "dim": 128,
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
        "candidate_k": 30,
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
        "metadata_max_bytes": 16384,
        "ollama": {
            "base_url": "http://127.0.0.1:9",
            "keep_alive": "30m",
            "timeout_s": 1,
            "batch_size": 8,
        },
    }


@pytest.fixture
async def bench_kb(tmp_path: Path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    await kb.start()
    for path, content in CORPUS.items():
        await kb.store_document(path, content)
    await kb.backfill_missing()
    yield kb
    await kb.stop()


@pytest.mark.bench
@pytest.mark.asyncio
@pytest.mark.parametrize("query", QUERIES, ids=[q["id"] for q in QUERIES])
async def test_bench_floors(bench_kb: KnowledgeBase, query: dict):
    out = await bench_kb.search({"phrases": query["phrases"], "limit": 5, "fusion": "cc"})
    assert out["results"], f"no hits for {query['id']}"
    top_paths = " ".join(r["path"] for r in out["results"][:3])
    assert query["expect_path_substr"] in top_paths, (query["id"], top_paths)


@pytest.mark.bench
@pytest.mark.asyncio
async def test_identifier_beats_embed_only(bench_kb: KnowledgeBase):
    hybrid = await bench_kb.search({"phrases": ["ENOMEM"], "limit": 3, "fusion": "cc"})
    assert hybrid["results"]
    assert any("ENOMEM" in r["text"] for r in hybrid["results"][:3])


@pytest.mark.bench
@pytest.mark.asyncio
async def test_sibling_boost_changes_order(bench_kb: KnowledgeBase):
    await bench_kb.search(
        {
            "phrases": ["login", "issue_token"],
            "limit": 10,
            "sibling_window": 0,
            "complement_bonus": 0.0,
        }
    )
    boosted = await bench_kb.search(
        {
            "phrases": ["login", "issue_token"],
            "limit": 10,
            "sibling_window": 2,
            "complement_bonus": 0.5,
        }
    )
    assert boosted["results"]
    # both should find auth.py content
    assert any("auth.py" in r["path"] for r in boosted["results"][:5])


def test_write_fixture_manifest(tmp_path: Path):
    # ensure fixture dir exists for documentation
    root = Path(__file__).parent / "fixtures" / "corpus"
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(
        json.dumps({"queries": QUERIES, "docs": list(CORPUS)}, indent=2)
    )
    assert (root / "manifest.json").exists()
