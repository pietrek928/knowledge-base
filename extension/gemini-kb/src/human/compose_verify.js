/**
 * Pure compose-prompt compare helpers (no DOM / chrome).
 * Quill innerText inflates blank lines; squash newline runs before compare.
 */

const PASTE_THRESHOLD = 48;
const TYPE_PREFIX_MIN = 20;
const TYPE_PREFIX_MAX = 48;

/** Light normalize (CRLF/NBSP/trim) — used for "is empty?" checks. */
const normalizePrompt = (s) =>
  String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();

/**
 * Compare normalize for composerHasPrompt: squash all newline runs so Quill
 * paragraph / &lt;p&gt;&lt;br&gt;&lt;/p&gt; inflation matches the source brief.
 */
const composeCompareNormalize = (s) =>
  String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\ufeff/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

/**
 * True when composer text holds the intended prompt after Quill whitespace squash.
 * Accept exact match, or full containment with ≤2% length noise (reject truncation
 * and double-paste).
 */
const promptTextsMatch = (haveRaw, wantRaw) => {
  const want = composeCompareNormalize(wantRaw);
  const have = composeCompareNormalize(haveRaw);
  if (!want) return true;
  if (!have) return false;
  if (have === want) return true;
  if (!have.includes(want)) return false;
  return have.length <= Math.ceil(want.length * 1.02);
};

/**
 * Long prompts: human-type a short prefix, paste the rest.
 * CRITICAL: typePart must never contain \\n/\\r — Gemini treats bare Enter as submit.
 */
const splitTypeAndPaste = (text, randFn = Math.random) => {
  const s = String(text ?? "");
  const firstNl = s.search(/[\r\n]/);
  if (firstNl >= 0) {
    let cut = firstNl;
    if (cut > TYPE_PREFIX_MAX) {
      const window = s.slice(0, TYPE_PREFIX_MAX + 24);
      const space = window.search(/[ \t]\S*$/);
      cut =
        space >= TYPE_PREFIX_MIN
          ? space + 1
          : Math.min(TYPE_PREFIX_MAX, firstNl);
    } else if (cut < 8 && s.length > PASTE_THRESHOLD) {
      cut = firstNl;
    }
    return { typePart: s.slice(0, cut), pastePart: s.slice(cut) };
  }
  if (s.length <= PASTE_THRESHOLD) return { typePart: s, pastePart: "" };
  const target = Math.floor(
    TYPE_PREFIX_MIN + randFn() * (TYPE_PREFIX_MAX + 1 - TYPE_PREFIX_MIN)
  );
  let cut = Math.min(target, s.length);
  const window = s.slice(0, Math.min(s.length, target + 24));
  const space = window.search(/[ \t]\S*$/);
  if (space >= TYPE_PREFIX_MIN) cut = space + 1;
  return { typePart: s.slice(0, cut), pastePart: s.slice(cut) };
};

export {
  PASTE_THRESHOLD,
  TYPE_PREFIX_MIN,
  TYPE_PREFIX_MAX,
  normalizePrompt,
  composeCompareNormalize,
  promptTextsMatch,
  splitTypeAndPaste,
};
