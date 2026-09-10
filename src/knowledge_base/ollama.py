from __future__ import annotations

import asyncio
import hashlib
import threading
from collections import OrderedDict
from typing import Any

import httpx
import numpy as np


class QueryCache:
    def __init__(self, size: int = 256) -> None:
        self.size = size
        self._data: OrderedDict[str, np.ndarray] = OrderedDict()
        self._lock = threading.Lock()

    def _key(self, model: str, text: str) -> str:
        return hashlib.sha256(f"{model}\0{text}".encode()).hexdigest()

    def get(self, model: str, text: str) -> np.ndarray | None:
        k = self._key(model, text)
        with self._lock:
            if k in self._data:
                self._data.move_to_end(k)
                return self._data[k]
        return None

    def put(self, model: str, text: str, vec: np.ndarray) -> None:
        k = self._key(model, text)
        with self._lock:
            self._data[k] = vec
            self._data.move_to_end(k)
            while len(self._data) > self.size:
                self._data.popitem(last=False)


class OllamaClient:
    def __init__(self, cfg: dict[str, Any], models: list[dict[str, Any]]) -> None:
        o = cfg.get("ollama", {})
        self.base_url = o.get("base_url", "http://127.0.0.1:11434").rstrip("/")
        self.keep_alive = o.get("keep_alive", "30m")
        self.timeout = float(o.get("timeout_s", 120))
        self.batch_size = int(o.get("batch_size", 16))
        self.models = models
        self.cache = QueryCache(cfg.get("query_cache_size", 256))
        self._client: httpx.AsyncClient | None = None
        self._fake: dict[str, np.ndarray] | None = None  # for tests

    def enable_fake(self) -> None:
        """Deterministic fake embeddings for tests (no network)."""
        self._fake = {}

    def _fake_embed(self, model: dict[str, Any], texts: list[str]) -> list[np.ndarray]:
        dim = int(model["dim"])
        out: list[np.ndarray] = []
        for t in texts:
            seed = int(hashlib.md5(f"{model['name']}:{t}".encode()).hexdigest()[:8], 16)
            rng = np.random.default_rng(seed)
            v = rng.standard_normal(dim).astype(np.float32)
            # boost overlap for shared tokens
            for tok in t.lower().split()[:8]:
                idx = int(hashlib.md5(tok.encode()).hexdigest()[:6], 16) % dim
                v[idx] += 3.0
            v /= np.linalg.norm(v) or 1.0
            out.append(v)
        return out

    async def _client_get(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def embed(
        self, model: dict[str, Any], texts: list[str], *, is_query: bool = False
    ) -> list[np.ndarray]:
        if not texts:
            return []
        prefix = model.get("query_prefix" if is_query else "document_prefix") or ""
        payloads = [prefix + t for t in texts]

        if self._fake is not None:
            return self._fake_embed(model, payloads)

        # cache individual query embeddings
        if is_query and len(payloads) == 1:
            cached = self.cache.get(model["name"], payloads[0])
            if cached is not None:
                return [cached]

        client = await self._client_get()
        results: list[np.ndarray] = []
        for i in range(0, len(payloads), self.batch_size):
            batch = payloads[i : i + self.batch_size]
            body: dict[str, Any] = {
                "model": model["name"],
                "input": batch if len(batch) > 1 else batch[0],
                "keep_alive": self.keep_alive,
                # Prefer no truncation for quality; retry with truncate on context overflow (400).
                "truncate": False,
            }
            r = await client.post("/api/embed", json=body)
            if r.status_code == 400 and not is_query:
                body["truncate"] = True
                r = await client.post("/api/embed", json=body)
            r.raise_for_status()
            data = r.json()
            emb = data.get("embeddings") or data.get("embedding")
            if emb is None:
                raise RuntimeError(f"unexpected embed response: {data!r}")
            if isinstance(emb[0], (int, float)):
                emb = [emb]
            for row in emb:
                results.append(np.asarray(row, dtype=np.float32))

        if is_query and len(payloads) == 1 and results:
            self.cache.put(model["name"], payloads[0], results[0])
        return results

    async def prewarm(self) -> None:
        if self._fake is not None:
            return
        for model in self.models:
            try:
                await self.embed(model, ["warmup"], is_query=True)
            except Exception:
                pass

    def embed_sync(self, model: dict[str, Any], texts: list[str], *, is_query: bool = False) -> list[np.ndarray]:
        return asyncio.get_event_loop().run_until_complete(
            self.embed(model, texts, is_query=is_query)
        )
