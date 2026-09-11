import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from knowledge_base.align import chunk_document
from knowledge_base.hashing import disambiguate_hash, hash_text
from knowledge_base.plainify import to_plain


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass
class BlockRef:
    path: str
    hash: str
    text: str
    source: str
    index: int
    created_at: str
    updated_at: str
    metadata: dict[str, Any] = field(default_factory=dict)


class ContentStore:
    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.content_dir = self.data_dir / "content"
        self.content_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.blocks: dict[str, BlockRef] = {}  # hash -> block
        self.hash_to_plain: dict[str, str] = {}
        self.path_blocks: dict[str, list[str]] = {}  # path -> ordered hashes
        self.path_metadata: dict[str, dict[str, Any]] = {}  # path -> doc metadata
        self._load_all()

    def _doc_path(self, path: str) -> Path:
        # path is relative document id; store as content/<path>.json
        safe = path.lstrip("/")
        p = self.content_dir / f"{safe}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _load_all(self) -> None:
        if not self.content_dir.exists():
            return
        for fp in self.content_dir.rglob("*.json"):
            rel = fp.relative_to(self.content_dir)
            # strip .json
            path = str(rel)[:-5] if str(rel).endswith(".json") else str(rel)
            try:
                doc = orjson.loads(fp.read_bytes())
            except Exception:
                continue
            hashes: list[str] = []
            for b in doc.get("blocks", []):
                href = BlockRef(
                    path=path,
                    hash=b["hash"],
                    text=b["text"],
                    source=b.get("source", b["text"]),
                    index=int(b.get("index", 0)),
                    created_at=b.get("created_at", doc.get("updated_at", utc_now())),
                    updated_at=b.get("updated_at", doc.get("updated_at", utc_now())),
                    metadata=b.get("metadata") or {},
                )
                self.blocks[href.hash] = href
                self.hash_to_plain[href.hash] = href.text
                hashes.append(href.hash)
            self.path_blocks[path] = hashes
            doc_meta = doc.get("metadata")
            if isinstance(doc_meta, dict) and doc_meta:
                self.path_metadata[path] = dict(doc_meta)
            else:
                self.path_metadata.pop(path, None)

    def get_doc_metadata(self, path: str) -> dict[str, Any]:
        with self._lock:
            return dict(self.path_metadata.get(path) or {})

    def merged_metadata(
        self, path: str, block_meta: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Doc metadata merged with block metadata; block keys win on conflict."""
        with self._lock:
            out = dict(self.path_metadata.get(path) or {})
            if block_meta:
                out.update(block_meta)
            return out

    def list_docs(self, *, prefix: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            paths = sorted(self.path_blocks.keys())
            if prefix:
                paths = [p for p in paths if p.startswith(prefix)]
            return [
                {
                    "path": p,
                    "metadata": dict(self.path_metadata.get(p) or {}),
                    "block_count": len(self.path_blocks.get(p) or []),
                }
                for p in paths
            ]

    def store(
        self,
        path: str,
        content: str,
        *,
        token_budget: int = 400,
        metadata: dict[str, Any] | None = None,
        block_metadata: dict[str, Any] | None = None,
        metadata_max_bytes: int = 16384,
    ) -> list[BlockRef]:
        """Store document. ``metadata`` is document-level; ``block_metadata`` tags each block."""
        with self._lock:
            chunks = chunk_document(content, path=path, token_budget=token_budget)
            now = utc_now()
            old_hashes = set(self.path_blocks.get(path, []))
            new_blocks: list[BlockRef] = []
            used: dict[str, str] = dict(self.hash_to_plain)

            doc_meta = dict(metadata or {})
            block_meta_base = dict(block_metadata or {})
            if doc_meta:
                meta_bytes = orjson.dumps(doc_meta)
                if len(meta_bytes) > metadata_max_bytes:
                    raise ValueError("metadata too large")
            if block_meta_base:
                meta_bytes = orjson.dumps(block_meta_base)
                if len(meta_bytes) > metadata_max_bytes:
                    raise ValueError("block_metadata too large")

            for ch in chunks:
                plain = to_plain(ch.text) if ch.text != ch.source else ch.text
                # for code, text==source; ensure plain
                if plain != ch.text and ch.source == ch.text:
                    plain = ch.text
                # always plainify source-derived text for markup docs
                from knowledge_base.plainify import sniff_kind

                kind = sniff_kind(ch.source)
                if kind in ("html", "markdown"):
                    plain = to_plain(ch.source, kind=kind)
                else:
                    plain = ch.text.strip() or to_plain(ch.source)

                base = hash_text(plain)
                if not base:
                    continue
                h = disambiguate_hash(base, plain, used)
                used[h] = plain
                prev = self.blocks.get(h)
                created = prev.created_at if prev and prev.text == plain else now
                meta = dict(block_meta_base)
                if prev and prev.path == path and prev.metadata:
                    meta = {**prev.metadata, **meta}
                bref = BlockRef(
                    path=path,
                    hash=h,
                    text=plain,
                    source=ch.source,
                    index=ch.index,
                    created_at=created,
                    updated_at=now,
                    metadata=meta,
                )
                new_blocks.append(bref)

            # remove old path mappings for hashes no longer present
            new_hash_set = {b.hash for b in new_blocks}
            for oh in old_hashes - new_hash_set:
                old = self.blocks.get(oh)
                if old and old.path == path:
                    del self.blocks[oh]
                    self.hash_to_plain.pop(oh, None)

            for b in new_blocks:
                self.blocks[b.hash] = b
                self.hash_to_plain[b.hash] = b.text
            self.path_blocks[path] = [b.hash for b in new_blocks]
            if doc_meta:
                self.path_metadata[path] = doc_meta
            else:
                self.path_metadata.pop(path, None)

            doc: dict[str, Any] = {
                "updated_at": now,
                "blocks": [
                    {
                        "hash": b.hash,
                        "text": b.text,
                        "source": b.source,
                        "index": b.index,
                        "created_at": b.created_at,
                        "updated_at": b.updated_at,
                        **({"metadata": b.metadata} if b.metadata else {}),
                    }
                    for b in new_blocks
                ],
            }
            if doc_meta:
                doc["metadata"] = doc_meta
            self._doc_path(path).write_bytes(orjson.dumps(doc, option=orjson.OPT_INDENT_2))
            return new_blocks

    def all_blocks(self) -> list[BlockRef]:
        with self._lock:
            return list(self.blocks.values())

    def get(self, h: str) -> BlockRef | None:
        return self.blocks.get(h)
