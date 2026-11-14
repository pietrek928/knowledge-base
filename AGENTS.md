# Agent notes (knowledge-base)

## Workflow: subagents for long work, Grok for review

Do **not** burn the main chat context on long multi-file development (enums, Gaussian sweeps, full smoke suites, large refactors). That fills context, slows later turns, and makes the parent agent worse at steering.

1. **Implement via Task subagents** (`generalPurpose` / `explore`) with a tight brief, absolute paths, and a clear done condition. Prefer parallel subagents when workstreams are independent.
2. Parent agent stays thin: decide scope, launch agents, integrate results, ask the user only when blocked.
3. **After** the implementation lands (or after a plan is drafted), run a **Grok review** (`Task` + `model: grok-4.7-high`) on the plan/diff/skill — not as the primary coder.
4. Apply Grok’s P0/P1 amendments, then optionally a short Grok follow-up. Don’t re-do the whole feature in the parent thread.
5. **Before a real Gemini `kb-cli query`**, use Grok to draft the full front-loaded brief (enough paths, diffs, logs, goal, constraints). Pass Grok enough context so Gemini gets enough context. Smokes skip this. Details: `gemini-kb` skill.

Short answers, one-line fixes, and user Q&A stay in the main agent.

## Gemini extension smoke tests

When smoke-testing `kb-cli` / the Gemini extension (`query`, chip match, keepalive, cancel, etc.):

1. Prefer the **cheapest unlocked** model from a fresh `uv run kb-cli list-models`.
2. Today that is usually **`Quick answers 3.5 Flash-Lite`** (not Pro, Argon, or locked Carbon).
3. Keep prompts tiny (one-word reply) with a **new nonce** each run. Re-run `list-models` if the label set changes; never hard-code a locked SKU.
4. Only use a heavier model when the test specifically needs that SKU (e.g. Argon chip-suffix regression).
5. Do not enqueue while `browsers[].busy`; abort in-flight work with SIGINT only.

```bash
uv run kb-cli browsers   # one server; every browsers[].busy must be false
uv run kb-cli list-models
uv run kb-cli query "Reply with exactly one word: pong. nonce:$RANDOM" \
  --model 'Quick answers 3.5 Flash-Lite' --timeout 180 --final-json
```

If `kb-cli browsers` cannot connect, start **one** `kb serve` on `:8080`. If the port is already open, do not start another — duplicate listeners flap `browsers[]`.

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

Extension + CLI use the same rule: shared `KB.gaussMs` / `sleepGauss` / `_gauss_sleep` — no flat `sleep(N)` / `setTimeout(..., N)` / fixed backoffs for pacing.
