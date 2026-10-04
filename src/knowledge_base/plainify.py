import html as html_lib
import re
from html.parser import HTMLParser

_BLOCK_TAGS = frozenset(
    {
        "address",
        "article",
        "aside",
        "blockquote",
        "dd",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "ul",
    }
)
_SKIP_TAGS = frozenset({"script", "style", "noscript"})
_PRE_TAGS = frozenset({"pre"})
_HWS = re.compile(r"[^\S\n]+")
_BLANK_RUNS = re.compile(r"\n{3,}")
_FENCE_SPLIT = re.compile(r"(^`{3,}[^\n]*\n[\s\S]*?^`{3,}\s*$)", re.M)


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0
        self._pre_depth = 0

    def _emit(self, s: str) -> None:
        if s:
            self._parts.append(s)

    def _emit_break(self) -> None:
        if self._parts and not self._parts[-1].endswith("\n"):
            self._parts.append("\n")
        elif not self._parts:
            self._parts.append("\n")

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        t = tag.lower()
        if t in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if t in _PRE_TAGS:
            self._pre_depth += 1
            self._emit_break()
            return
        if t == "br":
            self._emit("\n")
            return
        if t in _BLOCK_TAGS:
            self._emit_break()

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in _SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if t in _PRE_TAGS and self._pre_depth:
            self._pre_depth -= 1
            self._emit_break()
            return
        if t in _BLOCK_TAGS:
            self._emit_break()

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001
        t = tag.lower()
        if self._skip_depth:
            return
        if t == "br":
            self._emit("\n")
        elif t == "hr":
            self._emit_break()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        self._parts.append(data)

    def text(self) -> str:
        return "".join(self._parts)


def _collapse_ws(text: str) -> str:
    """Collapse horizontal whitespace; keep newlines and line indentation."""
    lines: list[str] = []
    for line in text.split("\n"):
        line = line.rstrip(" \t")
        i = 0
        while i < len(line) and line[i] in " \t":
            i += 1
        rest = _HWS.sub(" ", line[i:])
        lines.append(line[:i] + rest)
    text = "\n".join(lines)
    text = _BLANK_RUNS.sub("\n\n", text)
    return text.strip()


def html_to_plain(source: str) -> str:
    parser = _HTMLTextExtractor()
    parser.feed(source)
    parser.close()
    text = html_lib.unescape(parser.text())
    return _collapse_ws(text)


def _longest_backtick_run(s: str) -> int:
    n = 0
    for m in re.finditer(r"`+", s):
        n = max(n, len(m.group(0)))
    return n


def _fence_block(code: str) -> str:
    body = code.replace("\r\n", "\n").replace("\r", "\n")
    if body.startswith("\n"):
        body = body[1:]
    if body.endswith("\n"):
        body = body[:-1]
    ticks = max(3, _longest_backtick_run(body) + 1)
    fence = "`" * ticks
    return f"\n{fence}\n{body}\n{fence}\n"


def _inline_code_span(code: str) -> str:
    code = code.replace("\n", " ")
    ticks = max(1, _longest_backtick_run(code) + 1)
    fence = "`" * ticks
    pad = " " if code.startswith("`") or code.endswith("`") or not code.strip() else ""
    return f"{fence}{pad}{code}{pad}{fence}"


def _attrs_dict(attrs) -> dict[str, str]:  # noqa: ANN001
    out: dict[str, str] = {}
    for k, v in attrs or []:
        if k:
            out[k.lower()] = v or ""
    return out


