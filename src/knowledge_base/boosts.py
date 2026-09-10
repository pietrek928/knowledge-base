from __future__ import annotations

from collections import defaultdict
from typing import Any

from knowledge_base.store import BlockRef, ContentStore
from knowledge_base.tokenize import tokenize


def apply_sibling_boosts(
    ranked: list[dict[str, Any]],
    store: ContentStore,
    *,
    phrases: list[str],
    keyword_hits: set[str],
    embed_hits: set[str],
    sibling_window: int = 2,
    sibling_base: float = 0.15,
    complement_bonus: float = 0.2,
    cross_signal_bonus: float = 0.1,
    sibling_inject_max: int = 2,
) -> list[dict[str, Any]]:
    """Boost neighbors and inject missing siblings when complements match."""
    by_hash = {r["hash"]: r for r in ranked}
    path_index: dict[str, list[BlockRef]] = {}
    for b in store.all_blocks():
        path_index.setdefault(b.path, [])
    for b in store.all_blocks():
        path_index[b.path].append(b)
    for p in path_index:
        path_index[p].sort(key=lambda x: x.index)

    # phrase coverage per block
    phrase_toks = [set(tokenize(p)) for p in phrases if p.strip()]

    def coverage(text: str) -> set[int]:
        toks = set(tokenize(text))
        return {i for i, pt in enumerate(phrase_toks) if pt and pt & toks}

    boosts: dict[str, float] = defaultdict(float)
    inject: list[dict[str, Any]] = []

    for r in list(ranked):
        bref = store.get(r["hash"])
        if not bref:
            continue
        neighbors = path_index.get(bref.path, [])
        # find position
        pos = next((i for i, x in enumerate(neighbors) if x.hash == bref.hash), -1)
        if pos < 0:
            continue
        cov = coverage(bref.text)
        for dist in range(1, sibling_window + 1):
            for nb_pos in (pos - dist, pos + dist):
                if nb_pos < 0 or nb_pos >= len(neighbors):
                    continue
                nb = neighbors[nb_pos]
                decay = sibling_base / dist
                boosts[nb.hash] += decay
                boosts[bref.hash] += decay * 0.25
                # complement: neighbor covers other phrases
                nb_cov = coverage(nb.text)
                if phrase_toks and cov and nb_cov and (nb_cov - cov):
                    boosts[bref.hash] += complement_bonus
                    boosts[nb.hash] += complement_bonus
                    if nb.hash not in by_hash and len(inject) < sibling_inject_max * len(ranked):
                        inject.append(
                            {
                                "hash": nb.hash,
                                "path": nb.path,
                                "text": nb.text,
                                "source": nb.source,
                                "index": nb.index,
                                "score": r["score"] * 0.5,
                                "confidence": r.get("confidence", r["score"]) * 0.5,
                                "matches": [],
                                "metadata": store.merged_metadata(nb.path, nb.metadata),
                                "created_at": nb.created_at,
                                "updated_at": nb.updated_at,
                                "_injected": True,
                            }
                        )
                # cross-signal
                if bref.hash in keyword_hits and nb.hash in embed_hits:
                    boosts[bref.hash] += cross_signal_bonus
                    boosts[nb.hash] += cross_signal_bonus
                if bref.hash in embed_hits and nb.hash in keyword_hits:
                    boosts[bref.hash] += cross_signal_bonus
                    boosts[nb.hash] += cross_signal_bonus

    for r in ranked:
        r["score"] = float(r["score"]) + boosts.get(r["hash"], 0.0)
        r["confidence"] = float(r.get("confidence", r["score"]))
    for item in inject:
        item["score"] = float(item["score"]) + boosts.get(item["hash"], 0.0)
        if item["hash"] not in by_hash:
            ranked.append(item)
            by_hash[item["hash"]] = item

    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked
