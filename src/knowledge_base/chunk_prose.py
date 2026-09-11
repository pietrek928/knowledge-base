from dataclasses import dataclass

from knowledge_base.tokenize import tokenize


@dataclass
class Chunk:
    text: str
    index: int
    start: int
    end: int


def _budget_ok(text: str, budget: int) -> bool:
    return len(tokenize(text)) <= budget


def _split_paragraphs(text: str) -> list[tuple[int, int, str]]:
    parts: list[tuple[int, int, str]] = []
    i = 0
    n = len(text)
    while i < n:
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            break
        j = text.find("\n\n", i)
        if j < 0:
            j = n
        chunk = text[i:j].strip()
        if chunk:
            # find actual span of stripped content
            start = text.find(chunk, i, j if j < n else n)
            if start < 0:
                start = i
            parts.append((start, start + len(chunk), chunk))
        i = j + 2 if j < n else n
    return parts


def _split_sentences(para: str, base: int) -> list[tuple[int, int, str]]:
    # lightweight sentence splitter
    out: list[tuple[int, int, str]] = []
    start = 0
    for i, ch in enumerate(para):
        if ch in ".!?" and i + 1 < len(para) and para[i + 1].isspace():
            piece = para[start : i + 1].strip()
            if piece:
                s = para.find(piece, start)
                out.append((base + s, base + s + len(piece), piece))
            start = i + 1
    tail = para[start:].strip()
    if tail:
        s = para.find(tail, start)
        out.append((base + s, base + s + len(tail), tail))
    return out or [(base, base + len(para), para)]


def chunk_prose(text: str, token_budget: int = 400) -> list[Chunk]:
    if not text.strip():
        return []
    paras = _split_paragraphs(text)
    if not paras:
        paras = [(0, len(text), text.strip())]

    raw: list[tuple[int, int, str]] = []
    for start, end, para in paras:
        if _budget_ok(para, token_budget):
            raw.append((start, end, para))
        else:
            for s, e, sent in _split_sentences(para, start):
                if _budget_ok(sent, token_budget):
                    raw.append((s, e, sent))
                else:
                    # hard split by tokens approx characters
                    words = sent.split()
                    buf: list[str] = []
                    cur = s
                    for w in words:
                        trial = (" ".join(buf + [w])).strip()
                        if buf and not _budget_ok(trial, token_budget):
                            piece = " ".join(buf)
                            raw.append((cur, cur + len(piece), piece))
                            cur = cur + len(piece) + 1
                            buf = [w]
                        else:
                            buf.append(w)
                    if buf:
                        piece = " ".join(buf)
                        raw.append((cur, cur + len(piece), piece))

    # merge undersized neighbors under budget
    merged: list[tuple[int, int, str]] = []
    for start, end, piece in raw:
        if merged:
            ps, pe, prev = merged[-1]
            combined = prev + " " + piece
            if _budget_ok(combined, token_budget):
                merged[-1] = (ps, end, combined)
                continue
        merged.append((start, end, piece))

    return [Chunk(text=t, index=i, start=s, end=e) for i, (s, e, t) in enumerate(merged)]
