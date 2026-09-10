import pytest

kb_native = pytest.importorskip("kb_native")


def test_damerau_transpose():
    # ab <-> ba is 1 with Damerau
    assert kb_native.damerau_levenshtein("ab", "ba") == 1


def test_normalized_similarity():
    assert kb_native.normalized_similarity("hello", "hello") == 1.0
    assert kb_native.normalized_similarity("hello", "hallo") > 0.7


def test_fuzzy_window():
    text = "xxxxhellothereyyyy"
    hits = kb_native.fuzzy_window_search(text, "hello", 0.8, 10, [4])
    assert hits
    assert hits[0][2] >= 0.8
