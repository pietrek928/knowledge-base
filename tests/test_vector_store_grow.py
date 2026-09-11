"""VectorStore mmap growth past initial capacity."""

from pathlib import Path

import numpy as np

from knowledge_base.vectors import VectorStore


def test_upsert_grows_past_initial_capacity(tmp_path: Path):
    model = {
        "name": "fake-grow",
        "dim": 32,
        "matryoshka_dim": 32,
    }
    vs = VectorStore(tmp_path / "kb", model)
    # Initial rewrite uses capacity max(n, 8); push well past that.
    for i in range(24):
        vs.upsert(f"h{i:04x}", np.ones(32, dtype=np.float32) * (i + 1))
    assert len(vs.row_to_hash) == 24
    assert vs.emb is not None and vs.emb.shape[0] >= 24
    assert vs.has("h0017")
    row = vs.hash_to_row["h0000"]
    assert float(vs.emb[row, 0]) != 0.0
