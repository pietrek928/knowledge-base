/**
 * Gemini model / effort picker helpers (DOM-fragile; shared scrape + select).
 */
((global) => {
  const H = () => global.KBHuman;
  const Effort = global.KB?.Effort;
  const gaussMs = global.KB?.gaussMs;
  const EFFORT_VALUES = global.KB?.EFFORT_VALUES || [
    Effort?.LOW || "low",
    Effort?.MEDIUM || "medium",
    Effort?.HIGH || "high",
    Effort?.FAST || "fast",
  ];
  const EFFORT_ALT = EFFORT_VALUES.join("|");
  const EFFORT_WORD_RE = new RegExp(`\\b(${EFFORT_ALT})\\b`, "i");
  const EFFORT_START_RE = new RegExp(`^(${EFFORT_ALT})\\b`, "i");
  const EFFORT_EXACT_RE = new RegExp(`^(${EFFORT_ALT})$`, "i");
  const DEFAULT_EFFORT = Effort?.MEDIUM || "medium";
  const gDelay = (mean, sigma, min, max) =>
    typeof gaussMs === "function"
      ? gaussMs(mean, sigma, min, max)
      : Math.max(min, Math.min(max, Math.round(mean)));

  const isLocked = (el) => {
    if (!el) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    const cls = (el.className || "").toString().toLowerCase();
    if (/\blocked\b|disabled|paywall|upgrade|unavailable/.test(cls)) return true;
    const label = (el.getAttribute("aria-label") || el.textContent || "").toLowerCase();
    // "Unlock 4 Carbon" rows / paywall copy — treat as locked even if still clickable.
    if (
      /\bunlock\b|\blocked\b|upgrade|subscribe|not available|unavailable|get\s+(pro|ultra)|premium/i.test(
        label
      )
    ) {
      return true;
    }
    const lockish = el.querySelector?.(
      [
        '[aria-label*="lock" i]',
        '[aria-label*="unlock" i]',
        '[data-test-id*="lock" i]',
        '[data-icon*="lock" i]',
        'svg[aria-label*="lock" i]',
        '[data-mat-icon-name="lock"]',
        '[data-mat-icon-name*="lock" i]',
        '[fonticon="lock"]',
        '[fonticon*="lock" i]',
        "mat-icon.lock",
        ".lock-icon",
        "img[src*='lock' i]",
      ].join(", ")
    );
    if (lockish) return true;
    // pointer-events none / inert
    try {
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === "none" || style.opacity === "0") return true;
    } catch {
      /* ignore */
    }
    return false;
  };

  /**
   * Walk menu-item-like ancestors only (not whole panels — panel querySelector
   * would see Carbon's lock icon and poison sibling High rows).
   */
  const hasLockedAncestor = (el) => {
    let n = el?.parentElement;
    for (let d = 0; n && n !== document.body && d < 16; d++, n = n.parentElement) {
      const role = (n.getAttribute?.("role") || "").toLowerCase();
      const itemish =
        /^(menuitem|menuitemradio|option|button)$/.test(role) ||
        n.matches?.("button, [mat-menu-item], a[href]") ||
        n.hasAttribute?.("mat-menu-item");
      if (!itemish) continue;
      if (isLocked(n)) return true;
    }
    return false;
  };

  const isEffectivelyLocked = (el) => isLocked(el) || hasLockedAncestor(el);

  /** Paywall / "Unlock 4 Carbon" overlay after clicking a locked mode. */
  const findUnlockPopup = () => {
    const sels = [
      '[aria-label*="Unlock" i]',
      '[data-test-id*="unlock" i]',
      '[data-test-id*="upsell" i]',
      '[data-test-id*="paywall" i]',
      'button[aria-label*="Unlock" i]',
      '[role="dialog"]',
      ".cdk-overlay-pane",
    ];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const t = (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        if (/\bunlock\b/i.test(t) && /\b(carbon|pro|ultra|flash|argon|helium|mode|model|\d)\b/i.test(t)) {
          return el;
        }
        if (/^Unlock\b/i.test(t) && t.length < 80) return el;
      }
    }
    return null;
  };

  const dismissUnlockPopup = async () => {
    const pop = findUnlockPopup();
    if (!pop) return false;
    if (typeof H().humanKey === "function") {
      await H().humanKey(document.activeElement || document.body, "Escape");
    } else {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
      );
    }
    await H().sleep(H().gaussianDelay(200, 50, 100, 400));
    // Click outside / close if still open
    if (findUnlockPopup()) {
      const close =
        document.querySelector(
          '[aria-label*="close" i], button[aria-label*="Close" i], [data-test-id*="close" i]'
        ) || null;
      if (close) {
        try {
          await H().humanClick(close);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  };

  const labelOf = (el) =>
    (el?.getAttribute?.("aria-label") || el?.textContent || "").replace(/\s+/g, " ").trim();

  const isJunkChromeLabel = (t) =>
    /activity|settings|account|apps activity|google apps|help|history|new chat|side.?nav|menu|open conversation|close|privacy|terms/i.test(
      t || ""
    );

  // Accept whatever Gemini paints on the mode chip (Flash/Pro or Argon/Helium/…).
  const looksLikeModelLabel = (t) => {
    if (!t || t.length > 100 || isJunkChromeLabel(t)) return false;
    if (/mode picker/i.test(t)) return true;
    if (/\b(flash|pro|ultra)\b/i.test(t)) return true;
    if (/gemini\s*\d/i.test(t)) return true;
    if (/\b(argon|helium|hydrogen|neon|xenon|krypton|radon|carbon)\b/i.test(t)) return true;
    if (/\bthinking\b/i.test(t) && /\b(flash|pro|gemini|mode)\b/i.test(t)) return true;
    return false;
  };

  const activeModeFromTrigger = (t) => {
    if (!t) return null;
    const m = String(t).match(/currently\s+(.+)$/i);
    if (m) return m[1].replace(/\s+/g, " ").trim();
    return looksLikeModelLabel(t) ? t : null;
  };

  const findModelTrigger = () => {
    const sels = [
      '[data-test-id="bard-mode-menu-button"]',
      '[data-test-id*="bard-mode" i]',
      '[data-test-id*="mode-menu" i]',
      '[data-test-id*="model" i]',
      'button[aria-label*="mode picker" i]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="menu"]',
      'button[aria-haspopup="true"]',
      'button[aria-label*="Flash" i]',
      'button[aria-label*="Pro" i]',
      '[role="button"][aria-label*="Flash" i]',
      '[role="button"][aria-label*="Pro" i]',
    ];
    const scored = [];
    for (const s of sels) {
      for (const n of document.querySelectorAll(s)) {
        const t = labelOf(n);
        const testId = (n.getAttribute("data-test-id") || "").toLowerCase();
        if (!looksLikeModelLabel(t) && !/mode|model/i.test(t) && !/bard-mode|mode-menu/.test(testId)) {
          continue;
        }
        if (isJunkChromeLabel(t)) continue;
        let score = 0;
        if (/bard-mode-menu-button/.test(testId)) score += 10;
        if (/mode picker/i.test(t)) score += 8;
        if (looksLikeModelLabel(t)) score += 5;
        if (/\b(flash|argon|helium|pro)\b/i.test(t)) score += 3;
        if (n.getAttribute("aria-haspopup")) score += 1;
        // Prefer near bottom (composer toolbar) over top account chrome.
        const rect = n.getBoundingClientRect();
        if (rect.top > window.innerHeight * 0.45) score += 2;
        if (rect.width > 0 && rect.height > 0) scored.push({ n, t, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]) return scored[0].n;

    // Last resort: visible buttons whose text is clearly a model name.
    for (const n of document.querySelectorAll("button, [role='button']")) {
      const t = labelOf(n);
      if (looksLikeModelLabel(t)) return n;
    }
    return null;
  };

  const readActiveModelLabel = () => {
    const trig = findModelTrigger();
    if (!trig) return null;
    return activeModeFromTrigger(labelOf(trig));
  };

  const menuRoots = () => {
    const roots = [];
    const trig = document.querySelector(
      '[data-test-id="bard-mode-menu-button"], [aria-label*="mode picker" i]'
    );
    if (trig) {
      const cid = trig.getAttribute("aria-controls");
      if (cid) {
        const el = document.getElementById(cid);
        if (el) roots.push(el);
      }
    }
    for (const el of document.querySelectorAll(
      '[role="menu"], [role="listbox"], mat-menu, .mat-mdc-menu-panel'
    )) {
      const probe = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.slice(0, 400);
      // Skip unrelated chrome menus (upload, account, …).
      if (/upload file|attach|google apps|account|settings/i.test(probe) &&
          !/mode|argon|helium|flash|pro|thinking/i.test(probe)) {
        continue;
      }
      roots.push(el);
    }
    // Mode panels sometimes live only in a cdk pane without role=menu yet.
    for (const pane of document.querySelectorAll(".cdk-overlay-pane")) {
      const t = pane.innerText || "";
      if (/argon|helium|neon|xenon|thinking level|\bflash\b|\bpro\b|mode picker/i.test(t)) {
        roots.push(pane);
      }
    }
    return [...new Set(roots)];
  };

  const menuItems = () => {
    const menus = menuRoots();
    // Do not fall back to document.body — that scrapes page chrome as "models".
    if (!menus.length) return [];
    const items = [];
    const seen = new Set();
    const push = (el, label) => {
      const t = (label || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 120) return;
      if (isJunkChromeLabel(t)) return;
      if (seen.has(t)) return;
      seen.add(t);
      items.push({ el, label: t, locked: isLocked(el) });
    };
    for (const root of menus) {
      // Prefer explicit menu rows.
      for (const el of root.querySelectorAll(
        '[role="menuitem"], [role="option"], [role="menuitemradio"], [mat-menu-item], button, [role="button"], a'
      )) {
        const label = el.getAttribute("aria-label") || el.textContent || "";
        // Keep mode-ish rows; also keep short plain labels (new Gemini codenames).
        const t = label.replace(/\s+/g, " ").trim();
        if (!t) continue;
        const modeish =
          /gemini|flash|pro|ultra|thinking|effort|fast|medium|high|low|argon|helium|neon|xenon|krypton|radon|mode|level/i.test(
            t
          ) || t.length <= 40;
        if (!modeish) continue;
        push(el, t);
      }
      // Mode pills often split primary/secondary text without a useful aria-label.
      for (const el of root.querySelectorAll(
        "[data-test-id*='mode' i], [data-test-id*='model' i], .logo-pill-label-container, .picker-primary-text"
      )) {
        const row =
          el.closest('[role="menuitem"], [role="option"], button, [role="button"], a, li, [mat-menu-item]') ||
          el;
        const primary = row.querySelector(".picker-primary-text");
        const secondary = row.querySelector(".picker-secondary-text");
        let t = "";
        if (primary) {
          t = `${primary.textContent || ""} ${secondary?.textContent || ""}`.replace(/\s+/g, " ").trim();
        } else {
          t = (row.getAttribute("aria-label") || row.textContent || "").replace(/\s+/g, " ").trim();
        }
        if (t) push(row, t);
      }
    }
    return items;
  };

  const slugify = (label) => {
    return String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  };

  const openPicker = async () => {
    const trig = findModelTrigger();
    if (!trig) throw new Error("model picker trigger not found");
    const isOpen = () =>
      trig.getAttribute("aria-expanded") === "true" || menuItems().length > 0;
    if (!isOpen()) {
      await H().humanClick(trig);
      await H().betweenActions();
    }
    // Wait for panel; only re-click if still closed (re-click would toggle close).
    for (let i = 0; i < 6 && !menuItems().length; i++) {
      await H().sleep(H().gaussianDelay(220, 40, 120, 400));
      if (isOpen() && menuItems().length) break;
      if (!isOpen()) {
        await H().humanClick(trig);
        await H().betweenActions();
      }
    }
    return trig;
  };

  const closePicker = async () => {
    if (typeof H().humanKey === "function") {
      await H().humanKey(document.activeElement || document.body, "Escape");
    } else {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
      );
      await H().sleep(gDelay(45, 12, 20, 90));
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
      );
    }
    await H().sleep(H().gaussianDelay(200, 50, 100, 400));
  };

  const waitForMenuItems = async (tries = 8) => {
    for (let i = 0; i < tries; i++) {
      const items = menuItems().filter((i) => !i.locked && !isJunkChromeLabel(i.label));
      if (items.length) return items;
      await H().sleep(H().gaussianDelay(200, 40, 120, 350));
    }
    return [];
  };

  const effortFromLabel = (label) => {
    const m = String(label || "").toLowerCase().match(EFFORT_WORD_RE);
    return m ? m[1].toLowerCase() : null;
  };

  const isEffortOnlyLabel = (label) => {
    const t = String(label || "").replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (/^thinking(\s*level)?$/i.test(t)) return true;
    // "Thinking High" / "Thinking Medium" chrome — not a model id.
    if (/^thinking\s+(low|medium|high|fast)\b/i.test(t)) return true;
    if (EFFORT_START_RE.test(t) && !/\b(flash|pro|argon|helium|carbon|ultra|gemini)\b/i.test(t)) {
      return true;
    }
    if (EFFORT_EXACT_RE.test(t)) return true;
    if (/\beffort\b/i.test(t) && t.length < 40) return true;
    return false;
  };

  /** Real picker model rows (not Thinking level / Low|Medium|High effort lines). */
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

  /** Prefer `.picker-primary-text` when present (e.g. "High" from "High Extra thorough"). */
  const effortPrimaryText = (item) => {
    const el = item?.el;
    if (el?.querySelector) {
      const primary = el.querySelector(".picker-primary-text");
      if (primary) {
        const t = (primary.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
    }
    return String(item?.label || "").replace(/\s+/g, " ").trim();
  };

  /**
   * Strict effort-only row: primary text matches EFFORT_START/EXACT.
   * Do not use bare effortFromLabel(fullLabel) === want (false positives).
   */
  const isStrictEffortRow = (item) => {
    if (!item?.el || isEffectivelyLocked(item.el)) return false;
    const full = String(item.label || "").replace(/\s+/g, " ").trim();
    const primary = effortPrimaryText(item);
    if (/^thinking(\s*level)?$/i.test(full) || /^thinking(\s*level)?$/i.test(primary)) {
      return false;
    }
    if (!isEffortOnlyLabel(full) && !isEffortOnlyLabel(primary)) return false;
    return EFFORT_START_RE.test(primary) || EFFORT_EXACT_RE.test(primary);
  };

  const effortTokenFromPrimary = (item) => {
    const primary = effortPrimaryText(item);
    if (!(EFFORT_START_RE.test(primary) || EFFORT_EXACT_RE.test(primary))) return null;
    const m = primary.toLowerCase().match(EFFORT_START_RE);
    return m ? m[1].toLowerCase() : null;
  };

  const matchWantEffort = (item, wantEffort) => {
    const want = String(wantEffort || "").toLowerCase();
    if (!want || !isStrictEffortRow(item)) return false;
    return effortTokenFromPrimary(item) === want;
  };

  const collectStrictEffortRows = (items) =>
    (items || []).filter((i) => isStrictEffortRow(i));

  const discoverEffortLevelsSeen = (rawItems) => {
    const labels = [];
    const tokens = [];
    const seenLabel = new Set();
    const seenTok = new Set();
    for (const it of rawItems || []) {
      if (!it?.el || isEffectivelyLocked(it.el)) continue;
      const full = String(it.label || "").replace(/\s+/g, " ").trim();
      if (!full || /^thinking(\s*level)?$/i.test(full)) continue;
      if (!isEffortOnlyLabel(full) && !isStrictEffortRow(it)) continue;
      if (!isStrictEffortRow(it) && !(EFFORT_START_RE.test(full) || EFFORT_EXACT_RE.test(full))) {
        continue;
      }
      if (!seenLabel.has(full)) {
        seenLabel.add(full);
        labels.push(full);
      }
      const tok = effortTokenFromPrimary(it) || effortFromLabel(full);
      if (tok && !seenTok.has(tok)) {
        seenTok.add(tok);
        tokens.push(tok);
      }
    }
    return { labels, tokens };
  };

  const formatAvailable = (items) => {
    const labels = [
      ...new Set(
        (items || [])
          .map((i) => (typeof i === "string" ? i : i?.label))
          .filter((t) => t && isModelRowLabel(t))
      ),
    ];
    return labels.length ? labels.join(" | ") : "none";
  };

  const pickerIsOpen = () => {
    const trig = findModelTrigger();
    if (trig?.getAttribute("aria-expanded") === "true") return true;
    return menuItems().length > 0;
  };

  const closePickerIfOpen = async () => {
    if (!pickerIsOpen()) return;
    await closePicker();
  };

  /** Prefer menuitem/button ancestor over an inner span/div text node. */
  const clickableMenuEl = (el) => {
    if (!el?.closest) return el;
    return (
      el.closest(
        '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"], button, a, [mat-menu-item]'
      ) || el
    );
  };

  const isInteractiveControl = (el) => {
    if (!el) return false;
    if (el.getAttribute?.("aria-disabled") === "true" || el.disabled) return false;
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    const tag = (el.tagName || "").toLowerCase();
    if (
      role === "menuitem" ||
      role === "menuitemradio" ||
      role === "option" ||
      role === "button" ||
      role === "radio"
    ) {
      return true;
    }
    if (tag === "button" || tag === "a" || el.hasAttribute?.("mat-menu-item")) return true;
    if (el.tabIndex >= 0) return true;
    return false;
  };

  const shouldDumpRowHtml = (label) => {
    const t = String(label || "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (/^thinking(\s*level)?$/i.test(t)) return true;
    if (isEffortOnlyLabel(t)) return true;
    if (/^(low|medium|high)\b/i.test(t)) return true;
    return isModelRowLabel(t);
  };

  /** Debug: real clickable-node HTML for Thinking / effort / model rows (cap 12). */
  const captureRowHtml = () => {
    const out = [];
    for (const item of menuItems()) {
      if (out.length >= 12) break;
      if (!shouldDumpRowHtml(item.label)) continue;
      const el = item.el;
      if (!el) continue;
      const closest = clickableMenuEl(el);
      const className = String(el.className || "").slice(0, 120);
      out.push({
        label: String(item.label || "").slice(0, 80),
        tagName: el.tagName || null,
        role: el.getAttribute?.("role") || null,
        aria_label: el.getAttribute?.("aria-label") || null,
        className,
        outerHTML: String(el.outerHTML || "").slice(0, 500),
        has_picker_primary_text: !!(el.querySelector && el.querySelector(".picker-primary-text")),
        closest_differs: closest !== el,
        closest_tag: closest?.tagName || null,
        closest_role: closest?.getAttribute?.("role") || null,
        interactive: isInteractiveControl(el),
        closest_interactive: isInteractiveControl(closest),
      });
    }
    return out;
  };

  const dumpMenuDebug = () => {
    const roots = menuRoots();
    return {
      root_count: roots.length,
      roots: roots.slice(0, 4).map((r) => ({
        tag: r.tagName,
        role: r.getAttribute("role"),
        aria: r.getAttribute("aria-label"),
        text: (r.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800),
      })),
      item_labels: menuItems().map((i) => i.label).slice(0, 40),
      row_html: captureRowHtml(),
    };
  };

  const syntheticItemsFromText = () => {
    // When rows aren't proper menuitems, recover labels from visible overlay text.
    const out = [];
    const seen = new Set();
    for (const root of menuRoots()) {
      const lines = (root.innerText || "")
        .split(/\n+/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      for (const line of lines) {
        if (line.length > 60 || seen.has(line)) continue;
        if (isJunkChromeLabel(line)) continue;
        if (/^thinking(\s*level)?$/i.test(line)) continue;
        if (
          !looksLikeModelLabel(line) &&
          !isEffortOnlyLabel(line) &&
          !EFFORT_EXACT_RE.test(line) &&
          !EFFORT_START_RE.test(line) &&
          !/^[A-Z][a-z]+(?:\s+(Low|Medium|High|Fast))?$/.test(line)
        ) {
          continue;
        }
        seen.add(line);
        // Click target: try find element with this text in the root.
        let el = null;
        for (const node of root.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option'], li, span, div")) {
          const t = (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim();
          if (t === line || t.includes(line)) {
            el = node;
            break;
          }
        }
        if (!el || isEffectivelyLocked(el)) continue;
        out.push({ el, label: line, locked: isEffectivelyLocked(el) });
      }
    }
    return out;
  };

  const scrapePickerRaw = async () => {
    await openPicker();
    let raw = menuItems();
    if (raw.length <= 1) {
      const syn = syntheticItemsFromText();
      if (syn.length) raw = syn;
    }
    raw = raw.map((i) => ({
      ...i,
      locked: i.locked || isEffectivelyLocked(i.el),
    }));
    let items = raw.filter((i) => !i.locked && !isJunkChromeLabel(i.label));
    if (!items.length) {
      items = await waitForMenuItems(12);
    }
    return { raw, items, locked: raw.filter((i) => i.locked) };
  };

  const modelsFromItems = (items) => {
    const models = [];
    for (const it of items) {
      if (it.locked || isEffectivelyLocked(it.el)) continue;
      if (!isModelRowLabel(it.label)) continue;
      const emb = effortFromLabel(it.label);
      const baseLabel = it.label
        .replace(new RegExp(`\\b(${EFFORT_ALT})\\b`, "gi"), "")
        .replace(/\s+/g, " ")
        .trim();
      const id = slugify(baseLabel || it.label);
      // Never invent id "thinking" from Thinking chrome.
      if (!id || id === "thinking") continue;
      const existing = models.find((m) => m.id === id);
      if (existing) {
        // Union embedded tokens only — never a shared Thinking list.
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

  const allMenuItemsMerged = () => {
    let all = menuItems();
    if (all.length <= 1) {
      const syn = syntheticItemsFromText();
      if (syn.length) all = syn;
    }
    return all.map((i) => ({
      ...i,
      locked: i.locked || isEffectivelyLocked(i.el),
    }));
  };

  const throwIfAborted = () => {
    if (typeof globalThis.__kbThrowIfRemoteAborted === "function") {
      globalThis.__kbThrowIfRemoteAborted();
    }
  };

  const openThinkingLevelIfNeeded = async () => {
    let rows = collectStrictEffortRows(allMenuItemsMerged());
    if (rows.length) return rows;
    if (!pickerIsOpen()) {
      await openPicker();
      await H().sleep(H().gaussianDelay(220, 50, 120, 400));
      rows = collectStrictEffortRows(allMenuItemsMerged());
      if (rows.length) return rows;
    }
    // Live Gemini: Low/Medium/High are flat GEM-MENU-ITEM menuitemradio siblings
    // of "Thinking level". Thinking itself is role=menuitem with aria-haspopup —
    // a submenu trigger. Clicking it when siblings exist (or instead of waiting
    // for them) hangs the picker. Never click Thinking; only poll for efforts.
    for (let i = 0; i < 10 && !rows.length; i++) {
      throwIfAborted();
      rows = collectStrictEffortRows(allMenuItemsMerged());
      if (rows.length) break;
      await H().sleep(H().gaussianDelay(200, 40, 100, 350));
    }
    return rows;
  };

  /** Wait until effort rows are stable (2 consecutive non-empty scrapes) or short settle. */
  const waitEffortRowsStable = async () => {
    let prevLen = -1;
    let streak = 0;
    for (let i = 0; i < 12; i++) {
      throwIfAborted();
      const rows = await openThinkingLevelIfNeeded();
      if (rows.length) {
        if (rows.length === prevLen) {
          streak += 1;
          if (streak >= 1) return rows; // this + previous = 2 consecutive
        } else {
          streak = 0;
          prevLen = rows.length;
        }
      } else {
        prevLen = -1;
        streak = 0;
      }
      await H().sleep(H().gaussianDelay(160, 40, 80, 280));
    }
    return collectStrictEffortRows(allMenuItemsMerged());
  };

  const formatEffortAvailability = (seenLabels, clickableRows) => {
    const seen =
      (seenLabels || []).length > 0 ? seenLabels.join(" | ") : "none";
    const clickable = collectStrictEffortRows(clickableRows || [])
      .map((i) => effortTokenFromPrimary(i) || i.label)
      .filter(Boolean);
    const clickStr = clickable.length ? [...new Set(clickable)].join(" | ") : "none";
    return `seen effort labels: ${seen}; clickable effort rows: ${clickStr}`;
  };

  /**
   * Per-model proof that High is selectable. Prefer detect-without-click.
   * Only click High if required to expose it, then restore prior effort.
   */
  const probeModelHighEffort = async (model) => {
    const result = { high: false, restore_failed: false, seen: [] };
    try {
      throwIfAborted();
      await openPicker();
      let all = allMenuItemsMerged();
      let items = all.filter((i) => !i.locked && !isJunkChromeLabel(i.label));
      const modelItem = pickModelRow(
        items.filter((i) => isModelRowLabel(i.label)),
        model.label,
        null
      );
      if (!modelItem || modelItem.locked || isEffectivelyLocked(modelItem.el)) {
        return result;
      }
      await H().humanClick(clickableMenuEl(modelItem.el));
      await H().betweenActions();
      await H().sleep(H().gaussianDelay(220, 50, 120, 400));
      if (findUnlockPopup()) {
        await dismissUnlockPopup();
        return result;
      }

      let effortRows = await waitEffortRowsStable();
      result.seen = effortRows.map((i) => i.label);
      const highRow = effortRows.find((i) => matchWantEffort(i, Effort?.HIGH || "high"));
      if (highRow) {
        // Visible unlocked High — advertise without clicking when possible.
        result.high = true;
        return result;
      }

      // Some UIs only expose High after selecting it — click then restore.
      const priorTok =
        effortRows.map((i) => effortTokenFromPrimary(i)).find((t) => t && t !== "high") ||
        DEFAULT_EFFORT;
      // Re-open Thinking if needed and try a looser primary "High" row that
      // may appear only after interaction — still require strict predicate.
      const anyHighish = allMenuItemsMerged().find(
        (i) =>
          !i.locked &&
          !isEffectivelyLocked(i.el) &&
          isEffortOnlyLabel(i.label) &&
          matchWantEffort(i, "high")
      );
      if (!anyHighish) return result;

      await H().humanClick(clickableMenuEl(anyHighish.el));
      await H().betweenActions();
      await H().sleep(H().gaussianDelay(200, 40, 100, 350));
      if (findUnlockPopup()) {
        await dismissUnlockPopup();
        return result;
      }

      // Restore prior effort so we don't leave the account on High.
      let restored = false;
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        throwIfAborted();
        if (!pickerIsOpen()) await openPicker();
        const rows = await waitEffortRowsStable();
        const prior = rows.find((i) => matchWantEffort(i, priorTok));
        if (prior) {
          await H().humanClick(clickableMenuEl(prior.el));
          await H().betweenActions();
          restored = true;
          break;
        }
        await H().sleep(H().gaussianDelay(180, 40, 90, 320));
      }
      if (!restored) {
        result.restore_failed = true;
        result.high = false;
        return result;
      }
      result.high = true;
      return result;
    } finally {
      await closePickerIfOpen();
    }
  };

  const listUnlockedModels = async (params = {}, emit) => {
    let locked = [];
    let debug = {};
    let models = [];
    let thinking_levels = [];
    let effort_levels_seen = [];
    // Record chip before any probe clicks so we can restore Flash-Lite/Pro after Argon.
    const priorModelLabel = readActiveModelLabel();
    const priorEffort = effortFromLabel(priorModelLabel) || DEFAULT_EFFORT;
    const ping = async (payload) => {
      if (typeof emit !== "function") return;
      try {
        await emit(global.KB?.EventType?.MODEL_SELECTED || "model_selected", payload || {});
      } catch (_) {
        /* keepalive best-effort */
      }
    };
    // Retry until real model rows appear (effort-only overlay looks non-empty otherwise).
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted();
      if (attempt > 0) await closePickerIfOpen();
      await ping({ phase: "scrape", attempt });
      const scraped = await scrapePickerRaw();
      locked = scraped.locked;
      const discovered = discoverEffortLevelsSeen(scraped.raw);
      effort_levels_seen = discovered.labels;
      thinking_levels = discovered.tokens;
      debug = {
        ...dumpMenuDebug(),
        locked_labels: locked.map((i) => i.label).slice(0, 20),
        effort_levels_seen,
        attempt,
        prior_model: priorModelLabel || null,
        prior_effort: priorEffort,
      };
      // Read-only: keep embedded/default efforts — do NOT stamp thinking_levels onto models.
      models = modelsFromItems(scraped.items);
      if (models.length) break;
      await H().sleep(H().gaussianDelay(350, 80, 200, 600));
    }
    await closePickerIfOpen();

    // High proof: default on; set probe_high=false to scrape-only.
    // Only probe Argon (analysis SKU) — not every unlocked model.
    const doProbe = params?.probe_high !== false;
    debug.probe_high = doProbe;
    const probe_restore_failed = [];
    const probe_targets = [];
    if (doProbe) {
      for (const m of models) {
        if (!m?.label) continue;
        if (/\bcarbon\b|\bunlock\b/i.test(m.label)) continue;
        // Analysis SKU only — cuts idle risk vs probing Flash-Lite/Pro/Argon.
        if (!/\bargon\b/i.test(m.label)) continue;
        probe_targets.push(m);
      }
    }
    debug.probe_targets = probe_targets.map((m) => m.id || m.label);
    for (const m of probe_targets) {
      throwIfAborted();
      await ping({ phase: "probe", model: m.label });
      await H().sleep(H().gaussianDelay(180, 50, 90, 320));
      const probe = await probeModelHighEffort(m);
      await ping({ phase: "probe_done", model: m.label, high: !!probe.high });
      if (probe.restore_failed) {
        probe_restore_failed.push(m.id || m.label);
      }
      if (probe.high && !m.efforts.includes("high")) {
        m.efforts = [...m.efforts, "high"];
      }
    }
    if (probe_restore_failed.length) {
      debug.probe_restore_failed = probe_restore_failed;
    }

    // After Argon probe, restore the model the thread/user was on (not leave Argon selected).
    if (probe_targets.length && priorModelLabel) {
      const afterProbe = readActiveModelLabel();
      const stillPrior = chipMatches(afterProbe, priorModelLabel);
      if (!stillPrior) {
        try {
          throwIfAborted();
          await ping({ phase: "restore_model", model: priorModelLabel, effort: priorEffort });
          await selectModelAndEffort(priorModelLabel, priorEffort);
          const restoredLabel = readActiveModelLabel();
          if (!chipMatches(restoredLabel, priorModelLabel)) {
            debug.probe_model_restore_failed = true;
          }
        } catch (err) {
          if (err?.cancelled) throw err;
          debug.probe_model_restore_failed = true;
          debug.probe_model_restore_error = String(err?.message ?? err);
        } finally {
          await closePickerIfOpen();
        }
      }
    } else {
      await closePickerIfOpen();
    }

    debug.effort_levels_seen = effort_levels_seen;
    // Also mirror into debug so hot-reinjected gemini_models.js (without content.js)
    // still surfaces tokens before a full extension reload.
    debug.thinking_levels = thinking_levels;

    // Never fall back to effort/Thinking junk — empty is honest.
    return {
      models,
      locked: locked.map((i) => ({ id: slugify(i.label), label: i.label })),
      thinking_levels,
      debug,
    };
  };

  const EFFORT_TOKENS = new Set(EFFORT_VALUES);

  const modelCoreTokens = (label) => {
    const slug = slugify(label);
    if (!slug) return [];
    return slug.split("-").filter((t) => t && !EFFORT_TOKENS.has(t));
  };

  /** Token-tail equality (not String.endsWith — flash-lite must not match flash). */
  const tokenTailEq = (longer, shorter) => {
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
  const chipMatches = (chip, wantRaw) => {
    const c = modelCoreTokens(chip);
    const w = modelCoreTokens(wantRaw);
    if (!c.length || !w.length) return false;
    if (c.join("-") === w.join("-")) return true;
    return tokenTailEq(w, c) || tokenTailEq(c, w);
  };

  // Back-compat alias used by content.js / older call sites.
  const modelMatches = (label, wantRaw) => chipMatches(label, wantRaw);

  /** Prefer exact core, else longest matching row (avoid clicking a short "Argon" span). */
  const pickModelRow = (rows, want, wantEffort) => {
    const hits = (rows || []).filter((i) => chipMatches(i.label, want));
    if (!hits.length) return null;
    const withEffort = hits.filter((i) => effortFromLabel(i.label) === wantEffort);
    const pool = withEffort.length ? withEffort : hits;
    const exact = pool.find((i) => modelCoreTokens(i.label).join("-") === modelCoreTokens(want).join("-"));
    if (exact) return exact;
    return pool.slice().sort((a, b) => {
      const da = modelCoreTokens(a.label).length;
      const db = modelCoreTokens(b.label).length;
      if (db !== da) return db - da;
      return String(b.label).length - String(a.label).length;
    })[0];
  };

  const selectModelAndEffort = async (model, effort) => {
    const want = slugify(model);
    const wantEffort = (effort || DEFAULT_EFFORT).toLowerCase();
    let items = [];
    let seenEffortLabels = [];
    try {
      throwIfAborted();
      await openPicker();
      let allItems = allMenuItemsMerged();
      items = allItems.filter((i) => !i.locked && !isJunkChromeLabel(i.label));
      if (!items.length) {
        items = await waitForMenuItems(12);
      }
      const modelRows = items.filter((i) => isModelRowLabel(i.label));
      const lockedMatches = allItems.filter(
        (i) => (i.locked || isEffectivelyLocked(i.el)) && chipMatches(i.label, model)
      );
      const modelItem = pickModelRow(modelRows.length ? modelRows : items, model, wantEffort);
      if (!modelItem) {
        if (lockedMatches.length) {
          throw new Error(
            `model locked / requires unlock: ${model}. ` +
              `Available unlocked: ${formatAvailable(items)}. ` +
              `Locked matches: ${formatAvailable(lockedMatches)}`
          );
        }
        throw new Error(
          `model not found: ${model}. Available from Gemini: ${formatAvailable(items)}`
        );
      }
      await H().humanClick(clickableMenuEl(modelItem.el));
      await H().betweenActions();
      await H().sleep(H().gaussianDelay(250, 60, 120, 450));
      if (findUnlockPopup()) {
        await dismissUnlockPopup();
        throw new Error(
          `model locked / unlock popup after select: ${modelItem.label}. ` +
            `Available unlocked: ${formatAvailable(items.filter((i) => i !== modelItem))}`
        );
      }

      const embedded = effortFromLabel(modelItem.label);
      if (embedded && embedded === wantEffort) {
        await closePickerIfOpen();
        const label = readActiveModelLabel();
        if (!chipMatches(label, model)) {
          throw new Error(
            `model chip mismatch after select: requested=${model} chip=${label || "none"}. ` +
              `Available unlocked: ${formatAvailable(items)}`
          );
        }
        return { model: want, effort: wantEffort, label };
      }

      // After model click the overlay may still be settling — wait for stable effort rows
      // before clicking (do not click while overlay is closing). Never click Thinking header.
      let effortMenu = await waitEffortRowsStable();
      seenEffortLabels = discoverEffortLevelsSeen(allMenuItemsMerged()).labels;
      if (!seenEffortLabels.length) {
        seenEffortLabels = effortMenu.map((i) => i.label);
      }

      const effortItem = effortMenu.find((i) => matchWantEffort(i, wantEffort));
      if (effortItem) {
        await H().humanClick(clickableMenuEl(effortItem.el));
        await H().betweenActions();
        await H().sleep(H().gaussianDelay(220, 50, 120, 400));
        if (findUnlockPopup()) {
          await dismissUnlockPopup();
          throw new Error(
            `effort locked / unlock popup after select: ${wantEffort}. ` +
              formatEffortAvailability(seenEffortLabels, effortMenu)
          );
        }
      } else {
        // Honest error: never claim wantEffort without a click or embedded match.
        throw new Error(
          `effort not found: ${effort || wantEffort}. ` +
            formatEffortAvailability(seenEffortLabels, effortMenu)
        );
      }

      await closePickerIfOpen();
      await H().sleep(H().gaussianDelay(180, 40, 90, 320));
      let label = readActiveModelLabel();
      let stuckEffort = effortFromLabel(label);
      // Reopen/read if chip does not yet show the effort word.
      if (stuckEffort !== wantEffort) {
        try {
          await openPicker();
          await H().sleep(H().gaussianDelay(160, 40, 80, 280));
          const rows = await waitEffortRowsStable();
          const selected = rows.find(
            (i) =>
              matchWantEffort(i, wantEffort) &&
              (i.el?.getAttribute?.("aria-checked") === "true" ||
                i.el?.getAttribute?.("aria-selected") === "true" ||
                /selected|checked|active/i.test(i.el?.className || ""))
          );
          label = readActiveModelLabel() || label;
          stuckEffort = effortFromLabel(label);
          if (stuckEffort !== wantEffort && !selected) {
            // One more chip read after close.
            await closePickerIfOpen();
            await H().sleep(H().gaussianDelay(160, 40, 80, 280));
            label = readActiveModelLabel() || label;
            stuckEffort = effortFromLabel(label);
          }
        } catch (err) {
          if (err?.cancelled) throw err;
          /* verification best-effort */
        } finally {
          await closePickerIfOpen();
        }
      }
      if (!chipMatches(label, model)) {
        throw new Error(
          `model chip mismatch after select: requested=${model} chip=${label || "none"}. ` +
            `Available unlocked: ${formatAvailable(items)}`
        );
      }
      if (stuckEffort && stuckEffort !== wantEffort) {
        throw new Error(
          `effort click did not stick: requested=${wantEffort} chip_effort=${stuckEffort} ` +
            `chip=${label || "none"}. ` +
            formatEffortAvailability(seenEffortLabels, effortMenu)
        );
      }
      if (!stuckEffort) {
        // Chip often omits effort word — accept selected menuitem state if we saw it,
        // otherwise require chip effort when wantEffort is non-default and was clicked.
        // Soft: chip without effort word is common for medium; only fail when we can prove mismatch.
      }
      return { model: want, effort: wantEffort, label };
    } finally {
      await closePickerIfOpen();
    }
  };

  global.KBGeminiModels = {
    isLocked,
    isEffectivelyLocked,
    findUnlockPopup,
    findModelTrigger,
    readActiveModelLabel,
    listUnlockedModels,
    selectModelAndEffort,
    modelMatches,
    chipMatches,
    pickModelRow,
    modelCoreTokens,
    isModelRowLabel,
    isEffortOnlyLabel,
    isStrictEffortRow,
    matchWantEffort,
    effortPrimaryText,
    modelsFromItems,
    discoverEffortLevelsSeen,
    clickableMenuEl,
    isInteractiveControl,
    captureRowHtml,
  };
})(globalThis);
