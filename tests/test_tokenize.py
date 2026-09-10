from knowledge_base.tokenize import is_identifier_like, split_identifier, tokenize


def test_camel_snake():
    assert "user" in split_identifier("getUserById")
    assert "by" in split_identifier("getUserById") or "id" in split_identifier("getUserById")
    assert tokenize("get_user_by_id") == tokenize("getUserById") or set(tokenize("get_user_by_id")) & set(
        tokenize("getUserById")
    )


def test_identifier_like():
    assert is_identifier_like("ERR_CONN")
    assert is_identifier_like("getUserById")
    assert not is_identifier_like("how does auth work")
