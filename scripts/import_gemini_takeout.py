#!/usr/bin/env python3
"""Import Google Takeout Gemini Activity into the knowledge base."""

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
    p.add_argument("--fake-ollama", action="store_true", help="Use fake embeddings (no Ollama)")
    p.add_argument(
        "--skip-embed",
        action="store_true",
        help="Store only; leave embeddings for a later backfill",
    )
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

    async def _run() -> tuple[int, int, bool, int]:
        await kb.start(backfill=False)
        stored = skipped = 0
        interrupted = False
        left = 0
        try:
            print("Phase 1/3: store conversations (no per-doc embed/rebuild)…")
            async for conv in tqdm(list(conversations.values()), desc="store", unit="chat"):
                result = await kb.ingest_gemini(
                    conversation_id=conv["conversation_id"],
                    title=conv.get("title"),
                    turns=conv["turns"],
                    ingest="takeout",
                    embed=False,
                    rebuild_index=False,
                )
                if result.get("skipped"):
                    skipped += 1
                else:
                    stored += 1

            print("Phase 2/3: rebuild lexical index…")
            await kb.rebuild_index()

            if args.skip_embed:
                print("Phase 3/3: skipped (--skip-embed)")
            else:
                missing = kb.missing_embed_hashes()
                n = len(missing)
                print(f"Phase 3/3: queue {n} embed(s)…")
                kb.submit_embed(missing)
                with tqdm(total=n or 1, desc="embed", unit="block", disable=n == 0) as bar:
                    drain = asyncio.create_task(kb.drain_embeds())
                    last = 0
                    while not drain.done():
                        done = n - kb.pending_embed_count()
                        if done > last:
                            bar.update(done - last)
                            last = done
                        await asyncio.wait({drain}, timeout=0.25)
                    await drain
                    if bar.n < n:
                        bar.update(n - bar.n)
            left = len(kb.missing_embed_hashes())
        except (KeyboardInterrupt, asyncio.CancelledError):
            interrupted = True
            left = len(kb.missing_embed_hashes())
            print("\nInterrupted — leaving remaining embeds for later backfill.", file=sys.stderr)
        finally:
            await kb.stop(drain=not interrupted and not args.skip_embed)
        return stored, skipped, interrupted, left

    left = 0
    try:
        stored, skipped, interrupted, left = asyncio.run(_run())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130

    print(f"Done: stored={stored} skipped={skipped} missing_embeds={left}")
    if interrupted:
        return 130
    if left > 0 and not args.skip_embed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
