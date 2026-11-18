# Knowledge Base

Local FastAPI knowledge base with hybrid lexical + vector search, dual Ollama embeddings, and a live search UI.

## Features

- JSON paragraph store under `~/.kb` (configurable `data_dir`)
- Prose + tree-sitter code chunking; plain `text` for search, `source` for display
- C++ `kb_native` (suffix array, trigrams, Aho–Corasick, Damerau–Levenshtein via rapidfuzz-cpp, BM25, Hamming / int8 / float16 rescoring)
- Dual Ollama embedders: `qwen3-embedding:8b` + `mxbai-embed-large`
- Three-tier vector retrieval (binary → int8 → float16)
- Convex-combination fusion (RRF fallback) + sibling / complement boosts
- Frontend with all search params and localStorage saved configs
- Gemini chat ingest (Google Takeout + Chromium extension)

## Setup

Requires Python ≥3.11, CMake, a C++20 compiler, and [uv](https://github.com/astral-sh/uv).

```bash
uv sync
uv pip install -e .
# or: uv run pip install -e ".[dev]"
```

Optional: run Ollama locally and pull the embedding models. Tests always use fake embeddings (no network):

```bash
uv run pytest
```

**Lexical-only (no Ollama):** set `"models": []` or `"ollama": {"enabled": false}` in `config.json`. Search uses exact/fuzzy/BM25 only; store/ingest still write content and rebuild the lexical index (no embed queue). Re-enable models later and backfill embeds when ready.

## Lint

```bash
uv run ruff check --fix src scripts tests
uv run ruff format src scripts tests
clang-format -i src/kb_native/**/*.{cpp,hpp}
# optional, if installed:
# clang-tidy -p build src/kb_native/**/*.cpp
```

## Run

```bash
uv run kb serve --host 127.0.0.1 --port 9099
# without Ollama:
uv run kb serve --fake-ollama
```

Open http://127.0.0.1:9099/

## API

- `POST /store` — `{ "path", "content", "metadata"? , "block_metadata"? }` (`metadata` is per-document)
- `POST /ingest/gemini` — structured Gemini turns → format, fingerprint, skip-or-store
- `GET /docs?prefix=gemini/` — list documents + document metadata (for extension reconcile)
- `POST /search` — JSON body with `phrases`, `limit`, fusion/weights, date/meta filters, sibling boosts, …
- `GET /search?q=…` — flat alias
- `GET /health`
- `/ext/*` — extension remote-control broker (register, poll, events, commands, wait, browsers)

OpenAPI UI: `/api/docs`

## Gemini / Takeout

Seed the KB from a Google Takeout of **My Activity → Gemini Apps** (HTML or JSON). Do not commit private Takeout zips.

1. [takeout.google.com](https://takeout.google.com) → Deselect all → **My Activity** → only **Gemini Apps** (optional: Activity records as **JSON**).
2. Set up the KB (`uv sync` / `uv pip install -e .`). The importer writes in-process (no server required). For the extension, run `uv run kb serve` as well.
3. Import with **`uv run`**:

```bash
# Import from Takeout zip (layout: My Activity/Gemini Apps/MyActivity.html)
uv run python scripts/import_gemini_takeout.py ~/Downloads/takeout-*.zip

# Or from an extracted MyActivity.html / .json
uv run python scripts/import_gemini_takeout.py /path/to/MyActivity.html

# Preview without writing
uv run python scripts/import_gemini_takeout.py /path/to/takeout.zip --dry-run

# Fake embeddings (no Ollama)
uv run python scripts/import_gemini_takeout.py /path/to/takeout.zip --fake-ollama

# Store + index only; embed later (or after Ctrl+C)
uv run python scripts/import_gemini_takeout.py /path/to/takeout.zip --skip-embed
```

Import runs in phases: **store** (never waits on Ollama) → **one lexical rebuild** → **embed drain**. Ctrl+C skips draining so ingest does not hang; missing embeds can be filled on the next run or by the server backfill. Re-runs skip unchanged chats via `content_fingerprint`.

Document embeds run **one model at a time**. If Takeout hits `ReadTimeout`, raise `ollama.timeout_s` (default 600) and/or lower `ollama.batch_size` (default 4) in `config.json`. `drain_embeds` only waits for the queue to empty — failed batches still appear in `missing_embeds` until a later backfill.

### Extension (Chrome / Brave)

Load unpacked from [`extension/gemini-kb/dist/`](extension/gemini-kb/dist/) (v0.3.18+; ESM sources → Rollup IIFE):

```bash
cd extension/gemini-kb
npm ci
npm run build          # production bundles → dist/
# npm run dev          # watch + WebSocket chrome.runtime.reload() on :9333
```

1. Start the KB: `uv run kb serve --host 127.0.0.1 --port 9099`
2. Chrome `chrome://extensions` or Brave `brave://extensions` → Developer mode → **Load unpacked** → select `extension/gemini-kb/dist` (use `npm run build` or `npm run dev` after source edits)
3. Open the popup: set KB URL (`http://127.0.0.1:9099`), enable **Auto-save while browsing**
4. Visit `https://gemini.google.com/app/<id>` — the extension paginates private `hNvQHb` RPC and `POST`s structured turns to `/ingest/gemini` (no public share links)
5. Weekly alarm re-syncs chats that were never pushed, marked `pendingFullSync`, or last pushed &gt; 7 days ago

### Remote control (`kb-cli`)

With the extension loaded and `kb serve` running, the extension **registers**, **heartbeats**, and **long-polls** `/ext/*` for commands. Drive it from a second Click entrypoint:

```bash
uv run kb-cli browsers
uv run kb-cli list-models          # unlocked labels + efforts only; also returns locked[]
uv run kb-cli list-models --conversation-id <id>
uv run kb-cli conversations        # cached gemini/* threads (logical path + store_path)
uv run kb-cli page-html -o /tmp/gemini.html
uv run kb-cli page-html --selector 'button[aria-label*="model" i]'
# Exact unlocked label from list-models (do not invent :high unless listed):
uv run kb-cli query "explain batch_size" --model 'Code & analysis 4 Argon'
uv run kb-cli query "follow-up" --conversation-id <id> --timeout 420 --final-json
uv run kb-cli search -q Parallel --source cache --source gemini-live
uv run kb-cli search --conversation-id <id> -q batch_size --source cache
```

- **`query`**: opens/reuses a Gemini tab, optionally selects model/effort, types with humanized timing (long text: short prefix + paste), waits for generation, streams **NDJSON events** (one JSON object per line), and **ingests** the thread. Use `--final-json` for a single terminal command blob (scripts/`json.load`). Ctrl+C / SIGINT / SIGTERM cancel the command, abort in-flight extension work, and clear browser `busy`. Late `done` cannot overwrite `cancelled`/`timeout`. If the chip does not match the requested model, `model_changed` is set.
- **`list-models`**: unlocked picker rows only. Per-model `efforts` start from an embedded token or `["medium"]`, then may gain `high` only after an **Argon-only** picker probe proves an unlocked High row (probe restores the prior model afterward). Top-level `thinking_levels` / `debug.effort_levels_seen` are scrape hints — **not** permission to pass `:high`. Locked/paywall rows appear under `locked` — do not query them (e.g. Carbon unlock).
- **`conversations`**: lists cached `gemini/` docs. Logical `path` is `gemini/{id}.md`; on disk under `data_dir` as `content/{path}.json` (e.g. `~/.kb/content/gemini/{id}.md.json`) — not a file in the repo cwd.
- **`search`**: without `--conversation-id` returns conversation hits; with it, message hits. `--source cache` reads the KB store; `gemini-live` fans out to connected browsers. Hits include `store_path` hints.
- **`page-html`**: dumps live chat HTML for debugging (default = `user-query`/`model-response` turns; `--selector` for chrome/picker; optional `--max-chars` ceiling; `-o` to write the body to a file).
- Multiple browsers: `kb-cli browsers` lists them; pass `--browser-id` / `--account` to route. Live search merges all accounts.
- Extension input: **TYPE/PASTE always use CDP debugger** (even when popup **Trusted input** is off). That checkbox only gates **click/move/wheel** (debugger banner, can trip anti-bot). Saving Trusted input off does not detach mid-command. Also: reading-time pacing, DOM-first extract, exponential captcha backoff (open the popup after `/sorry` to clear the gate).

Broker HTTP: `/ext/register`, `/ext/poll`, `/ext/events`, `/ext/commands`, `/ext/commands/{id}/wait`, `/ext/commands/{id}/cancel`, `/ext/browsers`.

## Ollama CPU usage

By default Ollama often uses only physical/performance cores. To push more CPU:

**Threads per request** (`num_thread`) — main lever for single-model throughput:

```bash
# Persistent: wrap the embedding model
printf '%s\n' 'FROM qwen3-embedding:8b' 'PARAMETER num_thread 16' > /tmp/Modelfile
ollama create qwen3-embedding:8b-t16 -f /tmp/Modelfile
# then point config.json models[].name at qwen3-embedding:8b-t16
```

On recent Ollama builds you can also set a global override before starting the server:

```bash
export OLLAMA_NUM_THREADS=16   # physical cores is a good starting point
```

**Linux systemd** (system install):

```bash
sudo systemctl edit ollama.service
```

```ini
[Service]
Environment="OLLAMA_NUM_THREADS=16"
# Optional: more concurrent embed requests (RAM scales with this × context)
Environment="OLLAMA_NUM_PARALLEL=2"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

`OLLAMA_NUM_PARALLEL` runs multiple requests at once (useful for **search** dual-query embeds or other clients). The document embed worker already serializes models, so parallel is **not** required for Takeout/backfill. It does **not** replace `num_thread` / `OLLAMA_NUM_THREADS`. Prefer physical-core count first, then benchmark.

This KB sends `options.num_thread` on every `/api/embed` call (default: logical CPUs ÷ 2). Override with `ollama.num_thread` or per-model `models[].num_thread` in `config.json`. systemd `OLLAMA_NUM_THREADS` is often ignored by the runner.

## systemd (user)

Unit: [`deploy/knowledge-base.service`](deploy/knowledge-base.service) — `kb serve` on `127.0.0.1:9099`.

```bash
mkdir -p ~/.config/systemd/user
cp deploy/knowledge-base.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now knowledge-base.service
# Optional: keep the user manager after logout (boot-start without a GUI session)
loginctl enable-linger "$USER"
systemctl --user status knowledge-base.service
```

## Config

Edit `config.json` (`data_dir`, models, fusion weights, BM25, sibling boosts, …).

- Empty `"models": []` or `"ollama": {"enabled": false}` → lexical-only mode (`/health` reports `"embeddings": false`).
- With models configured, store responses include `"embeddings": true` and the embed worker runs on startup.
