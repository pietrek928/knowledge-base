/**
 * Pure model-chip / effort label helpers (no DOM).
 * Shared by models/index.js and the Node chip regression test.
 */
import { Effort, EFFORT_VALUES } from "../shared/constants.js";

const EFFORT_TOKENS = new Set(EFFORT_VALUES);
const EFFORT_ALT = EFFORT_VALUES.join("|");
const EFFORT_WORD_RE = new RegExp(`\\b(${EFFORT_ALT})\\b`, "i");
const EFFORT_START_RE = new RegExp(`^(${EFFORT_ALT})\\b`, "i");
const EFFORT_EXACT_RE = new RegExp(`^(${EFFORT_ALT})$`, "i");
const DEFAULT_EFFORT = Effort.MEDIUM || "medium";

export const slugify = (label) =>
  String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const modelCoreTokens = (label) => {
  const slug = slugify(label);
  if (!slug) return [];
  return slug.split("-").filter((t) => t && !EFFORT_TOKENS.has(t));
};

/** Token-tail equality (not String.endsWith — flash-lite must not match flash). */
export const tokenTailEq = (longer, shorter) => {
  if (!shorter.length || longer.length < shorter.length) return false;
  const n = shorter.length;
  for (let i = 0; i < n; i++) {
    if (longer[longer.length - n + i] !== shorter[i]) return false;
  }
  return true;
};

/**
 * Chip / label match for post-select assert and model_changed.
 * Accepts abbreviated chip "Argon" for want "Code & analysis 4 Argon".
 * Rejects Flash ↔ Flash-Lite (token tails differ).
 */
export const chipMatches = (chip, wantRaw) => {
  const c = modelCoreTokens(chip);
  const w = modelCoreTokens(wantRaw);
  if (!c.length || !w.length) return false;
  if (c.join("-") === w.join("-")) return true;
  return tokenTailEq(w, c) || tokenTailEq(c, w);
};

export const effortFromLabel = (label) => {
  const m = String(label || "")
    .toLowerCase()
    .match(EFFORT_WORD_RE);
  return m ? m[1].toLowerCase() : null;
};

export const isJunkChromeLabel = (t) =>
  /activity|settings|account|apps activity|google apps|help|history|new chat|side.?nav|menu|open conversation|close|privacy|terms/i.test(
    t || ""
  );

export const looksLikeModelLabel = (t) => {
  if (!t || t.length > 100 || isJunkChromeLabel(t)) return false;
  if (/mode picker/i.test(t)) return true;
  if (/\b(flash|pro|ultra)\b/i.test(t)) return true;
  if (/gemini\s*\d/i.test(t)) return true;
  if (/\b(argon|helium|hydrogen|neon|xenon|krypton|radon|carbon)\b/i.test(t)) return true;
  if (/\bthinking\b/i.test(t) && /\b(flash|pro|gemini|mode)\b/i.test(t)) return true;
  return false;
};

export const isEffortOnlyLabel = (label) => {
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

export const isModelRowLabel = (label) => {
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

/** Prefer exact core, else longest matching row (avoid clicking a short "Argon" span). */
export const pickModelRow = (rows, want, wantEffort) => {
  const hits = (rows || []).filter((i) => chipMatches(i.label, want));
  if (!hits.length) return null;
  const withEffort =
    wantEffort != null
      ? hits.filter((i) => effortFromLabel(i.label) === wantEffort)
      : [];
  const pool = withEffort.length ? withEffort : hits;
  const exact = pool.find(
    (i) => modelCoreTokens(i.label).join("-") === modelCoreTokens(want).join("-")
  );
  if (exact) return exact;
  return pool.slice().sort((a, b) => {
    const da = modelCoreTokens(a.label).length;
    const db = modelCoreTokens(b.label).length;
    if (db !== da) return db - da;
    return String(b.label).length - String(a.label).length;
  })[0];
};

/** Raw scrape modelsFromItems (no per-model High probe). Uses `locked` flag only. */
export const modelsFromItems = (items) => {
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

export {
  EFFORT_ALT,
  EFFORT_WORD_RE,
  EFFORT_START_RE,
  EFFORT_EXACT_RE,
  EFFORT_TOKENS,
  DEFAULT_EFFORT,
};
