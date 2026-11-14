#!/usr/bin/env python3
"""One-shot live test: unique prompts for code / table / image extract quality."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import uuid


def run_query(label: str, prompt: str, timeout: int = 240) -> dict | None:
    print(f"\n==== {label} ====", flush=True)
    print(f"prompt: {prompt[:160]}", flush=True)
    p = subprocess.Popen(
        ["uv", "run", "kb-cli", "query", prompt, "--timeout", str(timeout)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    done = None
    assert p.stdout is not None
    for line in p.stdout:
        line = line.rstrip("\n")
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        payload = o.get("payload") or {}
        if t in ("running", "submitted", "turn", "model_selected"):
            print(
                t,
                {
                    k: payload.get(k)
                    for k in ("conversation_id", "turn_count", "extract_source", "label")
                    if k in payload
                },
                flush=True,
            )
        if t == "error":
            print("ERROR", payload.get("error"), flush=True)
            p.wait()
            return None
        if t == "done":
            done = payload
    p.wait()
    if not done:
        print("NO DONE", flush=True)
        return None
    turns = done.get("turns") or []
    print(
        "cid",
        done.get("conversation_id"),
        "actual",
        done.get("model_actual"),
        "n",
        len(turns),
        flush=True,
    )
    for tr in turns:
        text = tr.get("text") or ""
        print(f"--- {tr.get('role')} len={len(text)}", flush=True)
        print(text[:2500], flush=True)
        print("---end", flush=True)
        if tr.get("role") not in ("gemini", "model"):
            continue
        if label == "code":
            print("HAS_CODE", "```" in text or "def " in text or "function " in text, flush=True)
        if label == "table":
            has = ("|" in text and "---" in text) or "<table" in text.lower()
            print("HAS_TABLE", has, flush=True)
        if label == "image":
            has = bool(
                re.search(
                    r"image_unavailable|!\[[^\]]*\]\(|<img|\[image|generated",
                    text,
                    re.I,
                )
            )
            print("HAS_IMAGE_SIGNAL", has, flush=True)
    return done


def main() -> int:
    tag = uuid.uuid4().hex[:8]
    # Unique prompts each run — never reuse the same string (looks automated).
    prompts = {
        "code": (
            f"Nonce {tag}. Write a tiny JavaScript function `avg(nums)` that returns the "
            f"arithmetic mean of a number array (empty → 0). Reply with one fenced js code "
            f"block only."
        ),
        "table": (
            f"Nonce {tag}. Output only a markdown table with columns Tool, Year, Kind and "
            f"exactly 3 rows: curl/1996/cli, jq/2012/cli, httpie/2012/cli."
        ),
        "image": (
            f"Nonce {tag}. Please generate a simple image: a blue circle on a cream background. "
            f"If image generation is unavailable, reply with exactly IMAGE_UNAVAILABLE_{tag}."
        ),
    }
    ok = True
    for label in ("code", "table", "image"):
        r = run_query(label, prompts[label])
        ok = ok and r is not None
        # Natural gap between different tasks (pacing may also apply in the extension).
        if label != "image":
            time.sleep(8)
    print("\nALL_DONE", "ok" if ok else "fail", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
