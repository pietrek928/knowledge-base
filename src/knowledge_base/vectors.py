from __future__ import annotations

import struct
import threading
from pathlib import Path
from typing import Any

import numpy as np

from knowledge_base.config import model_slug


def quantize_int8(vec: np.ndarray) -> tuple[np.ndarray, float]:
    v = vec.astype(np.float32)
    max_abs = float(np.max(np.abs(v))) or 1.0
    scale = max_abs / 127.0
    q = np.clip(np.round(v / scale), -127, 127).astype(np.int8)
    return q, scale


def pack_bits(vec: np.ndarray) -> np.ndarray:
    v = vec.astype(np.float32)
    dim = v.shape[0]
    nwords = (dim + 63) // 64
    out = np.zeros(nwords, dtype=np.uint64)
    for w in range(nwords):
        word = np.uint64(0)
        for b in range(64):
            i = w * 64 + b
            if i < dim and v[i] >= 0:
                word |= np.uint64(1) << np.uint64(b)
        out[w] = word
    return out


def truncate_renorm(vec: np.ndarray, dim: int | None) -> np.ndarray:
    v = vec.astype(np.float32)
    if dim is None or dim >= v.shape[0]:
        n = np.linalg.norm(v) or 1.0
        return v / n
    t = v[:dim].copy()
    n = np.linalg.norm(t) or 1.0
    return t / n


class VectorStore:
    """Per-model memmapped emb (f16), q8 (int8), bits (uint64), plus hash index."""

    def __init__(self, data_dir: str | Path, model: dict[str, Any]) -> None:
        self.data_dir = Path(data_dir)
        self.model = model
        self.name = model["name"]
        self.slug = model_slug(self.name)
        self.dim = int(model["dim"])
        self.mrl = model.get("matryoshka_dim")
        self.tier_dim = int(self.mrl) if self.mrl else self.dim
        self.nwords = (self.tier_dim + 63) // 64
        self.vec_dir = self.data_dir / "vectors"
        self.vec_dir.mkdir(parents=True, exist_ok=True)
        self.meta_path = self.vec_dir / f"{self.slug}.meta.npz"
        self.emb_path = self.vec_dir / f"{self.slug}.emb.npy"
        self.q8_path = self.vec_dir / f"{self.slug}.q8.npy"
        self.scale_path = self.vec_dir / f"{self.slug}.scale.npy"
        self.bits_path = self.vec_dir / f"{self.slug}.bits.npy"
        self._lock = threading.RLock()
        self.hash_to_row: dict[str, int] = {}
        self.row_to_hash: list[str] = []
        self.emb: np.ndarray | None = None
        self.q8: np.ndarray | None = None
        self.scales: np.ndarray | None = None
        self.bits: np.ndarray | None = None
        self._load()

    def _load(self) -> None:
        if self.meta_path.exists():
            meta = np.load(self.meta_path, allow_pickle=True)
            hashes = meta["hashes"].tolist()
            self.row_to_hash = [str(h) for h in hashes]
            self.hash_to_row = {h: i for i, h in enumerate(self.row_to_hash)}
        if self.emb_path.exists():
            self.emb = np.load(self.emb_path, mmap_mode="r+")
        if self.q8_path.exists():
            self.q8 = np.load(self.q8_path, mmap_mode="r+")
        if self.scale_path.exists():
            self.scales = np.load(self.scale_path, mmap_mode="r+")
        if self.bits_path.exists():
            self.bits = np.load(self.bits_path, mmap_mode="r+")

    def _ensure_capacity(self, n: int) -> None:
        if self.emb is None or self.emb.shape[0] < n:
            self._rewrite(n)

    def _rewrite(self, capacity: int) -> None:
        old_n = len(self.row_to_hash)
        capacity = max(capacity, old_n, 8)
        emb = np.zeros((capacity, self.dim), dtype=np.float16)
        q8 = np.zeros((capacity, self.tier_dim), dtype=np.int8)
        scales = np.ones((capacity,), dtype=np.float32)
        bits = np.zeros((capacity, self.nwords), dtype=np.uint64)
        if (
            self.emb is not None
            and self.q8 is not None
            and self.scales is not None
            and self.bits is not None
            and old_n
        ):
            emb[:old_n] = np.asarray(self.emb[:old_n])
            q8[:old_n] = np.asarray(self.q8[:old_n])
            scales[:old_n] = np.asarray(self.scales[:old_n])
            bits[:old_n] = np.asarray(self.bits[:old_n])
        np.save(self.emb_path, emb)
        np.save(self.q8_path, q8)
        np.save(self.scale_path, scales)
        np.save(self.bits_path, bits)
        self.emb = np.load(self.emb_path, mmap_mode="r+")
        self.q8 = np.load(self.q8_path, mmap_mode="r+")
        self.scales = np.load(self.scale_path, mmap_mode="r+")
        self.bits = np.load(self.bits_path, mmap_mode="r+")

    def _save_meta(self) -> None:
        np.savez(self.meta_path, hashes=np.array(self.row_to_hash, dtype=object))

    def upsert(self, h: str, vector: np.ndarray) -> int:
        with self._lock:
            v = np.asarray(vector, dtype=np.float32).reshape(-1)
            if v.shape[0] != self.dim:
                raise ValueError(f"expected dim {self.dim}, got {v.shape[0]}")
            n = np.linalg.norm(v) or 1.0
            v = v / n
            if h in self.hash_to_row:
                row = self.hash_to_row[h]
            else:
                row = len(self.row_to_hash)
                self.row_to_hash.append(h)
                self.hash_to_row[h] = row
                self._ensure_capacity(row + 1)
            assert self.emb is not None and self.q8 is not None
            assert self.scales is not None and self.bits is not None
            self.emb[row] = v.astype(np.float16)
            tier = truncate_renorm(v, self.mrl if self.mrl else None)
            if tier.shape[0] != self.tier_dim:
                # pad/truncate
                t = np.zeros(self.tier_dim, dtype=np.float32)
                t[: min(self.tier_dim, tier.shape[0])] = tier[: self.tier_dim]
                tier = t
            q, scale = quantize_int8(tier)
            self.q8[row] = q
            self.scales[row] = scale
            self.bits[row] = pack_bits(tier)
            self._save_meta()
            return row

    def has(self, h: str) -> bool:
        return h in self.hash_to_row

    def missing(self, hashes: list[str]) -> list[str]:
        return [h for h in hashes if h not in self.hash_to_row]
