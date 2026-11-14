/**
 * Regression for human/compose_verify.js — Quill newline inflation + type/paste split.
 * Encodes the Argon compose_failed incident shape (have 6345 vs want 6284).
 */
import {
  composeCompareNormalize,
  normalizePrompt,
  promptTextsMatch,
  splitTypeAndPaste,
} from "../src/human/compose_verify.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// --- splitTypeAndPaste: always a non-empty prefix without newlines on multiline
{
  const brief = "## Context\nCLI fixes applied; rest of brief.\n\nMore paragraphs.\n";
  const { typePart, pastePart } = splitTypeAndPaste(brief, () => 0.5);
  assert(typePart.length > 0, "typePart non-empty");
  assert(!/[\r\n]/.test(typePart), "typePart has no newlines");
  assert(typePart === "## Context", `typePart is first line, got ${JSON.stringify(typePart)}`);
  assert(pastePart.startsWith("\n"), "pastePart starts at newline");
  assert(typePart + pastePart === brief, "type+paste reconstitutes");
}

// --- Incident shape: Quill doubles the break after "## Context"
{
  // Source brief (trimmed 6283 shape — short stand-in with same head break pattern)
  const wantRaw =
    "## Context\nCLI fixes applied; retry densify decisions on this thread.\n\n" +
    "webpage refreshed; retry2 submit after prior model_selected hang.\n\n" +
    "Body paragraph one.\n\nBody paragraph two.\n";
  // Live Quill innerText: extra blank line after heading + inflated paragraph gaps
  const haveRaw =
    "## Context\n\nCLI fixes applied; retry densify decisions on this thread.\n\n\n\n\n" +
    "webpage refreshed; retry2 submit after prior model_selected hang.\n\n\n\n\n" +
    "Body paragraph one.\n\n\n\n\nBody paragraph two.\n\n\n";

  const wantLight = normalizePrompt(wantRaw);
  const haveLight = normalizePrompt(haveRaw);
  assert(haveLight.length > wantLight.length, "Quill inflates length before squash");

  // Old 32-char head needle would miss (\n vs \n\n after Context)
  const head = wantLight.slice(0, Math.min(32, wantLight.length));
  assert(
    !haveLight.includes(head),
    `legacy head needle should miss before squash: ${JSON.stringify(head)}`
  );

  const wantSq = composeCompareNormalize(wantRaw);
  const haveSq = composeCompareNormalize(haveRaw);
  assert(haveSq === wantSq, `squash equal: have=${haveSq.length} want=${wantSq.length}`);
  assert(promptTextsMatch(haveRaw, wantRaw), "promptTextsMatch after Quill inflation");
}

// --- Incident numeric anchors from dump (Chrome innerText length 6345 vs raw 6284)
{
  // Synthetic strings with exact lengths after normalizePrompt / composeCompareNormalize
  // are brittle; assert the squash collapses the known run pattern instead.
  const five = "\n\n\n\n\n";
  const src = `A${"\n\n"}B${"\n\n"}C`;
  const live = `A${five}B${five}C`;
  assert(composeCompareNormalize(src) === "A\nB\nC", "source squash");
  assert(composeCompareNormalize(live) === "A\nB\nC", "live squash");
  assert(promptTextsMatch(live, src), "containment equality via squash");
}

// --- Reject truncation and double-paste
{
  const want = "alpha beta gamma delta epsilon";
  assert(!promptTextsMatch("alpha beta", want), "reject truncation");
  assert(!promptTextsMatch(want + want, want), "reject full double-paste");
  assert(
    promptTextsMatch(want + "!", want),
    "accept tiny trailing noise within 2%"
  );
}

// --- Full containment with small wrapper noise only if ≤1.02×
{
  const want = "x".repeat(100);
  const have = "y" + want; // 101 chars — within 1.02× and includes want
  assert(promptTextsMatch(have, want), "101 vs 100 containment ok");
  const tooMuch = "y".repeat(10) + want; // 110 > ceil(102)
  assert(!promptTextsMatch(tooMuch, want), "reject >2% wrapper");
}

console.log("test_compose_verify: ok");
