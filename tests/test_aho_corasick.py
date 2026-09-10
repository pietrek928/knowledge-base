import pytest

kb_native = pytest.importorskip("kb_native")


def test_aho_multi_pattern():
    ac = kb_native.AhoCorasick()
    ac.build(["cat", "dog", "ot"])
    hits = ac.search("the cat and dog")
    pids = {h[0] for h in hits}
    assert 0 in pids and 1 in pids


def test_aho_overlap():
    ac = kb_native.AhoCorasick()
    ac.build(["aa", "aaa"])
    hits = ac.search("aaaa")
    assert hits
