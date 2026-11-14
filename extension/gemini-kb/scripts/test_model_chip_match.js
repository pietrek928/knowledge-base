/**
 * Regression for models/chip.js chipMatches / tokenTailEq / pickModelRow /
 * isEffortOnlyLabel / isModelRowLabel / modelsFromItems (raw scrape, no probe).
 */
import {
  chipMatches,
  pickModelRow,
  isEffortOnlyLabel,
  isModelRowLabel,
  modelsFromItems,
} from "../src/models/chip.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Live densify chip cases
assert(chipMatches("Argon", "Code & analysis 4 Argon"), "Argon chip");
assert(chipMatches("Pro", "Detailed research 3.1 Pro"), "Pro chip");
assert(chipMatches("Flash-Lite", "Quick answers 3.5 Flash-Lite"), "Flash-Lite chip");

// Case-insensitive short cores (CLI: --model argon:high / flash-lite)
assert(chipMatches("argon", "Code & analysis 4 Argon"), "argon lowercase");
assert(chipMatches("ARGON", "Code & analysis 4 Argon"), "ARGON uppercase");
assert(chipMatches("flash-lite", "Quick answers 3.5 Flash-Lite"), "flash-lite lowercase");
assert(chipMatches("Flash-Lite", "quick answers 3.5 flash-lite"), "want lowercase full");
assert(
  pickModelRow(
    [
      { label: "Quick answers 3.5 Flash-Lite", el: 1 },
      { label: "Code & analysis 4 Argon", el: 2 },
    ],
    "argon",
    "high"
  )?.label === "Code & analysis 4 Argon",
  "pickModelRow argon short"
);

// Symmetric / full labels
assert(chipMatches("Code & analysis 4 Argon", "Argon"), "full vs short");
assert(chipMatches("Code & analysis 4 Argon", "Code & analysis 4 Argon"), "exact");

// Flash ≠ Flash-Lite (String.endsWith would wrongly pass)
assert(!chipMatches("Flash", "Flash-Lite"), "Flash vs Flash-Lite");
assert(!chipMatches("Flash-Lite", "Flash"), "Flash-Lite vs Flash");
assert(
  !("flash-lite".endsWith("flash") && chipMatches("Flash", "x Flash-Lite")),
  "no string endsWith trap"
);

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
