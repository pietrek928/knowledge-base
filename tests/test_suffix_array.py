import pytest

kb_native = pytest.importorskip("kb_native")


def test_suffix_array_find():
    text = "banana"
    sa = kb_native.build_suffix_array(text)
    assert sorted(sa) == list(range(len(text)))
    hits = kb_native.sa_find(text, sa, "ana")
    assert hits
    starts = {h[0] for h in hits}
    assert 1 in starts or 3 in starts


def test_lcp_basic():
    text = "banana"
    sa = kb_native.build_suffix_array(text)
    lcp = kb_native.build_lcp(text, sa)
    assert len(lcp) == len(sa)
