from knowledge_base.hashing import ascii_with_spaces, disambiguate_hash, hash_text


def test_anyascii_fold():
    assert hash_text("Łódź") == "lodz"
    assert "kozuscek" in hash_text("kožušček") or hash_text("kožušček") == "kozuscek"


def test_hash_strips_non_alnum():
    assert hash_text("Hello, World!") == "helloworld"


def test_ascii_with_spaces():
    s = ascii_with_spaces("Hello, World!")
    assert "hello" in s and "world" in s
    assert " " in s


def test_disambiguate():
    existing = {"abc": "one"}
    assert disambiguate_hash("abc", "one", existing) == "abc"
    assert disambiguate_hash("abc", "two", existing) == "abc#1"
