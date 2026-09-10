from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

from knowledge_base.config import load_config
from knowledge_base.index import LexicalIndex
from knowledge_base.ollama import OllamaClient
from knowledge_base.search import SearchEngine
from knowledge_base.store import ContentStore
from knowledge_base.vectors import VectorStore


class KnowledgeBase:
    def __init__(self, cfg: dict[str, Any] | None = None, *, fake_ollama: bool = False) -> None:
        self.cfg = cfg or load_config()
        self.data_dir = Path(self.cfg["data_dir"])
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.store = ContentStore(self.data_dir)
        bm = self.cfg.get("bm25") or {}
        self.index = LexicalIndex(
            self.store,
            self.data_dir,
            bm25_k1=float(bm.get("k1", 0.9)),
            bm25_b=float(bm.get("b", 0.75)),
        )
        self.models = list(self.cfg.get("models") or [])
        self.vector_stores = [VectorStore(self.data_dir, m) for m in self.models]
        self.ollama = OllamaClient(self.cfg, self.models)
        if fake_ollama:
            self.ollama.enable_fake()
        self.search_engine = SearchEngine(
            self.cfg, self.store, self.index, self.vector_stores, self.ollama
        )
        self._embed_q: asyncio.Queue[str] | None = None
        self._embed_task: asyncio.Task | None = None
        self._backfill_task: asyncio.Task | None = None
        self._lock = threading.RLock()

    async def start(self, *, backfill: bool = True) -> None:
        """Start embed worker. Missing embeds are queued in the background (non-blocking)."""
        self._embed_q = asyncio.Queue(maxsize=int(self.cfg.get("embed_queue_size", 64)))
        self._embed_task = asyncio.create_task(self._embed_worker())
        self._backfill_task = None
        await self.ollama.prewarm()
        if backfill:
            # Do not await: previously this blocked takeout import for minutes with no tqdm.
            self._backfill_task = asyncio.create_task(self.enqueue_missing_embeds())

    async def stop(self) -> None:
        if self._backfill_task is not None:
            try:
                await self._backfill_task
            except asyncio.CancelledError:
                pass
            self._backfill_task = None
        if self._embed_q is not None:
            # Finish queued embeds before tearing down the worker / HTTP client.
            await self._embed_q.join()
        if self._embed_task:
            self._embed_task.cancel()
            try:
                await self._embed_task
            except asyncio.CancelledError:
                pass
        await self.ollama.close()

    async def _embed_worker(self) -> None:
        assert self._embed_q is not None
        while True:
            h = await self._embed_q.get()
            try:
                await self._embed_hash(h)
            except Exception:
                pass
            finally:
                self._embed_q.task_done()

    async def _embed_hash(self, h: str) -> None:
        bref = self.store.get(h)
        if not bref:
            return
        text = (bref.text or "").strip()
        if not text:
            return
        for vs in self.vector_stores:
            if vs.has(h):
                continue
            vecs = await self.ollama.embed(vs.model, [text], is_query=False)
            if vecs:
                vs.upsert(h, vecs[0])

    async def enqueue_embed(self, hashes: list[str]) -> None:
        """Queue hashes for background embed. Never fail the store path on embed errors."""
        if self._embed_q is None:
            for h in hashes:
                try:
                    await self._embed_hash(h)
                except Exception:
                    pass
            return
        for h in hashes:
            # Backpressure instead of put_nowait + sync embed (sync path raised and aborted imports)
            await self._embed_q.put(h)

    def missing_embed_hashes(self) -> list[str]:
        """Block hashes missing from at least one vector store (deduped, stable order)."""
        hashes = [b.hash for b in self.store.all_blocks()]
        seen: set[str] = set()
        out: list[str] = []
        for vs in self.vector_stores:
            for h in vs.missing(hashes):
                if h not in seen:
                    seen.add(h)
                    out.append(h)
        return out

    async def enqueue_missing_embeds(self) -> int:
        """Queue missing embeddings for the background worker. Returns count queued."""
        missing = self.missing_embed_hashes()
        if missing:
            await self.enqueue_embed(missing)
        return len(missing)

    async def backfill_missing(self) -> int:
        """Queue missing embeddings and wait until the embed queue is drained."""
        n = await self.enqueue_missing_embeds()
        if self._embed_q is not None:
            await self._embed_q.join()
        return n

    async def store_document(
        self,
        path: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        block_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            blocks = self.store.store(
                path,
                content,
                token_budget=int(self.cfg.get("token_budget", 400)),
                metadata=metadata,
                block_metadata=block_metadata,
                metadata_max_bytes=int(self.cfg.get("metadata_max_bytes", 16384)),
            )
            self.index.rebuild()
        await self.enqueue_embed([b.hash for b in blocks])
        return {
            "path": path,
            "blocks": [{"hash": b.hash, "index": b.index, "text": b.text} for b in blocks],
        }

    def list_docs(self, *, prefix: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_docs(prefix=prefix)

    async def ingest_gemini(
        self,
        *,
        conversation_id: str,
        title: str | None,
        turns: list[dict[str, Any]],
        ingest: str = "extension",
    ) -> dict[str, Any]:
        from knowledge_base.gemini_format import (
            build_doc_metadata,
            fingerprint,
            format_markdown,
            path_for,
        )

        if not conversation_id or not str(conversation_id).strip():
            raise ValueError("conversation_id required")
        if ingest not in ("takeout", "extension"):
            raise ValueError("ingest must be 'takeout' or 'extension'")
        path = path_for(conversation_id)
        markdown = format_markdown(title, turns)
        fp = fingerprint(markdown)
        existing = self.store.get_doc_metadata(path)
        message_count = len(turns)
        if existing.get("content_fingerprint") == fp:
            return {
                "path": path,
                "skipped": True,
                "content_fingerprint": fp,
                "message_count": int(existing.get("message_count") or message_count),
            }
        meta = build_doc_metadata(
            conversation_id=conversation_id,
            title=title,
            ingest=ingest,
            turns=turns,
            markdown=markdown,
        )
        await self.store_document(path, markdown, metadata=meta)
        return {
            "path": path,
            "skipped": False,
            "content_fingerprint": fp,
            "message_count": message_count,
        }

    async def search(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self.search_engine.search(body)
