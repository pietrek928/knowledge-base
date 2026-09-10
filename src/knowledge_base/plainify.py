from __future__ import annotations

import html as html_lib
import re
from html.parser import HTMLParser


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0
        self._skip_tags = {"script", "style", "noscript"}

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag.lower() in self._skip_tags:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._skip_tags and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._parts.append(data)

    def text(self) -> str:
        return " ".join(self._parts)


def html_to_plain(source: str) -> str:
    parser = _HTMLTextExtractor()
    parser.feed(source)
    parser.close()
    text = html_lib.unescape(parser.text())
    return _collapse_ws(text)


_MD_HEADING = re.compile(r"(?m)^#{1,6}\s+")
_MD_BOLD = re.compile(r"(\*\*|__)(.*?)\1")
_MD_ITALIC = re.compile(r"(\*|_)(.*?)\1")
_MD_STRIKE = re.compile(r"~~(.*?)~~")
_MD_LINK = re.compile(r"!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\([^)]+\)")
_MD_INLINE_CODE = re.compile(r"`([^`]+)`")
_MD_FENCE = re.compile(r"```[^\n]*\n([\s\S]*?)```")
_MD_LIST = re.compile(r"(?m)^\s*[-*+]\s+")
_WS = re.compile(r"\s+")


def markdown_to_plain(source: str) -> str:
    text = source
    text = _MD_FENCE.sub(lambda m: "\n" + m.group(1) + "\n", text)
    text = _MD_LINK.sub(lambda m: m.group(1) or m.group(2) or "", text)
    text = _MD_INLINE_CODE.sub(r"\1", text)
    text = _MD_BOLD.sub(r"\2", text)
    text = _MD_STRIKE.sub(r"\1", text)
    text = _MD_ITALIC.sub(r"\2", text)
    text = _MD_HEADING.sub("", text)
    text = _MD_LIST.sub("", text)
    return _collapse_ws(text)


def _collapse_ws(text: str) -> str:
    return _WS.sub(" ", text).strip()


def sniff_kind(source: str) -> str:
    s = source.lstrip()
    if not s:
        return "plain"
    if s.startswith("<") and ">" in s[:200]:
        return "html"
    if re.search(r"(?m)^#{1,6}\s|\*\*[^*]+\*\*|^\s*[-*+]\s|```", source):
        return "markdown"
    return "plain"


def to_plain(source: str, kind: str | None = None) -> str:
    kind = kind or sniff_kind(source)
    if kind == "html":
        return html_to_plain(source)
    if kind == "markdown":
        return markdown_to_plain(source)
    return _collapse_ws(source)
