import asyncio
import math
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from knowledge_base.hashing import ascii_no_spaces
from knowledge_base.store import ContentStore
from knowledge_base.tokenize import tokenize

try:
    import kb_native
except ImportError:  # pragma: no cover - built later
    kb_native = None  # type: ignore


@dataclass(frozen=True)
class LexicalSnapshot:
    corpus_nospace: str
    block_ranges: list[tuple[str, int, int]]
    sa: list[int]
    trigram_entries: list[tuple[int, list[int]]]
    doc_tokens: dict[str, list[str]]
    doc_len: dict[str, int]
    df: Counter
    avgdl: float
    N: int
    texts: dict[str, str]


def build_lexical_snapshot(blocks: list[tuple[str, str]]) -> LexicalSnapshot:
    """Pure builder: never touches a live LexicalIndex. Safe to run in to_thread."""
    texts: dict[str, str] = {}
    doc_tokens: dict[str, list[str]] = {}
    doc_len: dict[str, int] = {}
    df: Counter = Counter()
    parts: list[str] = []
    ranges: list[tuple[str, int, int]] = []
    cursor = 0
    sep = "\x00"
    for h, text in blocks:
        texts[h] = text
        ns = ascii_no_spaces(text)
        toks = tokenize(text)
        doc_tokens[h] = toks
        doc_len[h] = len(toks)
        for t in set(toks):
            df[t] += 1
        start = cursor
        parts.append(ns)
        cursor += len(ns)
        ranges.append((h, start, cursor))
        parts.append(sep)
        cursor += 1
    corpus_nospace = "".join(parts)
    n = len(blocks) or 1
    avgdl = (sum(doc_len.values()) / n) if blocks else 1.0
    if kb_native and corpus_nospace:
        sa = kb_native.build_suffix_array(corpus_nospace)
        trigram_entries = kb_native.build_trigrams(corpus_nospace)
    else:
        sa = list(range(len(corpus_nospace)))
        trigram_entries = []
    return LexicalSnapshot(
        corpus_nospace=corpus_nospace,
        block_ranges=ranges,
        sa=sa,
        trigram_entries=trigram_entries,
        doc_tokens=doc_tokens,
        doc_len=doc_len,
        df=df,
        avgdl=avgdl,
        N=n,
        texts=texts,
    )


