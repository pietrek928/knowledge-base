from knowledge_base.align import chunk_document
from knowledge_base.chunk_code import chunk_code
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
    src = '''
import os

def alpha():
    return 1

def beta(x):
    y = x + 1
    return y
'''
    chunks = chunk_code(src, path="mod.py", token_budget=400)
    texts = " ".join(c.text for c in chunks)
    assert "def alpha" in texts
    assert "def beta" in texts


def test_chunk_document_md():
    md = "# Hello\n\nThis is a **doc** about search.\n\nAnother para."
    blocks = chunk_document(md, path="notes.md")
    assert blocks
    assert any("search" in b.text.lower() or "doc" in b.text.lower() for b in blocks)
