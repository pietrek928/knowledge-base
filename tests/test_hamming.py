import numpy as np
import pytest

kb_native = pytest.importorskip("kb_native")


def test_pack_and_hamming():
    a = np.array([1.0, -1.0, 0.5, -0.2] + [0.0] * 60, dtype=np.float32)
    b = np.array([1.0, 1.0, 0.5, -0.2] + [0.0] * 60, dtype=np.float32)
    pa = kb_native.pack_binary(a)
    pb = kb_native.pack_binary(b)
    d = kb_native.hamming_distance(pa, pb)
    # only bit 1 differs (sign of index 1)
    assert d == 1


def test_hamming_topk_contains_nearest():
    rng = np.random.default_rng(0)
    dim = 128
    nwords = (dim + 63) // 64
    nrows = 40
    matrix = np.zeros((nrows, nwords), dtype=np.uint64)
    vectors = rng.standard_normal((nrows, dim)).astype(np.float32)
    for i in range(nrows):
        matrix[i] = np.asarray(kb_native.pack_binary(vectors[i]), dtype=np.uint64)
    q = vectors[7].copy()
    q_bits = np.asarray(kb_native.pack_binary(q), dtype=np.uint64)
    top = kb_native.hamming_topk(matrix, q_bits, 8)
    ids = [r for r, _ in top]
    assert 7 in ids