class _HTMLMarkdownConverter(HTMLParser):
    """Convert Gemini-style HTML answers into markdown fragments."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0
        self._pre_depth = 0
        self._pre_buf: list[str] = []
        self._code_depth = 0
        self._code_buf: list[str] = []
        self._bq_depth = 0
        self._list_stack: list[dict[str, int | bool]] = []
        self._li_open = False
        self._pending_li_break = False
        self._link_stack: list[tuple[str | None, int]] = []
        self._emph: list[str] = []
        self._in_table = False
        self._table_rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def _sink(self) -> list[str]:
        if self._cell_parts is not None:
            return self._cell_parts
        return self._parts

    def _emit(self, s: str) -> None:
        if s:
            self._sink().append(s)

    def _joined(self) -> str:
        return "".join(self._sink())

    def _emit_break(self, blank: bool = False) -> None:
        if self._pre_depth or self._cell_parts is not None:
            return
        cur = self._joined()
        if not cur:
            return
        if blank:
            if cur.endswith("\n\n"):
                return
            self._emit("\n" if cur.endswith("\n") else "\n\n")
            return
        if not cur.endswith("\n"):
            self._emit("\n")

    def _list_prefix(self) -> str:
        depth = max(0, len(self._list_stack) - 1)
        indent = "  " * depth
        top = self._list_stack[-1]
        if top["ordered"]:
            n = int(top["index"])
            top["index"] = n + 1
            return f"{indent}{n}. "
        return f"{indent}- "

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        t = tag.lower()
        ad = _attrs_dict(attrs)
        if t in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if t == "pre":
            if self._pre_depth == 0:
                self._emit_break(blank=True)
                self._pre_buf = []
            self._pre_depth += 1
            return
        if self._pre_depth:
            return
        if t == "code":
            self._code_depth += 1
            if self._code_depth == 1:
                self._code_buf = []
            return
        if t == "br":
            if self._list_stack and self._li_open:
                depth = max(0, len(self._list_stack) - 1)
                self._emit("\n" + ("  " * depth) + "  ")
            else:
                self._emit("\n")
            return
        if t == "hr":
            self._emit_break(blank=True)
            self._emit("---")
            self._emit_break(blank=True)
            return
        if t == "img":
            src = ad.get("src") or ""
            name = src.rsplit("/", 1)[-1] if src else (ad.get("alt") or "image")
            self._emit(f"[image: {name}]")
            return
        if t == "a":
            self._link_stack.append((ad.get("href"), len(self._sink())))
            return
        if t in ("strong", "b"):
            if not self._code_depth:
                self._emph.append("**")
                self._emit("**")
            return
        if t in ("em", "i"):
            if not self._code_depth:
                self._emph.append("*")
                self._emit("*")
            return
        if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = min(6, int(t[1]) + 1)
            self._emit_break(blank=True)
            self._emit("#" * level + " ")
            return
        if t == "blockquote":
            self._bq_depth += 1
            self._emit_break(blank=True)
            if self._bq_depth == 1:
                self._emit("> ")
            return
        if t in ("ul", "ol"):
            self._emit_break(blank=True)
            self._list_stack.append({"ordered": t == "ol", "index": 1})
            return
        if t == "li":
            self._emit_break()
            self._emit(self._list_prefix())
            self._li_open = True
            self._pending_li_break = False
            return
        if t == "p":
            if self._list_stack and self._li_open:
                if self._pending_li_break:
                    depth = max(0, len(self._list_stack) - 1)
                    self._emit("\n" + ("  " * depth) + "  ")
                self._pending_li_break = True
                return
            if self._bq_depth:
                self._emit_break()
                self._emit("> ")
                return
            self._emit_break(blank=True)
            return
        if t == "table":
            self._in_table = True
            self._table_rows = []
            self._emit_break(blank=True)
            return
        if t == "tr" and self._in_table:
            self._row = []
            return
        if t in ("td", "th") and self._in_table:
            self._cell_parts = []
            return
        if t in ("div", "section", "article"):
            self._emit_break()

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in _SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if t == "pre" and self._pre_depth:
            self._pre_depth -= 1
            if self._pre_depth == 0:
                raw = html_lib.unescape("".join(self._pre_buf))
                self._pre_buf = []
                self._emit(_fence_block(raw))
                self._emit_break(blank=True)
            return
        if self._pre_depth:
            return
        if t == "code" and self._code_depth:
            self._code_depth -= 1
            if self._code_depth == 0:
                raw = html_lib.unescape("".join(self._code_buf))
                self._code_buf = []
                self._emit(_inline_code_span(raw))
            return
        if t == "a" and self._link_stack:
            href, start = self._link_stack.pop()
            sink = self._sink()
            inner = "".join(sink[start:])
            del sink[start:]
            if href:
                sink.append(f"[{inner}]({href})")
            else:
                sink.append(inner)
            return
        if t in ("strong", "b", "em", "i"):
            if self._emph:
                self._emit(self._emph.pop())
            return
        if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._emit_break(blank=True)
            return
        if t == "blockquote":
            if self._bq_depth:
                self._bq_depth -= 1
            self._emit_break(blank=True)
            return
        if t in ("ul", "ol"):
            if self._list_stack:
                self._list_stack.pop()
            self._emit_break(blank=True)
            return
        if t == "li":
            self._li_open = False
            self._pending_li_break = False
            self._emit_break()
            return
        if t == "p":
            if self._list_stack and self._li_open:
                return
            self._emit_break(blank=True)
            return
        if t in ("td", "th") and self._in_table and self._cell_parts is not None:
            cell = _collapse_ws("".join(self._cell_parts)).replace("|", "\\|")
            self._cell_parts = None
            if self._row is not None:
                self._row.append(cell)
            return
        if t == "tr" and self._in_table and self._row is not None:
            self._table_rows.append(self._row)
            self._row = None
            return
        if t == "table" and self._in_table:
            self._flush_table()
            self._in_table = False
            self._emit_break(blank=True)
            return
        if t in ("div", "section", "article"):
            self._emit_break()

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001
        t = tag.lower()
        if self._skip_depth:
            return
        if self._pre_depth:
            if t == "br":
                self._pre_buf.append("\n")
            return
        if t in ("br", "hr", "img"):
            self.handle_starttag(t, attrs)

    def handle_data(self, data: str) -> None:
        if self._skip_depth or not data:
            return
        if self._pre_depth:
            self._pre_buf.append(data)
            return
        if self._code_depth:
            self._code_buf.append(data)
            return
        self._emit(data)

    def _flush_table(self) -> None:
        rows = self._table_rows
        self._table_rows = []
        if not rows:
            return
        width = max(len(r) for r in rows)
        norm = [r + [""] * (width - len(r)) for r in rows]
        header, body = norm[0], norm[1:]
        lines = [
            "| " + " | ".join(header) + " |",
            "| " + " | ".join("---" for _ in header) + " |",
        ]
        for r in body:
            lines.append("| " + " | ".join(r) + " |")
        self._emit("\n".join(lines) + "\n")

    def text(self) -> str:
        return "".join(self._parts)


def _collapse_md_ws(text: str) -> str:
    """Collapse whitespace outside fenced code blocks; leave fence bodies intact."""
    parts = _FENCE_SPLIT.split(text.replace("\r\n", "\n").replace("\r", "\n"))
    chunks: list[str] = []
    for part in parts:
        if not part:
            continue
        if part.startswith("`") and "\n" in part:
            chunks.append(part if part.endswith("\n") else part + "\n")
        else:
            collapsed = _collapse_ws(part)
            if collapsed:
                chunks.append(collapsed)
    merged = "\n\n".join(chunks)
    return _BLANK_RUNS.sub("\n\n", merged).strip()


def html_to_markdown(source: str) -> str:
    if not source or not source.strip():
        return ""
    parser = _HTMLMarkdownConverter()
    parser.feed(source)
    parser.close()
    return _collapse_md_ws(parser.text())


_MD_HEADING = re.compile(r"(?m)^#{1,6}\s+")
# Gemini markdown uses ** for bold; do not treat __dunder__ as bold/italic.
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_ITALIC = re.compile(
    r"(?<![*_])\*(?!\*)(.+?)(?<!\*)\*(?![*_])|(?<![A-Za-z0-9_])_(?!_)(.+?)(?<!_)_(?![A-Za-z0-9_])"
)
_MD_STRIKE = re.compile(r"~~(.*?)~~")
_MD_LINK = re.compile(r"!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\([^)]+\)")
_MD_INLINE_CODE = re.compile(r"(?<!`)(`+)((?:(?!\1).)+?)\1(?!`)")
_MD_LIST = re.compile(r"(?m)^\s*[-*+]\s+")
_FENCE_LINE = re.compile(r"^( {0,3})([`~]{3,})(.*)$")


def _find_fence_ranges(text: str) -> list[tuple[int, int]]:
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


def _fence_body(block: str) -> str:
    lines = block.splitlines(keepends=True)
    if len(lines) < 2:
        return block
    # drop open line; drop close line if present
    body_lines = lines[1:]
    if body_lines and _FENCE_LINE.match(body_lines[-1].rstrip("\r\n")):
        body_lines = body_lines[:-1]
    return "".join(body_lines)


def markdown_to_plain(source: str) -> str:
    text = source.replace("\r\n", "\n").replace("\r", "\n")
    placeholders: list[str] = []

    def protect(content: str) -> str:
        placeholders.append(content)
        return f"\0PH{len(placeholders) - 1}\0"

    # Protect fenced code (variable tick length) before bold/italic strip.
    for s, e in reversed(_find_fence_ranges(text)):
        body = _fence_body(text[s:e])
        text = text[:s] + protect("\n" + body + "\n") + text[e:]

    def _inline_sub(m: re.Match[str]) -> str:
        return protect(m.group(2).strip())

    text = _MD_INLINE_CODE.sub(_inline_sub, text)
    text = _MD_LINK.sub(lambda m: m.group(1) or m.group(2) or "", text)
    text = _MD_BOLD.sub(r"\1", text)
    text = _MD_STRIKE.sub(r"\1", text)
    text = _MD_ITALIC.sub(lambda m: m.group(1) or m.group(2) or "", text)
    text = _MD_HEADING.sub("", text)
    text = _MD_LIST.sub("", text)

    for i, content in enumerate(placeholders):
        text = text.replace(f"\0PH{i}\0", content)
    return _collapse_ws(text)


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
