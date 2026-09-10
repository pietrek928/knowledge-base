from __future__ import annotations

import math
import struct
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from knowledge_base.hashing import ascii_no_spaces, ascii_with_spaces, fold_ascii
from knowledge_base.store import BlockRef, ContentStore
from knowledge_base.tokenize import tokenize

try:
    import kb_native
except ImportError:  # pragma: no cover - built later
    kb_native = None  # type: ignore


@dataclass
class LexicalIndex:
    store: ContentStore
    data_dir: Path
    bm25_k1: float = 0.9
    bm25_b: float = 0.75
    _lock: threading.RLock = field(default_factory=threading.RLock)

    # concatenated corpus for SA (ascii-no-spaces) with block offsets
    corpus_nospace: str = ""
    block_ranges: list[tuple[str, int, int]] = field(default_factory=list)  # hash, start, end
    sa: list[int] = field(default_factory=list)
    lcp: list[int] = field(default_factory=list)
    trigram_entries: list[tuple[int, list[int]]] = field(default_factory=list)

    # per-block tokens
    doc_tokens: dict[str, list[str]] = field(default_factory=dict)
    doc_len: dict[str, int] = field(default_factory=dict)
    df: Counter = field(default_factory=Counter)
    avgdl: float = 1.0
    N: int = 0

    # raw / spaced text per block for matching
    texts: dict[str, str] = field(default_factory=dict)
    texts_spaced: dict[str, str] = field(default_factory=dict)
    texts_nospace: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        (self.data_dir / "index").mkdir(parents=True, exist_ok=True)
        self.rebuild()

    def rebuild(self) -> None:
        with self._lock:
            blocks = self.store.all_blocks()
            self.texts = {}
            self.texts_spaced = {}
            self.texts_nospace = {}
            self.doc_tokens = {}
            self.doc_len = {}
            self.df = Counter()
            parts: list[str] = []
            ranges: list[tuple[str, int, int]] = []
            cursor = 0
            sep = "\x00"
            for b in blocks:
                self.texts[b.hash] = b.text
                self.texts_spaced[b.hash] = ascii_with_spaces(b.text)
                ns = ascii_no_spaces(b.text)
                self.texts_nospace[b.hash] = ns
                toks = tokenize(b.text)
                self.doc_tokens[b.hash] = toks
                self.doc_len[b.hash] = len(toks)
                for t in set(toks):
                    self.df[t] += 1
                start = cursor
                parts.append(ns)
                cursor += len(ns)
                ranges.append((b.hash, start, cursor))
                parts.append(sep)
                cursor += 1
            self.corpus_nospace = "".join(parts)
            self.block_ranges = ranges
            self.N = len(blocks) or 1
            self.avgdl = (sum(self.doc_len.values()) / self.N) if blocks else 1.0
            if kb_native and self.corpus_nospace:
                self.sa = kb_native.build_suffix_array(self.corpus_nospace)
                self.lcp = kb_native.build_lcp(self.corpus_nospace, self.sa)
                self.trigram_entries = kb_native.build_trigrams(self.corpus_nospace)
            else:
                self.sa = list(range(len(self.corpus_nospace)))
                self.lcp = []
                self.trigram_entries = []
            self._write_snapshot()

    def _write_snapshot(self) -> None:
        # lightweight metadata snapshot; full SA rebuild is fast enough for small corpora
        path = self.data_dir / "index" / "lexical.meta.txt"
        path.write_text(f"N={self.N}\navgdl={self.avgdl}\ncorpus_len={len(self.corpus_nospace)}\n")

    def block_at_offset(self, offset: int) -> str | None:
        for h, start, end in self.block_ranges:
            if start <= offset < end:
                return h
        return None

    def idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        # BM25+ style IDF
        return math.log(1.0 + (self.N - df + 0.5) / (df + 0.5))

    def exact_search(self, pattern: str, max_hits: int = 500) -> list[tuple[str, int, int, float]]:
        """Return (hash, local_start, local_end, score) using nospace corpus."""
        pat = ascii_no_spaces(pattern)
        if not pat or not self.corpus_nospace:
            return []
        hits: list[tuple[str, int, int, float]] = []
        if kb_native:
            raw = kb_native.sa_find(self.corpus_nospace, self.sa, pat, max_hits)
            for start, end, score in raw:
                h = self.block_at_offset(start)
                if not h:
                    continue
                # map to local offset in nospace text — approximate to plain text via find
                local = self.texts[h].lower().find(pattern.lower()[: min(20, len(pattern))])
                if local < 0:
                    local = 0
                hits.append((h, local, local + len(pattern), float(score)))
        else:
            start = 0
            while True:
                i = self.corpus_nospace.find(pat, start)
                if i < 0:
                    break
                h = self.block_at_offset(i)
                if h:
                    hits.append((h, 0, len(pattern), 1.0))
                start = i + 1
                if len(hits) >= max_hits:
                    break
        return hits

    def aho_search(self, patterns: list[str]) -> list[tuple[int, str, int, int]]:
        if not patterns or not kb_native:
            return []
        folded = [ascii_no_spaces(p) for p in patterns]
        ac = kb_native.AhoCorasick()
        ac.build(folded)
        raw = ac.search(self.corpus_nospace)
        out: list[tuple[int, str, int, int]] = []
        for pid, start, end in raw:
            h = self.block_at_offset(start)
            if h:
                out.append((pid, h, start, end))
        return out

    def fuzzy_search(
        self, pattern: str, min_score: float = 0.7, max_hits: int = 50
    ) -> list[tuple[str, int, int, float]]:
        if not kb_native or not pattern:
            return []
        pat = ascii_no_spaces(pattern)
        cands = kb_native.trigram_candidates(self.trigram_entries, pat, 200) if len(pat) >= 3 else []
        hits = kb_native.fuzzy_window_search(self.corpus_nospace, pat, min_score, max_hits, cands)
        out: list[tuple[str, int, int, float]] = []
        for start, end, score in hits:
            h = self.block_at_offset(start)
            if h:
                out.append((h, 0, len(pattern), float(score)))
        return out

    def bm25_scores(self, query: str) -> dict[str, float]:
        q_terms = tokenize(query)
        if not q_terms:
            return {}
        idfs = [self.idf(t) for t in q_terms]
        scores: dict[str, float] = {}
        if kb_native:
            tfs_list: list[list[int]] = []
            hashes: list[str] = []
            lens: list[int] = []
            for h, toks in self.doc_tokens.items():
                c = Counter(toks)
                tfs_list.append([c.get(t, 0) for t in q_terms])
                hashes.append(h)
                lens.append(self.doc_len[h])
            vals = kb_native.bm25_batch(tfs_list, idfs, lens, float(self.avgdl), self.bm25_k1, self.bm25_b)
            for h, s in zip(hashes, vals):
                if s > 0:
                    scores[h] = float(s)
        else:
            for h, toks in self.doc_tokens.items():
                c = Counter(toks)
                tfs = [c.get(t, 0) for t in q_terms]
                s = 0.0
                dl = self.doc_len[h]
                for tf, idf in zip(tfs, idfs):
                    if tf <= 0:
                        continue
                    norm = 1 - self.bm25_b + self.bm25_b * (dl / self.avgdl)
                    s += idf * (tf * (self.bm25_k1 + 1)) / (tf + self.bm25_k1 * norm)
                if s > 0:
                    scores[h] = s
        return scores

    def mean_idf(self, query: str) -> float:
        terms = tokenize(query)
        if not terms:
            return 0.0
        return sum(self.idf(t) for t in terms) / len(terms)
