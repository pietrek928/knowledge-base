"""Structure-aware chunking for markdown sources (fence-safe, no reverse-align)."""

from __future__ import annotations

import re

from knowledge_base.chunk_prose import Chunk, _budget_ok

_TURN = re.compile(r"(?m)^(\*\*(?:User|Gemini)\*\*)")
_HEADING = re.compile(r"(?m)^#{1,6}\s")
_LIST_ITEM = re.compile(r"(?m)^(?:\s*[-*+]\s|\s*\d+\.\s)")
_SENTENCE_END = re.compile(r'[.!?]["\')\]]?(?:\s+|$)')
_FENCE_LINE = re.compile(r"^( {0,3})([`~]{3,})(.*)$")


def find_fence_ranges(text: str) -> list[tuple[int, int]]:
    """Return [start, end) spans of GFM fenced code blocks (incl. open/close lines)."""
    ranges: list[tuple[int, int]] = []
    lines: list[tuple[int, str]] = []
    pos = 0
    for line in text.splitlines(keepends=True):
        lines.append((pos, line))
        pos += len(line)

    i = 0
    while i < len(lines):
        raw = lines[i][1].rstrip("\r\n")
        m = _FENCE_LINE.match(raw)
        if not m:
            i += 1
            continue
        tick = m.group(2)[0]
        n_ticks = len(m.group(2))
        start = lines[i][0]
        i += 1
        closed = False
        close_re = re.compile(rf"^( {{0,3}}){re.escape(tick)}{{{n_ticks},}}\s*$")
        while i < len(lines):
            if close_re.match(lines[i][1].rstrip("\r\n")):
                end = lines[i][0] + len(lines[i][1])
                ranges.append((start, end))
                i += 1
                closed = True
                break
            i += 1
        if not closed:
            ranges.append((start, len(text)))
            break
    return ranges


def _in_ranges(pos: int, ranges: list[tuple[int, int]]) -> bool:
    for s, e in ranges:
        if s <= pos < e:
            return True
    return False


def _mask_protected_spans(text: str, fences: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Fences plus simple $...$ / $$...$$ and **...** spans for cut avoidance."""
    spans = list(fences)
    for m in re.finditer(r"\$\$[\s\S]+?\$\$|\$[^$\n]+\$", text):
        spans.append((m.start(), m.end()))
    for m in re.finditer(r"\*\*[^*]+?\*\*", text):
        spans.append((m.start(), m.end()))
    spans.sort()
    return spans


def _safe_cut_points(text: str, fences: list[tuple[int, int]]) -> list[int]:
    """Exclusive end offsets where a chunk may end (contiguous cover)."""
    protected = _mask_protected_spans(text, fences)
    cuts: set[int] = {len(text)}

    def add(pos: int) -> None:
        if 0 < pos <= len(text) and not _in_ranges(pos, fences):
            # allow cut at fence boundary (end of fence / start of fence)
            cuts.add(pos)

    for s, e in fences:
        add(s)
        add(e)

    for m in re.finditer(r"\n\n+", text):
        if not _in_ranges(m.start(), fences):
            add(m.end())

    for rx in (_TURN, _HEADING, _LIST_ITEM):
        for m in rx.finditer(text):
            add(m.start())

    for m in _SENTENCE_END.finditer(text):
        if _in_ranges(m.start(), protected):
            continue
        add(m.end() if m.end() > m.start() else m.start() + 1)

    for m in re.finditer(r"\n", text):
        if not _in_ranges(m.start(), fences):
            add(m.end())

    return sorted(cuts)


def _force_cut(text: str, start: int, limit: int, fences: list[tuple[int, int]], budget: int) -> int:
    """Find a cut in (start, limit] preferring newlines / whitespace; never mid-token in fences."""
    # Prefer last newline in window
    window_end = min(limit, len(text))
    segment = text[start:window_end]
    # Never cut inside a fence — jump to fence end if start is inside
    for s, e in fences:
        if s < window_end and e > start and start >= s:
            return e if e > start else window_end

    best = -1
    for i, ch in enumerate(segment):
        abs_i = start + i + 1
        if ch == "\n" and not _in_ranges(abs_i - 1, fences) and _budget_ok(text[start:abs_i], budget):
            best = abs_i
    if best > start:
        return best

    best = -1
    for i, ch in enumerate(segment):
        abs_i = start + i + 1
        if ch.isspace() and not _in_ranges(abs_i - 1, fences) and _budget_ok(text[start:abs_i], budget):
            best = abs_i
    if best > start:
        return best

    # last resort: end of window (may be mid-token only if no whitespace at all)
    return window_end if window_end > start else min(start + 1, len(text))


def chunk_markdown(source: str, token_budget: int = 400) -> list[Chunk]:
    """Chunk markdown by source structure. Chunk.text is the source slice."""
    if not source:
        return []
    if not source.strip():
        return [Chunk(text=source, index=0, start=0, end=len(source))]

    fences = find_fence_ranges(source)
    cuts = _safe_cut_points(source, fences)

    raw: list[tuple[int, int]] = []
    start = 0
    n = len(source)
    while start < n:
        # Skip pure leading cut at start
        best: int | None = None
        first_over: int | None = None
        for c in cuts:
            if c <= start:
                continue
            piece = source[start:c]
            if not piece:
                continue
            if _budget_ok(piece, token_budget):
                best = c
            else:
                first_over = c
                break

        if best is not None:
            end = best
        elif first_over is not None:
            end = _force_cut(source, start, first_over, fences, token_budget)
            if end <= start:
                end = first_over
        else:
            end = n

        # If still over budget (giant fence), keep atomic fence span
        if not _budget_ok(source[start:end], token_budget):
            for s, e in fences:
                if s == start:
                    end = e
                    break

        if end <= start:
            end = min(start + 1, n)

        raw.append((start, end))
        start = end

    # Merge undersized contiguous neighbors under budget
    merged: list[tuple[int, int]] = []
    for s, e in raw:
        if merged:
            ps, pe = merged[-1]
            combined = source[ps:e]
            if _budget_ok(combined, token_budget):
                merged[-1] = (ps, e)
                continue
        merged.append((s, e))

    # Drop whitespace-only chunks by merging into previous (keep gapless cover)
    final: list[tuple[int, int]] = []
    for s, e in merged:
        frag = source[s:e]
        if final and not frag.strip():
            ps, _pe = final[-1]
            final[-1] = (ps, e)
            continue
        if not frag.strip() and not final:
            # leading whitespace — hold until next real chunk
            if merged:
                continue
        final.append((s, e))

    if not final:
        return [Chunk(text=source, index=0, start=0, end=len(source))]

    # Attach any leading gap before first chunk
    if final[0][0] > 0:
        final[0] = (0, final[0][1])
    # Attach trailing gap
    if final[-1][1] < n:
        ps, _ = final[-1]
        final[-1] = (ps, n)

    # Ensure contiguous
    fixed: list[tuple[int, int]] = []
    for s, e in final:
        if fixed and s < fixed[-1][1]:
            s = fixed[-1][1]
        if fixed and s > fixed[-1][1]:
            # fill gap
            ps, pe = fixed[-1]
            fixed[-1] = (ps, s)
        if e > s:
            fixed.append((s, e))

    return [
        Chunk(text=source[s:e], index=i, start=s, end=e) for i, (s, e) in enumerate(fixed)
    ]
