import pytest

kb_native = pytest.importorskip("kb_native")


def test_rare_term_outranks():
    # doc0 has rare ERR_4021 once; doc1 has "the" many times
    idfs = [3.0, 0.1]  # ERR, the
    s0 = kb_native.bm25_score([1, 0], idfs, 5, 10.0, 0.9, 0.75)
    s1 = kb_native.bm25_score([0, 5], idfs, 20, 10.0, 0.9, 0.75)
    assert s0 > s1


def test_b_length_norm():
    idfs = [1.0]
    short = kb_native.bm25_score([2], idfs, 5, 20.0, 0.9, 1.0)
    long = kb_native.bm25_score([2], idfs, 40, 20.0, 0.9, 1.0)
    assert short > long
    same = kb_native.bm25_score([2], idfs, 5, 20.0, 0.9, 0.0)
    same2 = kb_native.bm25_score([2], idfs, 40, 20.0, 0.9, 0.0)
    assert abs(same - same2) < 1e-5


def test_empty():
    assert kb_native.bm25_score([], [], 0, 1.0) == 0.0
