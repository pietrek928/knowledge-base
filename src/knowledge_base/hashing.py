from __future__ import annotations

import re

from anyascii import anyascii

_ALNUM = re.compile(r"[^a-z0-9]+")
_NON_ALNUM_KEEP_SPACE = re.compile(r"[^a-z0-9\s]+")
_DIGIT_RUN = re.compile(r"(\d+)")


def fold_ascii(text: str) -> str:
    return anyascii(text).lower()


def hash_text(text: str) -> str:
    """Store key: anyascii → lower → [a-z0-9] only."""
    return _ALNUM.sub("", fold_ascii(text))


def ascii_no_spaces(text: str) -> str:
    return hash_text(text)


def ascii_with_spaces(text: str) -> str:
    folded = fold_ascii(text)
    return _NON_ALNUM_KEEP_SPACE.sub(" ", folded)
    # collapse later by caller if needed


def disambiguate_hash(base: str, plain_text: str, existing: dict[str, str]) -> str:
    """If base hash collides with different plain text, use hash#n."""
    if base not in existing:
        return base
    if existing[base] == plain_text:
        return base
    n = 1
    while True:
        cand = f"{base}#{n}"
        if cand not in existing or existing[cand] == plain_text:
            return cand
        n += 1


def wrap_digits_for_search(pattern: str) -> str:
    """Wrap digit runs with \\s* for space-tolerant number matching (non-regex phrases)."""
    return _DIGIT_RUN.sub(r"\\s*\\1\\s*", re.escape(pattern)).replace(r"\\ ", " ")
