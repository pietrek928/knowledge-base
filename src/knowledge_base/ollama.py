import asyncio
import hashlib
import logging
import os
import threading
from collections import OrderedDict
from typing import Any

import httpx
import numpy as np

log = logging.getLogger(__name__)


def _default_num_thread() -> int:
    """Half of logical CPUs (min 1) — better than Ollama's P-core-only default on hybrids."""
    return max(1, (os.cpu_count() or 2) // 2)


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
        self.timeout = float(o.get("timeout_s", 600))
        self.batch_size = int(o.get("batch_size", 4))
        self.num_thread = int(o["num_thread"]) if o.get("num_thread") is not None else _default_num_thread()
        self.models = models
        self.cache = QueryCache(cfg.get("query_cache_size", 256))
        self._client: httpx.AsyncClient | None = None
        self._fake: dict[str, np.ndarray] | None = None  # for tests
        self._hang: bool = False  # test hook: never return from embed

    def enable_fake(self) -> None:
        """Deterministic fake embeddings for tests (no network)."""
        self._fake = {}

    def enable_hang(self) -> None:
        """Test hook: embed awaits forever (simulates wedged Ollama)."""
        self._hang = True

    def _fake_embed(self, model: dict[str, Any], texts: list[str]) -> list[np.ndarray]:
        dim = int(model["dim"])
        out: list[np.ndarray] = []
        for t in texts:
            seed = int(hashlib.md5(f"{model['name']}:{t}".encode()).hexdigest()[:8], 16)
            rng = np.random.default_rng(seed)
            v = rng.standard_normal(dim).astype(np.float32)
            for tok in t.lower().split()[:8]:
                idx = int(hashlib.md5(tok.encode()).hexdigest()[:6], 16) % dim
                v[idx] += 3.0
            v /= np.linalg.norm(v) or 1.0
            out.append(v)
        return out

    async def _client_get(self) -> httpx.AsyncClient:
        if self._client is None:
            timeout = httpx.Timeout(
                connect=min(30.0, self.timeout),
                read=self.timeout,
                write=self.timeout,
                pool=self.timeout,
            )
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)
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
        if self._hang:
            await asyncio.Future()  # never completes
        prefix = model.get("query_prefix" if is_query else "document_prefix") or ""
        payloads = [prefix + t for t in texts]

        if self._fake is not None:
            return self._fake_embed(model, payloads)

        if is_query and len(payloads) == 1:
            cached = self.cache.get(model["name"], payloads[0])
            if cached is not None:
                return [cached]

        client = await self._client_get()
        results: list[np.ndarray] = []
        options: dict[str, Any] = {
            "num_thread": int(model["num_thread"])
            if model.get("num_thread") is not None
            else self.num_thread,
        }
        if model.get("num_ctx") is not None:
            options["num_ctx"] = int(model["num_ctx"])

        for i in range(0, len(payloads), self.batch_size):
            batch = payloads[i : i + self.batch_size]
            body: dict[str, Any] = {
                "model": model["name"],
                "input": batch if len(batch) > 1 else batch[0],
                "keep_alive": self.keep_alive,
                # Documents: always truncate to avoid multi-hour / 400 wedge on long Gemini turns.
                "truncate": not is_query,
                "options": options,
            }
            try:
                r = await client.post("/api/embed", json=body)
                if r.status_code >= 400:
                    log.error(
                        "ollama embed %s: %s %s",
                        model.get("name"),
                        r.status_code,
                        r.text[:500],
                    )
                r.raise_for_status()
            except httpx.TimeoutException:
                log.warning(
                    "ollama embed timeout model=%s n=%d timeout_s=%.0f",
                    model.get("name"),
                    len(batch),
                    self.timeout,
                )
                raise
            except Exception:
                log.exception("ollama embed request failed model=%s", model.get("name"))
                raise
            data = r.json()
            emb = data.get("embeddings") or data.get("embedding")
            if emb is None:
                raise RuntimeError(f"unexpected embed response: {data!r}")
            if isinstance(emb[0], (int, float)):
                emb = [emb]
            if len(emb) != len(batch):
                raise RuntimeError(
                    f"ollama embed length mismatch model={model.get('name')}: "
                    f"{len(emb)} != {len(batch)}"
                )
            for row in emb:
                results.append(np.asarray(row, dtype=np.float32))

        if len(results) != len(payloads):
            raise RuntimeError(
                f"ollama embed total length mismatch model={model.get('name')}: "
                f"{len(results)} != {len(payloads)}"
            )
        if is_query and len(payloads) == 1 and results:
            self.cache.put(model["name"], payloads[0], results[0])
        return results

    async def prewarm(self) -> None:
        if self._fake is not None or self._hang:
            return
        for model in self.models:
            try:
                await self.embed(model, ["warmup"], is_query=True)
            except Exception:
                log.exception("prewarm failed model=%s", model.get("name"))
