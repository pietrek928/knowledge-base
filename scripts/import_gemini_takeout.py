#!/usr/bin/env python3
"""Import Google Takeout Gemini Activity into the knowledge base."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from tqdm.asyncio import tqdm

from knowledge_base.config import load_config
from knowledge_base.gemini_takeout import load_takeout
from knowledge_base.service import KnowledgeBase


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Import Gemini Takeout into the knowledge base")
    p.add_argument(
        "path",
        type=Path,
        help="Takeout zip, MyActivity.html, or MyActivity.json",
    )
    p.add_argument("--config", type=Path, default=None, help="KB config.json path")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and print conversation counts without writing",
    )
    p.add_argument("--fake-ollama", action="store_true", help="Skip real Ollama embeds")
    args = p.parse_args(argv)

    try:
        conversations = load_takeout(args.path)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if not conversations:
        print("No Gemini conversations found in Takeout.")
        return 1

    print(f"Found {len(conversations)} conversation(s)")
    if args.dry_run:
        for cid, conv in list(conversations.items())[:20]:
            print(f"  {cid}  turns={len(conv['turns'])}  title={conv['title'][:60]!r}")
        if len(conversations) > 20:
            print(f"  … {len(conversations) - 20} more")
        return 0

    cfg = load_config(args.config)
    kb = KnowledgeBase(cfg, fake_ollama=args.fake_ollama)

    async def _run() -> tuple[int, int]:
        pending = kb.missing_embed_hashes()
        if pending:
            print(
                f"Note: {len(pending)} block(s) still need embeddings "
                "(from a prior run); queuing in background…"
            )
        print("Prewarming Ollama…")
        await kb.start(backfill=True)
        stored = skipped = 0
        try:
            async for conv in tqdm(
                list(conversations.values()),
                desc="ingest",
                unit="chat",
            ):
                result = await kb.ingest_gemini(
                    conversation_id=conv["conversation_id"],
                    title=conv.get("title"),
                    turns=conv["turns"],
                    ingest="takeout",
                )
                if result.get("skipped"):
                    skipped += 1
                else:
                    stored += 1
        finally:
            qsize = kb._embed_q.qsize() if kb._embed_q is not None else 0
            if qsize:
                print(f"Draining embed queue ({qsize}+ pending)…")
            else:
                print("Finishing embeds…")
            await kb.stop()
        return stored, skipped

    try:
        stored, skipped = asyncio.run(_run())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    print(f"Done: stored={stored} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
