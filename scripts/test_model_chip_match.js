/**
 * Regression for gemini_models.js chipMatches / tokenTailEq / pickModelRow /
 * isEffortOnlyLabel / isModelRowLabel / modelsFromItems (raw scrape, no probe).
 * Mirrors the pure algorithm (keep in sync with extension/gemini-kb/gemini_models.js).
 */
require("../extension/gemini-kb/constants.js");
const EFFORT_VALUES = globalThis.KB.EFFORT_VALUES;
const EFFORT_TOKENS = new Set(EFFORT_VALUES);
const EFFORT_ALT = EFFORT_VALUES.join("|");
const EFFORT_WORD_RE = new RegExp(`\\b(${EFFORT_ALT})\\b`, "i");
const EFFORT_START_RE = new RegExp(`^(${EFFORT_ALT})\\b`, "i");
const EFFORT_EXACT_RE = new RegExp(`^(${EFFORT_ALT})$`, "i");
const DEFAULT_EFFORT = globalThis.KB.Effort.MEDIUM;

const slugify = (label) =>
  String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const modelCoreTokens = (label) => {
  const slug = slugify(label);
  if (!slug) return [];
  return slug.split("-").filter((t) => t && !EFFORT_TOKENS.has(t));
};

const tokenTailEq = (longer, shorter) => {
  if (!shorter.length || longer.length < shorter.length) return false;
  const n = shorter.length;
  for (let i = 0; i < n; i++) {
    if (longer[longer.length - n + i] !== shorter[i]) return false;
  }
  return true;
};

const chipMatches = (chip, wantRaw) => {
  const c = modelCoreTokens(chip);
  const w = modelCoreTokens(wantRaw);
  if (!c.length || !w.length) return false;
  if (c.join("-") === w.join("-")) return true;
  return tokenTailEq(w, c) || tokenTailEq(c, w);
};

const pickModelRow = (rows, want) => {
  const hits = (rows || []).filter((i) => chipMatches(i.label, want));
  if (!hits.length) return null;
  const exact = hits.find(
    (i) => modelCoreTokens(i.label).join("-") === modelCoreTokens(want).join("-")
  );
  if (exact) return exact;
  return hits.slice().sort((a, b) => {
    const da = modelCoreTokens(a.label).length;
    const db = modelCoreTokens(b.label).length;
    if (db !== da) return db - da;
    return String(b.label).length - String(a.label).length;
  })[0];
};

const effortFromLabel = (label) => {
  const m = String(label || "").toLowerCase().match(EFFORT_WORD_RE);
  return m ? m[1].toLowerCase() : null;
};

const isJunkChromeLabel = (t) =>
  /activity|settings|account|apps activity|google apps|help|history|new chat|side.?nav|menu|open conversation|close|privacy|terms/i.test(
    t || ""
  );

const looksLikeModelLabel = (t) => {
  if (!t || t.length > 100 || isJunkChromeLabel(t)) return false;
  if (/mode picker/i.test(t)) return true;
  if (/\b(flash|pro|ultra)\b/i.test(t)) return true;
  if (/gemini\s*\d/i.test(t)) return true;
  if (/\b(argon|helium|hydrogen|neon|xenon|krypton|radon|carbon)\b/i.test(t)) return true;
  if (/\bthinking\b/i.test(t) && /\b(flash|pro|gemini|mode)\b/i.test(t)) return true;
  return false;
};

const isEffortOnlyLabel = (label) => {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (/^thinking(\s*level)?$/i.test(t)) return true;
  if (/^thinking\s+(low|medium|high|fast)\b/i.test(t)) return true;
  if (EFFORT_START_RE.test(t) && !/\b(flash|pro|argon|helium|carbon|ultra|gemini)\b/i.test(t)) {
    return true;
  }
  if (EFFORT_EXACT_RE.test(t)) return true;
  if (/\beffort\b/i.test(t) && t.length < 40) return true;
  return false;
};

const isModelRowLabel = (label) => {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t || isJunkChromeLabel(t) || isEffortOnlyLabel(t)) return false;
  if (/^thinking\b/i.test(t) && !/\b(flash|pro|gemini|mode|argon|helium)\b/i.test(t)) {
    return false;
  }
  if (looksLikeModelLabel(t)) return true;
  if (/\b(flash|pro|ultra|argon|helium|hydrogen|neon|xenon|krypton|radon|carbon)\b/i.test(t)) {
    return true;
  }
  if (/\b(flash-?lite|answers|research|analysis|complex work|everyday help)\b/i.test(t)) {
    return true;
  }
  if (/^[A-Z][a-z]+(?:\s+(Low|Medium|High|Fast))?$/.test(t) && t.length <= 40) return true;
  return false;
};

