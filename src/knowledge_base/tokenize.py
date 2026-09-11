import re

from knowledge_base.hashing import fold_ascii

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_SEP = re.compile(r"[_\-./\\]+")
_TOKEN = re.compile(r"[a-z0-9]+", re.I)
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SNAKE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")
_CAMEL_LIKE = re.compile(r"^[A-Za-z]+(?:[A-Z][a-z0-9]+)+$|^[a-z]+(?:[A-Z][a-z0-9]+)+$")


def split_identifier(token: str) -> list[str]:
    parts = _SEP.split(token)
    out: list[str] = []
    for p in parts:
        if not p:
            continue
        camel_bits = _CAMEL.split(p)
        for b in camel_bits:
            b = b.strip()
            if b:
                out.append(b.lower())
    return out or [token.lower()]


def tokenize(text: str) -> list[str]:
    # Split identifiers on original casing before folding, then fold each piece.
    raw = _TOKEN.findall(text)
    tokens: list[str] = []
    for t in raw:
        bits = split_identifier(t)
        for b in bits:
            folded = fold_ascii(b).lower()
            if folded:
                tokens.append(folded)
    return tokens


def is_identifier_like(phrase: str) -> bool:
    p = phrase.strip()
    if not p or " " in p:
        return False
    return bool(_IDENT.match(p) or _SNAKE.match(p) or _CAMEL_LIKE.match(p))
