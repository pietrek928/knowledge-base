from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import numpy as np

from knowledge_base.boosts import apply_sibling_boosts
from knowledge_base.hashing import ascii_no_spaces
from knowledge_base.index import LexicalIndex
from knowledge_base.ollama import OllamaClient
from knowledge_base.store import ContentStore
from knowledge_base.tokenize import is_identifier_like, tokenize
from knowledge_base.vectors import VectorStore, truncate_renorm

try:
    import kb_native
except ImportError:  # pragma: no cover
    kb_native = None  # type: ignore


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _normalize_branch(scores: dict[str, float], kind: str) -> dict[str, float]:
    if not scores:
        return {}
    if kind == "cosine":
        return {h: (s + 1.0) / 2.0 for h, s in scores.items()}
    mx = max(scores.values()) or 1.0
    return {h: s / mx for h, s in scores.items()}


def _rrf(rank_lists: list[list[str]], k: int = 60) -> dict[str, float]:
    scores: dict[str, float] = defaultdict(float)
    for lst in rank_lists:
        for i, h in enumerate(lst):
            scores[h] += 1.0 / (k + i + 1)
    return dict(scores)


def _find_spans(text: str, phrases: list[str], cap: int = 32) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    lower = text.lower()
    for ph in phrases:
        if not ph:
            continue
        if ph.startswith("re:"):
            try:
                rx = re.compile(ph[3:], re.I)
            except re.error:
                continue
            for m in rx.finditer(text):
                spans.append({"start": m.start(), "end": m.end(), "phrase": ph})
                if len(spans) >= cap:
                    return spans
            continue
        needle = ph.lower()
        start = 0
        while True:
            i = lower.find(needle, start)
            if i < 0:
                break
            spans.append({"start": i, "end": i + len(ph), "phrase": ph})
            if len(spans) >= cap:
                return spans
            start = i + 1
    return spans


