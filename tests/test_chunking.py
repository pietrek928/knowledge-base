from knowledge_base.align import chunk_document
from knowledge_base.chunk_code import chunk_code
from knowledge_base.chunk_markdown import chunk_markdown, find_fence_ranges
from knowledge_base.chunk_prose import chunk_prose


def test_prose_paragraphs():
    text = "First paragraph here.\n\nSecond paragraph is longer and separate.\n\nThird."
    chunks = chunk_prose(text, token_budget=400)
    # undersized neighbors merge under budget
    assert len(chunks) >= 1
    assert "First" in chunks[0].text
    big = ("word " * 50 + "\n\n") * 5
    chunks2 = chunk_prose(big, token_budget=40)
    assert len(chunks2) >= 2


def test_code_python_functions():
    src = """
import os

def alpha():
    return 1

def beta(x):
    y = x + 1
    return y
"""
    chunks = chunk_code(src, path="mod.py", token_budget=400)
    texts = " ".join(c.text for c in chunks)
    assert "def alpha" in texts
    assert "def beta" in texts


def test_chunk_document_md():
    md = "# Hello\n\nThis is a **doc** about search.\n\nAnother para."
    blocks = chunk_document(md, path="notes.md")
    assert blocks
    assert any("search" in b.text.lower() or "doc" in b.text.lower() for b in blocks)


def _fence_parity(text: str) -> int:
    """Return open-fence stack depth after scanning text."""
    depth = 0
    open_tick = None
    open_n = 0
    for line in text.splitlines():
        raw = line.rstrip("\r")
        if not raw.lstrip().startswith(("`", "~")):
            continue
        i = 0
        while i < len(raw) and raw[i] == " ":
            i += 1
        if i > 3:
            continue
        tick = raw[i]
        if tick not in "`~":
            continue
        j = i
        while j < len(raw) and raw[j] == tick:
            j += 1
        n = j - i
        if n < 3:
            continue
        if depth == 0:
            depth = 1
            open_tick = tick
            open_n = n
        elif tick == open_tick and n >= open_n:
            depth = 0
            open_tick = None
            open_n = 0
        else:
            depth += 1
    return depth


def test_markdown_fence_atomic_and_gapless():
    prose = "Intro about Parallel Module training.\n\n"
    code = "def train(batch_size):\n    print(batch_size)\n    return batch_size\n"
    # pad fence body so a naive prose splitter would tear it
    code = code + ("    x = batch_size + 1\n" * 40)
    md = prose + "```python\n" + code + "```\n\nOutro with **Relative Keys**.\n"
    blocks = chunk_document(md, path="gemini/demo.md", token_budget=40)
    assert "".join(b.source for b in blocks) == md
    for b in blocks:
        assert _fence_parity(b.source) == 0
        # no mid-identifier splits inside fence bodies
        assert "batch_" not in b.source[-12:] or b.source.rstrip().endswith("```")


def test_markdown_no_mid_word_boundary():
    words = ["predictions", "batch_size", "Transformers", "Relative"]
    md = (
        "Alpha predictions arrive.\n\n"
        "Configure batch_size carefully.\n\n"
        "Use Transformers carefully.\n\n"
        "- **With Split** path\n\n"
        "Math $x_1$ and $x_2$ stays whole.\n\n"
        "**Relative Keys** matter.\n"
    )
    # force many cuts
    blocks = chunk_document(md, path="notes.md", token_budget=8)
    joined = "".join(b.source for b in blocks)
    assert joined == md
    for w in words:
        assert w in joined
    # no mid-word boundaries between contiguous chunks
    for prev, cur in zip(blocks, blocks[1:]):
        if not prev.source or not cur.source:
            continue
        left = prev.source[-1]
        right = cur.source[0]
        assert not (left.isalnum() or left == "_") or not (right.isalnum() or right == "_")
    assert any("- **With Split**" in b.source for b in blocks)
    assert any("$x_1$ and $x_2$" in b.source for b in blocks)
    assert any("**Relative Keys**" in b.source for b in blocks)


def test_markdown_chunk_no_cut_inside_fence_identifier():
    body_lines = [f"    value_{i} = batch_size\n" for i in range(80)]
    md = "Before.\n\n```\n" + "".join(body_lines) + "```\n\nAfter Transformers.\n"
    chunks = chunk_markdown(md, token_budget=30)
    # fence kept atomic (single span covering open..close)
    fences = find_fence_ranges(md)
    assert len(fences) == 1
    fs, fe = fences[0]
    covering = [c for c in chunks if c.start <= fs and c.end >= fe]
    assert covering, "fence should sit inside one chunk"
    for c in chunks:
        if "batch_size" in c.text and "```" in c.text:
            # chunk containing fence should include both fences
            assert c.text.count("```") >= 2


def test_chunk_document_md_plain_has_no_md_noise():
    md = "# Hello\n\nUse `batch_size` and **bold**.\n"
    blocks = chunk_document(md, path="x.md")
    assert any("batch_size" in b.text for b in blocks)
    assert all("**" not in b.text for b in blocks)
