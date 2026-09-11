from dataclasses import dataclass

from knowledge_base.chunk_code import chunk_code, language_for_path
from knowledge_base.chunk_prose import Chunk, chunk_prose
from knowledge_base.plainify import sniff_kind, to_plain


@dataclass
class AlignedBlock:
    text: str
    source: str
    index: int


def align_source_to_plain(source: str, plain_chunks: list[Chunk]) -> list[AlignedBlock]:
    """Map plain chunks back onto contiguous source spans by sequential search."""
    if not plain_chunks:
        return []
    # Prefer reconstructing source slices by proportional mapping when plain is derived
    # For same-kind plain≈source (code/plain), use offsets directly.
    out: list[AlignedBlock] = []
    cursor = 0
    for ch in plain_chunks:
        # try to find a short unique prefix of the plain text in remaining source
        needle = ch.text[: min(40, len(ch.text))].strip()
        pos = source.find(needle, cursor) if needle else -1
        if pos < 0:
            # approximate: take a window proportional to chunk size
            rem = len(source) - cursor
            take = max(len(ch.text), rem // max(1, len(plain_chunks) - ch.index))
            end = min(len(source), cursor + take)
            frag = source[cursor:end]
            out.append(AlignedBlock(text=ch.text, source=frag or ch.text, index=ch.index))
            cursor = end
        else:
            # expand to roughly match plain length
            end = min(len(source), pos + max(len(ch.text), len(needle)))
            # snap to next paragraph/block boundary if close
            nl = source.find("\n\n", end)
            if nl != -1 and nl - end < 80:
                end = nl
            frag = source[pos:end]
            out.append(AlignedBlock(text=ch.text, source=frag or ch.text, index=ch.index))
            cursor = end
    return out


def chunk_document(source: str, path: str = "", token_budget: int = 400) -> list[AlignedBlock]:
    kind = sniff_kind(source)
    is_code = language_for_path(path) is not None
    if is_code:
        chunks = chunk_code(source, path=path, token_budget=token_budget)
        return [AlignedBlock(text=c.text, source=c.text, index=c.index) for c in chunks]

    plain = to_plain(source, kind=kind)
    chunks = chunk_prose(plain, token_budget=token_budget)
    if kind in ("markdown", "html") and plain != source:
        return align_source_to_plain(source, chunks)
    return [AlignedBlock(text=c.text, source=c.text, index=c.index) for c in chunks]
