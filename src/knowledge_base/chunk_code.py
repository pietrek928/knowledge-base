from __future__ import annotations

from dataclasses import dataclass

from knowledge_base.chunk_prose import Chunk, chunk_prose
from knowledge_base.tokenize import tokenize

# Optional tree-sitter; fall back to prose if unavailable
_LANG_EXT = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".rb": "ruby",
}


def language_for_path(path: str) -> str | None:
    from pathlib import Path

    return _LANG_EXT.get(Path(path).suffix.lower())


def _get_parser(lang: str):
    try:
        from tree_sitter_language_pack import get_parser

        return get_parser(lang)
    except Exception:
        return None


_DEF_TYPES = {
    "function_definition",
    "function_declaration",
    "method_definition",
    "method_declaration",
    "class_definition",
    "class_declaration",
    "struct_item",
    "impl_item",
    "function_item",
    "type_declaration",
}


def chunk_code(source: str, path: str = "", token_budget: int = 400) -> list[Chunk]:
    lang = language_for_path(path) if path else None
    parser = _get_parser(lang) if lang else None
    if parser is None:
        return chunk_prose(source, token_budget=token_budget)

    tree = parser.parse(source.encode("utf-8"))
    root = tree.root_node
    spans: list[tuple[int, int]] = []

    def walk(node) -> None:  # noqa: ANN001
        if node.type in _DEF_TYPES:
            spans.append((node.start_byte, node.end_byte))
            return
        for child in node.children:
            walk(child)

    walk(root)
    if not spans:
        return chunk_prose(source, token_budget=token_budget)

    # fill gaps as preamble/misc
    raw: list[tuple[int, int, str]] = []
    cursor = 0
    data = source.encode("utf-8")
    for start, end in sorted(spans):
        if start > cursor:
            gap = data[cursor:start].decode("utf-8", errors="replace").strip()
            if gap:
                raw.append((cursor, start, gap))
        piece = data[start:end].decode("utf-8", errors="replace")
        raw.append((start, end, piece))
        cursor = end
    if cursor < len(data):
        gap = data[cursor:].decode("utf-8", errors="replace").strip()
        if gap:
            raw.append((cursor, len(data), gap))

    # split oversized nodes
    final: list[tuple[int, int, str]] = []
    for s, e, text in raw:
        if len(tokenize(text)) <= token_budget:
            final.append((s, e, text))
        else:
            for c in chunk_prose(text, token_budget=token_budget):
                final.append((s + c.start, s + c.end, c.text))

    return [Chunk(text=t, index=i, start=a, end=b) for i, (a, b, t) in enumerate(final)]
