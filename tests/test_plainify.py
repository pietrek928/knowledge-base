from knowledge_base.plainify import (
    html_to_markdown,
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


def test_html_br_and_p_preserve_newlines():
    plain = html_to_plain("<p>def foo():<br>    return 1<br></p><p>next</p>")
    assert "def foo():\n" in plain
    assert "return 1" in plain
    assert "\n" in plain
    assert "next" in plain
    assert "def foo(): return 1" not in plain


def test_html_pre_keeps_newlines_and_indent():
    plain = html_to_plain("<pre>line1\n    line2</pre>")
    assert "line1\n    line2" in plain


def test_markdown_basic():
    md = "# Title\n\n**bold** and [link](http://x) plus `code`\n\n```\nfenced\nline2\n```\n"
    plain = markdown_to_plain(md)
    assert "Title" in plain
    assert "bold" in plain
    assert "link" in plain
    assert "code" in plain
    assert "fenced" in plain
    assert "fenced\nline2" in plain
    assert "**" not in plain
    assert "http" not in plain


def test_markdown_to_plain_keeps_dunder_in_code():
    md = (
        "Call `__init__` please.\n\n"
        "```python\n"
        "def __init__(self):\n"
        "    pass\n"
        "```\n"
    )
    plain = markdown_to_plain(md)
    assert "__init__" in plain
    assert plain.count("__init__") >= 2
    # longer fences from html_to_markdown
    md2 = "````\ndef __init__(self):\n    x = ```ok```\n````\n"
    assert "__init__" in markdown_to_plain(md2)


def test_sniff():
    assert sniff_kind("<div>x</div>") == "html"
    assert sniff_kind("# hello") == "markdown"
    assert sniff_kind("just text") == "plain"


def test_to_plain_dispatch():
    assert "hi" in to_plain("<b>hi</b>")


def test_html_to_markdown_fences_init():
    html = (
        "<p>Intro with <code>__init__</code> inline.</p>"
        "<pre><code>def __init__(self):\n    pass\n</code></pre>"
    )
    md = html_to_markdown(html)
    assert "```" in md
    assert "def __init__(self):" in md
    assert "`__init__`" in md
    # fenced body must keep dunders (not stripped for italic)
    fence_body = md.split("```")[1]
    if fence_body.startswith("\n"):
        fence_body = fence_body[1:]
    assert "__init__" in fence_body


def test_html_to_markdown_longer_fence_for_backticks():
    html = "<pre><code>x = ```weird```\n</code></pre>"
    md = html_to_markdown(html)
    assert "````" in md
    assert "```weird```" in md


def test_html_to_markdown_heading_demotion_list_table_img():
    html = (
        "<h1>Title</h1><h3>Sub</h3>"
        "<ul><li><p><strong>A</strong></p></li><li>B</li></ul>"
        "<table><tr><th>X</th><th>Y</th></tr><tr><td>1</td><td>2</td></tr></table>"
        '<p><img src="foo/bar.png" alt="pic"></p>'
    )
    md = html_to_markdown(html)
    assert md.startswith("## Title") or "\n## Title" in md or "## Title" in md
    assert "#### Sub" in md  # h3 demoted +1 -> ####
    assert "- **A**" in md or "- **A**" in md.replace("\n", " ")
    assert "| X | Y |" in md.replace("  ", " ")
    assert "[image: bar.png]" in md