/** Raw scrape modelsFromItems (no per-model High probe). */
const modelsFromItems = (items) => {
  const models = [];
  for (const it of items) {
    if (it.locked) continue;
    if (!isModelRowLabel(it.label)) continue;
    const emb = effortFromLabel(it.label);
    const baseLabel = it.label
      .replace(new RegExp(`\\b(${EFFORT_ALT})\\b`, "gi"), "")
      .replace(/\s+/g, " ")
      .trim();
    const id = slugify(baseLabel || it.label);
    if (!id || id === "thinking") continue;
    const existing = models.find((m) => m.id === id);
    if (existing) {
      if (emb && !existing.efforts.includes(emb)) existing.efforts.push(emb);
      continue;
    }
    models.push({
      id,
      label: baseLabel || it.label,
      efforts: emb ? [emb] : [DEFAULT_EFFORT],
    });
  }
  return models;
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Live densify chip cases
assert(chipMatches("Argon", "Code & analysis 4 Argon"), "Argon chip");
assert(chipMatches("Pro", "Detailed research 3.1 Pro"), "Pro chip");
assert(chipMatches("Flash-Lite", "Quick answers 3.5 Flash-Lite"), "Flash-Lite chip");

// Symmetric / full labels
assert(chipMatches("Code & analysis 4 Argon", "Argon"), "full vs short");
assert(chipMatches("Code & analysis 4 Argon", "Code & analysis 4 Argon"), "exact");

// Flash ≠ Flash-Lite (String.endsWith would wrongly pass)
assert(!chipMatches("Flash", "Flash-Lite"), "Flash vs Flash-Lite");
assert(!chipMatches("Flash-Lite", "Flash"), "Flash-Lite vs Flash");
assert(!("flash-lite".endsWith("flash") && chipMatches("Flash", "x Flash-Lite")), "no string endsWith trap");

// True mismatches
assert(!chipMatches("Argon", "Most complex work 4 Carbon"), "Argon vs Carbon");
assert(!chipMatches("Carbon", "Code & analysis 4 Argon"), "Carbon vs Argon");
assert(!chipMatches("High", "Code & analysis 4 Argon"), "effort-only");
assert(!chipMatches("Medium Balanced depth", "Code & analysis 4 Argon"), "effort prose");

// Longest row wins
const picked = pickModelRow(
  [
    { label: "Argon", el: 1 },
    { label: "Code & analysis 4 Argon", el: 2 },
  ],
  "Code & analysis 4 Argon"
);
assert(picked && picked.label === "Code & analysis 4 Argon", "longest row");

// --- Effort / Thinking classifiers (High discovery fixtures) ---
assert(isEffortOnlyLabel("Thinking level"), "Thinking level is effort chrome");
assert(isEffortOnlyLabel("High"), "High is effort-only");
assert(isEffortOnlyLabel("Low"), "Low is effort-only");
assert(isEffortOnlyLabel("Thinking High"), "Thinking High is effort chrome");
assert(isEffortOnlyLabel("Medium Balanced depth"), "Medium Balanced depth is effort-only");
assert(isEffortOnlyLabel("High Extra thorough"), "High Extra thorough is effort-only");
assert(isEffortOnlyLabel("Low Fast and efficient"), "Low Fast and efficient is effort-only");

assert(!isModelRowLabel("Thinking level"), "Thinking level not a model");
assert(!isModelRowLabel("High"), "High not a model");
assert(!isModelRowLabel("Low"), "Low not a model");
assert(!isModelRowLabel("Thinking High"), "Thinking High not a model");
assert(!isModelRowLabel("Medium Balanced depth"), "Medium Balanced depth not a model");
assert(!isModelRowLabel("High Extra thorough"), "High Extra thorough not a model");

assert(isModelRowLabel("Quick answers 3.5 Flash-Lite"), "Flash-Lite is a model");
assert(isModelRowLabel("Code & analysis 4 Argon"), "Argon is a model");
assert(isModelRowLabel("Most complex work 4 Carbon"), "Carbon label is model-shaped");
assert(isModelRowLabel("Unlock 4 Carbon"), "Unlock 4 Carbon is model-shaped (lock via isLocked)");

// Raw scrape must not stamp shared Thinking High onto every model; no id "thinking"
const rawScrape = modelsFromItems([
  { label: "Quick answers 3.5 Flash-Lite", locked: false },
  { label: "Detailed research 3.1 Pro", locked: false },
  { label: "Code & analysis 4 Argon", locked: false },
  { label: "Most complex work 4 Carbon", locked: true },
  { label: "Thinking level", locked: false },
  { label: "Low Fast and efficient", locked: false },
  { label: "Medium Balanced depth", locked: false },
  { label: "High Extra thorough", locked: false },
  { label: "Thinking High", locked: false },
  { label: "Unlock 4 Carbon", locked: true },
]);
assert(
  !rawScrape.some((m) => m.id === "thinking"),
  "no model id thinking from Thinking chrome"
);
const flash = rawScrape.find((m) => /flash-lite/i.test(m.id));
assert(flash, "Flash-Lite present");
assert(
  JSON.stringify(flash.efforts) === JSON.stringify(["medium"]),
  "Flash-Lite stays [medium] on raw scrape without probe"
);
assert(
  !rawScrape.some((m) => m.efforts.includes("high")),
  "raw scrape must not stamp high onto models.efforts"
);
assert(
  !rawScrape.some((m) => /carbon|unlock/i.test(m.id) && !m.locked),
  "locked Carbon/Unlock excluded from models"
);

console.log("test_model_chip_match ok");