class SearchEngine:
    def __init__(
        self,
        cfg: dict[str, Any],
        store: ContentStore,
        index: LexicalIndex,
        vector_stores: list[VectorStore],
        ollama: OllamaClient,
    ) -> None:
        self.cfg = cfg
        self.store = store
        self.index = index
        self.vector_stores = vector_stores
        self.ollama = ollama

    async def search(self, body: dict[str, Any]) -> dict[str, Any]:
        phrases = body.get("phrases") or body.get("q") or []
        if isinstance(phrases, str):
            phrases = [phrases]
        phrases = [p for p in phrases if p]
        limit = int(body.get("limit", 10))
        fusion = body.get("fusion", self.cfg.get("fusion", "cc"))
        weights = dict(self.cfg.get("fusion_weights") or {})
        weights.update(body.get("weights") or {})
        adaptive = body.get("adaptive_fusion", self.cfg.get("adaptive_fusion", True))
        min_conf = body.get("min_confidence", self.cfg.get("min_confidence"))
        candidate_k = int(body.get("candidate_k", self.cfg.get("candidate_k", 50)))
        rescore_mult = int(body.get("rescore_multiplier", self.cfg.get("rescore_multiplier", 8)))
        identifier_fp = body.get("identifier_fast_path", self.cfg.get("identifier_fast_path", True))
        date_cfg = {**(self.cfg.get("date") or {}), **(body.get("date") or {})}
        meta_filter = body.get("meta") or {}
        path_prefix = body.get("path")

        exact_scores: dict[str, float] = defaultdict(float)
        fuzzy_scores: dict[str, float] = defaultdict(float)
        bm25_scores: dict[str, float] = defaultdict(float)
        embed_scores: dict[str, float] = defaultdict(float)
        keyword_hits: set[str] = set()
        embed_hits: set[str] = set()

        # lexical
        joined = " ".join(phrases)
        id_like = identifier_fp and any(is_identifier_like(p) for p in phrases)

        if len(phrases) >= 2:
            for pid, h, _s, _e in self.index.aho_search(phrases):
                exact_scores[h] += 1.0
                keyword_hits.add(h)
        for ph in phrases:
            if ph.startswith("re:"):
                try:
                    rx = re.compile(ph[3:], re.I)
                except re.error:
                    continue
                for h, text in self.index.texts.items():
                    if rx.search(text):
                        exact_scores[h] += 1.0
                        keyword_hits.add(h)
                continue
            for h, start, end, score in self.index.exact_search(ph):
                exact_scores[h] = max(exact_scores[h], score)
                keyword_hits.add(h)
            # also raw substring
            for h, text in self.index.texts.items():
                if ph.lower() in text.lower():
                    exact_scores[h] = max(exact_scores[h], 1.0)
                    keyword_hits.add(h)

            auto = body.get("fuzziness", "auto")
            min_score = 0.75 if auto == "auto" else float(auto) if isinstance(auto, (int, float)) else 0.7
            if not id_like:
                for h, start, end, score in self.index.fuzzy_search(ph, min_score=min_score):
                    fuzzy_scores[h] = max(fuzzy_scores[h], score)
                    keyword_hits.add(h)

        for h, s in self.index.bm25_scores(joined).items():
            bm25_scores[h] = s
            if s > 0:
                keyword_hits.add(h)

        # embeddings (skip when identifier fast-path and strong lexical)
        run_embed = not (id_like and exact_scores)
        if run_embed and self.vector_stores:
            for vs in self.vector_stores:
                model = vs.model
                try:
                    qvecs = await self.ollama.embed(model, [joined], is_query=True)
                except Exception:
                    continue
                if not qvecs or vs.bits is None or vs.emb is None or vs.q8 is None or vs.scales is None:
                    continue
                q = qvecs[0]
                tier_q = truncate_renorm(q, vs.mrl if vs.mrl else None)
                if kb_native is not None:
                    q_bits = np.asarray(kb_native.pack_binary(tier_q.astype(np.float32)), dtype=np.uint64)
                    # pad bits matrix width
                    bits = np.asarray(vs.bits[: len(vs.row_to_hash)])
                    if bits.size == 0:
                        continue
                    k = min(candidate_k * rescore_mult, bits.shape[0])
                    top = kb_native.hamming_topk(bits, q_bits, k)
                    row_ids = [r for r, _d in top]
                    # int8 rescore
                    scales = np.asarray(vs.scales[: len(vs.row_to_hash)], dtype=np.float32)
                    q8 = np.asarray(vs.q8[: len(vs.row_to_hash)])
                    # pad query to tier_dim
                    tq = np.zeros(vs.tier_dim, dtype=np.float32)
                    tq[: min(vs.tier_dim, tier_q.shape[0])] = tier_q[: vs.tier_dim]
                    int8_scores = kb_native.rescore_int8(tq, q8, scales, row_ids)
                    order = np.argsort(-np.asarray(int8_scores))[: max(limit * 2, 10)]
                    survivors = [row_ids[i] for i in order]
                    emb = np.asarray(vs.emb[: len(vs.row_to_hash)])
                    # convert emb to uint16 view for rescore_f16 — use numpy float16
                    emb_u16 = emb.view(np.uint16) if emb.dtype == np.float16 else emb.astype(np.float16).view(np.uint16)
                    f16_scores = kb_native.rescore_f16(q.astype(np.float32), emb_u16, survivors)
                    for rid, sc in zip(survivors, f16_scores):
                        h = vs.row_to_hash[rid]
                        embed_scores[h] = max(embed_scores[h], float(sc))
                        embed_hits.add(h)
                else:
                    # pure numpy fallback
                    emb = np.asarray(vs.emb[: len(vs.row_to_hash)], dtype=np.float32)
                    if emb.size == 0:
                        continue
                    qn = q / (np.linalg.norm(q) or 1.0)
                    sims = emb @ qn
                    top_idx = np.argsort(-sims)[:candidate_k]
                    for rid in top_idx:
                        h = vs.row_to_hash[int(rid)]
                        embed_scores[h] = max(embed_scores[h], float(sims[rid]))
                        embed_hits.add(h)

        # adaptive weights
        w = {
            "exact": float(weights.get("exact", 0.25)),
            "fuzzy": float(weights.get("fuzzy", 0.15)),
            "bm25": float(weights.get("bm25", 0.3)),
            "embed": float(weights.get("embed", 0.3)),
        }
        if adaptive:
            mean_idf = self.index.mean_idf(joined)
            if id_like or mean_idf > 2.5:
                # shift toward lexical
                w = {"exact": 0.3, "fuzzy": 0.1, "bm25": 0.35, "embed": 0.25}
            elif mean_idf < 1.0:
                w = {"exact": 0.15, "fuzzy": 0.1, "bm25": 0.25, "embed": 0.5}
            if id_like and identifier_fp:
                w["embed"] = min(w["embed"], 0.15)
                rem = 1.0 - w["embed"]
                lex = w["exact"] + w["fuzzy"] + w["bm25"]
                if lex > 0:
                    scale = rem / lex
                    w["exact"] *= scale
                    w["fuzzy"] *= scale
                    w["bm25"] *= scale

        s_exact = _normalize_branch(dict(exact_scores), "max")
        s_fuzzy = _normalize_branch(dict(fuzzy_scores), "max")
        s_bm25 = _normalize_branch(dict(bm25_scores), "max")
        s_embed = _normalize_branch(dict(embed_scores), "cosine")

        all_hashes = set(s_exact) | set(s_fuzzy) | set(s_bm25) | set(s_embed)

        if fusion == "rrf":
            lists = [
                sorted(s_exact, key=lambda h: s_exact[h], reverse=True),
                sorted(s_fuzzy, key=lambda h: s_fuzzy[h], reverse=True),
                sorted(s_bm25, key=lambda h: s_bm25[h], reverse=True),
                sorted(s_embed, key=lambda h: s_embed[h], reverse=True),
            ]
            fused = _rrf(lists, int(body.get("rrf_k", self.cfg.get("rrf_k", 60))))
        else:
            fused = {}
            for h in all_hashes:
                fused[h] = (
                    w["exact"] * s_exact.get(h, 0.0)
                    + w["fuzzy"] * s_fuzzy.get(h, 0.0)
                    + w["bm25"] * s_bm25.get(h, 0.0)
                    + w["embed"] * s_embed.get(h, 0.0)
                )

        # date / meta / path filters + date boost
        half_life = float(date_cfg.get("half_life_days", 30) or 30)
        date_w = float(date_cfg.get("weight", 0.0) or 0.0)
        d_from = _parse_dt(date_cfg.get("from"))
        d_to = _parse_dt(date_cfg.get("to"))
        d_near = _parse_dt(date_cfg.get("near"))
        now = datetime.now(timezone.utc)

        results: list[dict[str, Any]] = []
        for h, score in fused.items():
            bref = self.store.get(h)
            if not bref:
                continue
            if path_prefix and not bref.path.startswith(path_prefix):
                continue
            hit_meta = self.store.merged_metadata(bref.path, bref.metadata)
            if meta_filter:
                ok = True
                for mk, mv in meta_filter.items():
                    if hit_meta.get(mk) != mv:
                        ok = False
                        break
                if not ok:
                    continue
            updated = _parse_dt(bref.updated_at) or now
            if d_from and updated < d_from:
                continue
            if d_to and updated > d_to:
                continue
            if date_w and half_life > 0:
                ref = d_near or now
                age_days = abs((ref - updated).total_seconds()) / 86400.0
                decay = math.pow(0.5, age_days / half_life)
                score = score * (1.0 - date_w) + score * date_w * decay
            results.append(
                {
                    "hash": h,
                    "path": bref.path,
                    "text": bref.text,
                    "source": bref.source,
                    "index": bref.index,
                    "score": float(score),
                    "confidence": float(score),
                    "matches": _find_spans(bref.text, phrases),
                    "metadata": hit_meta,
                    "created_at": bref.created_at,
                    "updated_at": bref.updated_at,
                }
            )

        results.sort(key=lambda x: x["score"], reverse=True)
        results = results[: max(limit * 3, limit)]

        results = apply_sibling_boosts(
            results,
            self.store,
            phrases=phrases,
            keyword_hits=keyword_hits,
            embed_hits=embed_hits,
            sibling_window=int(body.get("sibling_window", self.cfg.get("sibling_window", 2))),
            sibling_base=float(body.get("sibling_base", self.cfg.get("sibling_base", 0.15))),
            complement_bonus=float(body.get("complement_bonus", self.cfg.get("complement_bonus", 0.2))),
            cross_signal_bonus=float(
                body.get("cross_signal_bonus", self.cfg.get("cross_signal_bonus", 0.1))
            ),
            sibling_inject_max=int(body.get("sibling_inject_max", self.cfg.get("sibling_inject_max", 2))),
        )

        if min_conf is not None:
            results = [r for r in results if r["confidence"] >= float(min_conf)]
        results = results[:limit]
        return {"results": results, "weights": w, "fusion": fusion}
