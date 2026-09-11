from knowledge_base.plainify import (
    html_to_plain,
    markdown_to_plain,
    sniff_kind,
    to_plain,
)


def test_html_strips_tags_and_script():
    html = "<p>Hello &amp; world</p><script>evil()</script><style>.x{}</style>"
    plain = html_to_plain(html)
    assert "Hello & world" in plain or plain == "Hello & world"
    assert "evil" not in plain
    assert ".x" not in plain


def test_html_entities():
    assert " " in html_to_plain("a&nbsp;b") or "ab" in html_to_plain("a&nbsp;b").replace(" ", "")


def test_markdown_basic():
    md = "# Title\n\n**bold** and [link](http://x) plus `code`\n\n```\nfenced\n```\n"
    plain = markdown_to_plain(md)
    assert "Title" in plain
    assert "bold" in plain
    assert "link" in plain
    assert "code" in plain
    assert "fenced" in plain
    assert "**" not in plain
    assert "http" not in plain


def test_sniff():
    assert sniff_kind("<div>x</div>") == "html"
    assert sniff_kind("# hello") == "markdown"
    assert sniff_kind("just text") == "plain"


def test_to_plain_dispatch():
    assert "hi" in to_plain("<b>hi</b>")