@dataclass
class LexicalIndex:
    store: ContentStore
    data_dir: Path
    bm25_k1: float = 0.9
    bm25_b: float = 0.75
    _lock: threading.RLock = field(default_factory=threading.RLock)

    corpus_nospace: str = ""
    block_ranges: list[tuple[str, int, int]] = field(default_factory=list)
    sa: list[int] = field(default_factory=list)
    trigram_entries: list[tuple[int, list[int]]] = field(default_factory=list)

    doc_tokens: dict[str, list[str]] = field(default_factory=dict)
    doc_len: dict[str, int] = field(default_factory=dict)
    df: Counter = field(default_factory=Counter)
    avgdl: float = 1.0
    N: int = 0

    texts: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        (self.data_dir / "index").mkdir(parents=True, exist_ok=True)
        blocks = [(b.hash, b.text) for b in self.store.all_blocks()]
        self.publish(build_lexical_snapshot(blocks))

    def publish(self, snap: LexicalSnapshot) -> None:
        """Atomic swap of a fully built snapshot (short critical section)."""
        with self._lock:
            self.corpus_nospace = snap.corpus_nospace
            self.block_ranges = snap.block_ranges
            self.sa = snap.sa
            self.trigram_entries = snap.trigram_entries
            self.doc_tokens = snap.doc_tokens
            self.doc_len = snap.doc_len
            self.df = snap.df
            self.avgdl = snap.avgdl
            self.N = snap.N
            self.texts = snap.texts
        self._write_snapshot(snap)

    def rebuild(self) -> None:
        """Sync rebuild from store (startup / tests). Prefer rebuild_from_blocks_async live."""
        blocks = [(b.hash, b.text) for b in self.store.all_blocks()]
        self.publish(build_lexical_snapshot(blocks))

    async def rebuild_from_blocks_async(self, blocks: list[tuple[str, str]]) -> None:
        snap = await asyncio.to_thread(build_lexical_snapshot, blocks)
        self.publish(snap)

    def _write_snapshot(self, snap: LexicalSnapshot | None = None) -> None:
        n = snap.N if snap is not None else self.N
        avgdl = snap.avgdl if snap is not None else self.avgdl
        corpus_len = len(snap.corpus_nospace) if snap is not None else len(self.corpus_nospace)
        path = self.data_dir / "index" / "lexical.meta.txt"
        path.write_text(f"N={n}\navgdl={avgdl}\ncorpus_len={corpus_len}\n")

    def block_at_offset(self, offset: int) -> str | None:
        for h, start, end in self.block_ranges:
            if start <= offset < end:
                return h
        return None

    def idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        return math.log(1.0 + (self.N - df + 0.5) / (df + 0.5))

    def exact_search(self, pattern: str, max_hits: int = 500) -> list[tuple[str, int, int, float]]:
        """Return (hash, local_start, local_end, score) using nospace corpus."""
        pat = ascii_no_spaces(pattern)
        with self._lock:
            corpus = self.corpus_nospace
            sa = self.sa
            ranges = list(self.block_ranges)
            texts = self.texts
        if not pat or not corpus:
            return []

        def _block_at(offset: int) -> str | None:
            for h, start, end in ranges:
                if start <= offset < end:
                    return h
            return None

        hits: list[tuple[str, int, int, float]] = []
        if kb_native:
            raw = kb_native.sa_find(corpus, sa, pat, max_hits)
            for start, _end, score in raw:
                h = _block_at(start)
                if not h:
                    continue
                local = texts[h].lower().find(pattern.lower()[: min(20, len(pattern))])
                if local < 0:
                    local = 0
                hits.append((h, local, local + len(pattern), float(score)))
        else:
            start = 0
            while True:
                i = corpus.find(pat, start)
                if i < 0:
                    break
                h = _block_at(i)
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
        with self._lock:
            corpus = self.corpus_nospace
            ranges = list(self.block_ranges)
        ac = kb_native.AhoCorasick()
        ac.build(folded)
        raw = ac.search(corpus)
        out: list[tuple[int, str, int, int]] = []

        def _block_at(offset: int) -> str | None:
            for h, start, end in ranges:
                if start <= offset < end:
                    return h
            return None

        for pid, start, end in raw:
            h = _block_at(start)
            if h:
                out.append((pid, h, start, end))
        return out

    def fuzzy_search(
        self, pattern: str, min_score: float = 0.7, max_hits: int = 50
    ) -> list[tuple[str, int, int, float]]:
        if not kb_native or not pattern:
            return []
        pat = ascii_no_spaces(pattern)
        with self._lock:
            corpus = self.corpus_nospace
            trigrams = self.trigram_entries
            ranges = list(self.block_ranges)
        cands = kb_native.trigram_candidates(trigrams, pat, 200) if len(pat) >= 3 else []
        hits = kb_native.fuzzy_window_search(corpus, pat, min_score, max_hits, cands)
        out: list[tuple[str, int, int, float]] = []

        def _block_at(offset: int) -> str | None:
            for h, start, end in ranges:
                if start <= offset < end:
                    return h
            return None

        for start, _end, score in hits:
            h = _block_at(start)
            if h:
                out.append((h, 0, len(pattern), float(score)))
        return out

    def bm25_scores(self, query: str) -> dict[str, float]:
        q_terms = tokenize(query)
        if not q_terms:
            return {}
        with self._lock:
            doc_tokens = self.doc_tokens
            doc_len = self.doc_len
            avgdl = self.avgdl
            n = self.N
            df = self.df
            k1 = self.bm25_k1
            b = self.bm25_b

        def _idf(term: str) -> float:
            d = df.get(term, 0)
            return math.log(1.0 + (n - d + 0.5) / (d + 0.5))

        idfs = [_idf(t) for t in q_terms]
        scores: dict[str, float] = {}
        if kb_native:
            tfs_list: list[list[int]] = []
            hashes: list[str] = []
            lens: list[int] = []
            for h, toks in doc_tokens.items():
                c = Counter(toks)
                tfs_list.append([c.get(t, 0) for t in q_terms])
                hashes.append(h)
                lens.append(doc_len[h])
            vals = kb_native.bm25_batch(tfs_list, idfs, lens, float(avgdl), k1, b)
            for h, s in zip(hashes, vals):
                if s > 0:
                    scores[h] = float(s)
        else:
            for h, toks in doc_tokens.items():
                c = Counter(toks)
                tfs = [c.get(t, 0) for t in q_terms]
                s = 0.0
                dl = doc_len[h]
                for tf, idf in zip(tfs, idfs):
                    if tf <= 0:
                        continue
                    norm = 1 - b + b * (dl / avgdl)
                    s += idf * (tf * (k1 + 1)) / (tf + k1 * norm)
                if s > 0:
                    scores[h] = s
        return scores

    def mean_idf(self, query: str) -> float:
        terms = tokenize(query)
        if not terms:
            return 0.0
        with self._lock:
            n = self.N
            df = self.df
        total = 0.0
        for t in terms:
            d = df.get(t, 0)
            total += math.log(1.0 + (n - d + 0.5) / (d + 0.5))
        return total / len(terms)

    def texts_items(self) -> list[tuple[str, str]]:
        with self._lock:
            return list(self.texts.items())
