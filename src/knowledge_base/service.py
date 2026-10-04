import asyncio
import contextlib
import logging
import threading
from pathlib import Path
from typing import Any

import httpx

from knowledge_base.config import load_config
from knowledge_base.index import LexicalIndex
from knowledge_base.ollama import OllamaClient
from knowledge_base.search import SearchEngine
from knowledge_base.store import ContentStore
from knowledge_base.vectors import VectorStore

log = logging.getLogger(__name__)


def embeddings_configured(cfg: dict[str, Any]) -> bool:
    """True when models are set and Ollama is not explicitly disabled."""
    if not list(cfg.get("models") or []):
        return False
    if "ollama" in cfg:
        o = cfg["ollama"]
        if o is False or o is None:
            return False
        if isinstance(o, dict) and o.get("enabled") is False:
            return False
    return True


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
        self.embeddings_enabled = embeddings_configured(self.cfg)
        self.models = list(self.cfg.get("models") or []) if self.embeddings_enabled else []
        self.vector_stores = [VectorStore(self.data_dir, m) for m in self.models]
        self.ollama = OllamaClient(self.cfg, self.models)
        if fake_ollama:
            self.ollama.enable_fake()
        self.search_engine = SearchEngine(
            self.cfg,
            self.store,
            self.index,
            self.vector_stores,
            self.ollama,
            embeddings_enabled=self.embeddings_enabled,
        )
        self._embed_q: asyncio.Queue[str] | None = None
        self._embed_task: asyncio.Task | None = None
        self._embed_queued: set[str] = set()
        self._embed_queued_lock = threading.Lock()
        self._lock = threading.RLock()
        ollama_cfg = self.cfg.get("ollama") if isinstance(self.cfg.get("ollama"), dict) else {}
        self._batch_size = int((ollama_cfg or {}).get("batch_size", 4))

    async def start(self, *, backfill: bool = True) -> None:
        """Start the embed worker when embeddings are configured."""
        if not self.embeddings_enabled:
            return
        self._embed_q = asyncio.Queue()  # unbounded — store must never block on put
        self._embed_task = asyncio.create_task(self._embed_worker())
        await self.ollama.prewarm()
        if backfill:
            self.submit_embed(self.missing_embed_hashes())

    async def drain_embeds(self) -> None:
        if self._embed_q is not None:
            await self._embed_q.join()

    async def stop(self, *, drain: bool = True) -> None:
        if drain:
            await self.drain_embeds()
        if self._embed_task:
            self._embed_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._embed_task
            self._embed_task = None
        self._embed_q = None
        with self._embed_queued_lock:
            self._embed_queued.clear()
        await self.ollama.close()

    def pending_embed_count(self) -> int:
        with self._embed_queued_lock:
            return len(self._embed_queued)

    def submit_embed(self, hashes: list[str]) -> int:
        """Non-blocking enqueue. Returns number newly queued. Safe during store."""
        if not self.embeddings_enabled or self._embed_q is None or not hashes:
            return 0
        n = 0
        with self._embed_queued_lock:
            for h in hashes:
                if not h or h in self._embed_queued:
                    continue
                self._embed_queued.add(h)
                self._embed_q.put_nowait(h)
                n += 1
        return n

    def missing_embed_hashes(self) -> list[str]:
        """Non-empty block hashes missing from at least one vector store."""
        if not self.embeddings_enabled:
            return []
        hashes = [b.hash for b in self.store.all_blocks() if (b.text or "").strip()]
        seen: set[str] = set()
        out: list[str] = []
        for vs in self.vector_stores:
            for h in vs.missing(hashes):
                if h not in seen:
                    seen.add(h)
                    out.append(h)
        return out

    async def backfill_missing(self) -> int:
        """Queue missing embeddings and wait until drained (tests / explicit catch-up)."""
        if not self.embeddings_enabled:
            return 0
        missing = self.missing_embed_hashes()
        self.submit_embed(missing)
        await self.drain_embeds()
        return len(missing)

    async def _embed_worker(self) -> None:
        assert self._embed_q is not None
        while True:
            first = await self._embed_q.get()
            batch = [first]
            while len(batch) < self._batch_size:
                try:
                    batch.append(self._embed_q.get_nowait())
                except asyncio.QueueEmpty:
                    break
            try:
                await self._embed_batch(batch)
            except Exception:
                log.exception("embed batch failed (%d hashes)", len(batch))
            finally:
                with self._embed_queued_lock:
                    for h in batch:
                        self._embed_queued.discard(h)
                for _ in batch:
                    self._embed_q.task_done()

    async def _embed_batch(self, hashes: list[str]) -> None:
        items: list[tuple[str, str]] = []
        for h in hashes:
            bref = self.store.get(h)
            if not bref:
                continue
            text = (bref.text or "").strip()
            if text:
                items.append((h, text))
        if not items:
            return
        hs = [h for h, _ in items]
        texts = [t for _, t in items]

        # One model at a time — parallel dual-model embeds share Ollama's queue while
        # each httpx read timer runs, which causes ReadTimeouts on CPU.
        for vs in self.vector_stores:
            need_h: list[str] = []
            need_t: list[str] = []
            for h, t in zip(hs, texts):
                if not vs.has(h):
                    need_h.append(h)
                    need_t.append(t)
            if not need_t:
                continue
            try:
                vecs = await self.ollama.embed(vs.model, need_t, is_query=False)
            except httpx.TimeoutException:
                continue  # already warned in OllamaClient
            except Exception:
                log.exception("embed failed model=%s n=%d", vs.model.get("name"), len(need_t))
                continue
            if len(vecs) != len(need_t):
                raise RuntimeError(
                    f"embed length mismatch model={vs.model.get('name')}: "
                    f"{len(vecs)} != {len(need_t)}"
                )
            for h, v in zip(need_h, vecs):
                vs.upsert(h, v)

    async def rebuild_index(self) -> None:
        """Snapshot lexical index off-thread and publish under lock."""
        blocks = [(b.hash, b.text) for b in self.store.all_blocks()]
        await self.index.rebuild_from_blocks_async(blocks)

    async def store_document(
        self,
        path: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        block_metadata: dict[str, Any] | None = None,
        *,
        embed: bool = True,
        rebuild_index: bool = True,
    ) -> dict[str, Any]:
        if not self.embeddings_enabled:
            embed = False
        with self._lock:
            blocks = self.store.store(
                path,
                content,
                token_budget=int(self.cfg.get("token_budget", 400)),
                metadata=metadata,
                block_metadata=block_metadata,
                metadata_max_bytes=int(self.cfg.get("metadata_max_bytes", 16384)),
            )
        if embed:
            self.submit_embed([b.hash for b in blocks])
        if rebuild_index:
            await self.rebuild_index()
        return {
            "path": path,
            "blocks": [{"hash": b.hash, "index": b.index, "text": b.text} for b in blocks],
            "embeddings": self.embeddings_enabled,
        }

    def list_docs(self, *, prefix: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_docs(prefix=prefix)

    def get_document(self, path: str) -> dict[str, Any] | None:
        return self.store.get_document(path)

    async def ingest_gemini(
        self,
        *,
        conversation_id: str,
        title: str | None,
        turns: list[dict[str, Any]],
        ingest: str = "extension",
        embed: bool = True,
        rebuild_index: bool = True,
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
        if not self.embeddings_enabled:
            embed = False
        path = path_for(conversation_id)
        markdown = format_markdown(title, turns)
        fp = fingerprint(markdown)
        existing = self.store.get_doc_metadata(path)
        message_count = len(turns)
        if existing.get("content_fingerprint") == fp:
            if embed:
                # Heal embed gaps without re-storing unchanged content.
                self.submit_embed(list(self.store.path_blocks.get(path) or []))
            return {
                "path": path,
                "skipped": True,
                "content_fingerprint": fp,
                "message_count": int(existing.get("message_count") or message_count),
                "embeddings": self.embeddings_enabled,
            }
        meta = build_doc_metadata(
            conversation_id=conversation_id,
            title=title,
            ingest=ingest,
            turns=turns,
            markdown=markdown,
        )
        result = await self.store_document(
            path, markdown, metadata=meta, embed=embed, rebuild_index=rebuild_index
        )
        return {
            "path": path,
            "skipped": False,
            "content_fingerprint": fp,
            "message_count": message_count,
            "embeddings": result.get("embeddings", self.embeddings_enabled),
        }

    async def search(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self.search_engine.search(body)
