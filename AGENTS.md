# Agent notes (knowledge-base)

## Workflow: subagents for long work, Grok for review

Do **not** burn the main chat context on long multi-file development (enums, Gaussian sweeps, full smoke suites, large refactors). That fills context, slows later turns, and makes the parent agent worse at steering.

1. **Implement via Task subagents** (`generalPurpose` / `explore`) with a tight brief, absolute paths, and a clear done condition. Prefer parallel subagents when workstreams are independent.
2. Parent agent stays thin: decide scope, launch agents, integrate results, ask the user only when blocked.
3. **After** the implementation lands (or after a plan is drafted), run a **Grok review** (`Task` + `model: grok-4.7-high`) on the plan/diff/skill — not as the primary coder.
4. Apply Grok’s P0/P1 amendments, then optionally a short Grok follow-up. Don’t re-do the whole feature in the parent thread.
5. **Before a real Gemini `kb-cli query`**, use Grok to draft the full front-loaded brief (enough paths, diffs, logs, goal, constraints). Pass Grok enough context so Gemini gets enough context. Smokes skip this. Details: `gemini-kb` skill.

Short answers, one-line fixes, and user Q&A stay in the main agent.

## Gemini extension: rebuild → reload → smoke

`npm run build` in `extension/gemini-kb` only updates `dist/`. Chromium keeps the previous SW/content scripts until the **unpacked extension is reloaded**.

1. After any extension code change you will live-test: `npm run build`, then **ask the user to reload** unpacked `extension/gemini-kb/dist` (chrome://extensions → Reload). Do not assume disk hash auto-reload or `chrome.runtime.reload()` already applied.
2. Confirm the new build is live before diagnosing failures: generation deltas should match current code (e.g. `hard_left_ms` ≈ `--timeout`×1000, not 3×; new fields like `tail_gap` / `scroll_fires` present when expected). Stale signs: old `hard_left`, missing new delta keys, empty `browsers[]` until reload.
3. Popup KB URL must stay `http://127.0.0.1:9099`. Empty `browsers[]` with a healthy serve usually means reload the extension (or fix the popup URL) — not a second `kb serve`.

## Gemini extension smoke tests

When smoke-testing `kb-cli` / the Gemini extension (`query`, chip match, keepalive, cancel, etc.):

1. **Reload first** if you rebuilt since the last reload (see above).
2. Prefer the **cheapest unlocked** model from a fresh `uv run kb-cli list-models`.
3. Today that is usually **`Quick answers 3.5 Flash-Lite`** (not Pro, Argon, or locked Carbon).
4. Keep prompts tiny (one-word reply) with a **new nonce** each run. Re-run `list-models` if the label set changes; never hard-code a locked SKU.
5. Only use a heavier model when the test specifically needs that SKU (e.g. Argon chip-suffix regression).
6. Do not enqueue while `browsers[].busy`; abort in-flight work with SIGINT or SIGTERM. SIGKILL leaves `busy` set.
7. **After a fix + reload: re-smoke only what failed** (and a cheap live-build check if needed). Do not re-run the full suite.

```bash
uv run kb-cli browsers   # one server; every browsers[].busy must be false
uv run kb-cli list-models --timeout 180
uv run kb-cli query "Reply with exactly one word: pong. nonce:$RANDOM" \
  --model 'Quick answers 3.5 Flash-Lite' --timeout 180 --final-json
```

**Model skip** (chip already matches): run the same `--model` twice. Assert `model_selected.payload.skipped === true` on the second (or first, if the chip was already that model). Do **not** use composing deltas as a skip proxy — keepalive still emits `composing: true` after select/skip. Skip gate is `pickerIsOpen()`, not `menuRoots().length` (closed `aria-controls` panels stay in the DOM).

**Scroll deltas**: expect `tail_gap` / `scroll_top` / `hard_left_ms` on generation deltas. `scroll_fires` may stay `0` when Gemini auto-follows the tip above the composer while length grows.

**Fresh vs continue**: `query` without `--conversation-id` forces a New chat (do not reuse densify/mine tabs). Pass `--conversation-id` to continue a thread. `list-models` accepts `--final-json` for script parity (output is already one JSON object).

**Never** `kb-cli … | python <<'PY'` — the heredoc steals stdin from the pipe. Write CLI JSON to a file, then `python` that path (or use `python -c` with an explicit file read).

If `kb-cli browsers` cannot connect, start **one** `kb serve` on `:9099`. If the port is already open, do not start another — duplicate listeners flap `browsers[]`.

## Waits / pacing (no fixed sleeps)

When the agent sleeps, polls, or inserts a gap between CLI/browser actions, use a **Gaussian** delay (mean ± sigma, clamped), not a flat `sleep N`. Fixed intervals create a detectable cadence.

```bash
# gauss_sleep MEAN SIGMA LO HI — sample ~N(mean, sigma), clamp to [lo, hi], then sleep.
# Paste the function and the call in the same shell. Example call overrides the defaults.
gauss_sleep() {
  local mean=${1:-2} sigma=${2:-0.6} lo=${3:-0.4} hi=${4:-5}
  python - <<PY
import random, time
mu, sig, lo, hi = $mean, $sigma, $lo, $hi
t = max(lo, min(hi, random.gauss(mu, sig)))
time.sleep(t)
print(f"# slept {t:.2f}s", flush=True)
PY
}
gauss_sleep 2 0.7 0.5 4
```

Extension + CLI use the same rule: extension imports `gaussMs` from `extension/gemini-kb/src/shared/constants.js` (no `KB` globals); background `sleepGauss` is module-local; CLI `_gauss_sleep` — no flat `sleep(N)` / `setTimeout(..., N)` / fixed backoffs for pacing.
