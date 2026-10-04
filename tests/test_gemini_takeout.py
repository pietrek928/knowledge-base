"""Tests for Takeout HTML/JSON parsing and import skip behavior."""

from datetime import UTC
from pathlib import Path

import pytest

from knowledge_base.gemini_takeout import (
    load_takeout,
    parse_activity_datetime,
    parse_myactivity_html,
)
from knowledge_base.service import KnowledgeBase

FIXTURE = Path(__file__).parent / "fixtures" / "gemini" / "MyActivity_sample.html"


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


def test_parse_activity_datetime_cest():
    sec, nanos = parse_activity_datetime("Sep 10, 2026, 6:52:37 PM CEST")
    assert sec is not None
    assert nanos == 0
    # 18:52 CEST = 16:52 UTC
    from datetime import datetime

    dt = datetime.fromtimestamp(sec, tz=UTC)
    assert dt.year == 2026 and dt.month == 9 and dt.day == 10
    assert dt.hour == 16 and dt.minute == 52


def test_parse_sample_html_preserves_polish():
    html = FIXTURE.read_text(encoding="utf-8")
    convs = parse_myactivity_html(html)
    assert "abc123def456" in convs
    turns = convs["abc123def456"]["turns"]
    assert turns[0]["role"] == "user"
    assert "ąęółżźćń" in turns[0]["text"]
    assert turns[1]["role"] == "gemini"
    assert "Cześć" in turns[1]["text"] or "Czesc" in turns[1]["text"] or "bold" in turns[1]["text"]


def test_parse_sample_html_preserves_answer_newlines():
    html = FIXTURE.read_text(encoding="utf-8")
    turns = parse_myactivity_html(html)["abc123def456"]["turns"]
    answer = turns[1]["text"]
    assert "def foo():\n" in answer
    assert "    return 1" in answer
    assert "Then:\nline two" in answer or "Then:\n line two" in answer


def test_parse_sample_html_fences_code_and_structure():
    html = FIXTURE.read_text(encoding="utf-8")
    answer = parse_myactivity_html(html)["abc123def456"]["turns"][1]["text"]
    assert "```" in answer
    assert "def foo():" in answer
    assert "__init__" in answer
    # heading demoted (h3 -> ####)
    assert "#### Example" in answer
    assert "**bold**" in answer
    assert "- **One**" in answer or "- **One** item" in answer
    assert "[image: sample-shot.png]" in answer


def test_load_takeout_path():
    convs = load_takeout(FIXTURE)
    assert len(convs) == 1


@pytest.mark.asyncio
async def test_takeout_ingest_twice_skips(tmp_path):
    kb = KnowledgeBase(_cfg(tmp_path), fake_ollama=True)
    await kb.start()
    try:
        convs = load_takeout(FIXTURE)
        conv = next(iter(convs.values()))
        r1 = await kb.ingest_gemini(
            conversation_id=conv["conversation_id"],
            title=conv["title"],
            turns=conv["turns"],
            ingest="takeout",
        )
        assert r1["skipped"] is False
        r2 = await kb.ingest_gemini(
            conversation_id=conv["conversation_id"],
            title=conv["title"],
            turns=conv["turns"],
            ingest="takeout",
        )
        assert r2["skipped"] is True
        docs = kb.list_docs(prefix="gemini/")
        assert len(docs) == 1
        # Polish chars survive into stored plain text
        blocks = kb.store.path_blocks[docs[0]["path"]]
        texts = " ".join(kb.store.get(h).text for h in blocks)
        assert "ąęółżźćń" in texts
    finally:
        await kb.stop()
