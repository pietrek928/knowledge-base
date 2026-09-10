import numpy as np
import pytest

kb_native = pytest.importorskip("kb_native")


def test_cosine_f32():
    a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    b = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    assert abs(kb_native.cosine_f32(a, b) - 1.0) < 1e-5


def test_rescore_int8_order():
    dim = 32
    q = np.zeros(dim, dtype=np.float32)
    q[0] = 1.0
    rows = np.zeros((5, dim), dtype=np.int8)
    rows[0, 0] = 100
    rows[1, 1] = 100
    rows[2, 0] = 50
    scales = np.ones(5, dtype=np.float32) * 0.01
    scores = kb_native.rescore_int8(q, rows, scales, [0, 1, 2])
    assert scores[0] > scores[2] > scores[1]


def test_rescore_f16():
    dim = 8
    q = np.zeros(dim, dtype=np.float32)
    q[0] = 1.0
    emb = np.zeros((3, dim), dtype=np.float16)
    emb[0, 0] = 1.0
    emb[1, 1] = 1.0
    u16 = emb.view(np.uint16)
    scores = kb_native.rescore_f16(q, u16, [0, 1])
    assert scores[0] > scores[1]
