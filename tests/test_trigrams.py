import pytest

kb_native = pytest.importorskip("kb_native")


def test_trigram_candidates_find_near():
    text = "the quick brown fox jumps over the lazy dog"
    entries = kb_native.build_trigrams(text)
    cands = kb_native.trigram_candidates(entries, "brown", 50)
    assert any(abs(c - text.find("brown")) <= 2 for c in cands)
