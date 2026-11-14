/**
 * Gemini model / effort picker helpers (DOM-fragile; shared scrape + select).
 */
((global) => {
  const H = () => global.KBHuman;

  const isLocked = (el) => {
    if (!el) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    const cls = (el.className || "").toString().toLowerCase();
    if (/\blocked\b|disabled|paywall|upgrade|unavailable/.test(cls)) return true;
    const label = (el.getAttribute("aria-label") || el.textContent || "").toLowerCase();
    if (/\blocked\b|upgrade|subscribe|not available|unavailable/.test(label)) return true;
    if (el.querySelector?.('[aria-label*="lock" i], [data-icon*="lock" i], mat-icon, .lock')) {
      const lockish = el.querySelector(
        '[aria-label*="lock" i], [data-test-id*="lock" i], svg[aria-label*="lock" i]'
      );
      if (lockish) return true;
    }
    // pointer-events none / inert
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === "none" || style.opacity === "0") return true;
    return false;
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
      await H().sleep(40);
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
    const m = String(label || "")
      .toLowerCase()
      .match(/\b(low|medium|high|fast)\b/);
    return m ? m[1] : null;
  };

  const formatAvailable = (items) => {
    const labels = [...new Set((items || []).map((i) => i.label).filter(Boolean))];
    return labels.length ? labels.join(" | ") : "none";
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
        if (/^thinking\s*level$/i.test(line)) continue;
        if (
          !looksLikeModelLabel(line) &&
          !/^(low|medium|high|fast)$/i.test(line) &&
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
        if (el) out.push({ el, label: line, locked: isLocked(el) });
      }
    }
    return out;
  };

  const listUnlockedModels = async () => {
    await openPicker();
    let items = await waitForMenuItems(12);
    if (items.length <= 1) {
      const syn = syntheticItemsFromText();
      if (syn.length) items = syn;
    }
    const debug = dumpMenuDebug();
    // Heuristic: model rows vs effort rows — labels are whatever Gemini shows.
    const models = [];
    const effortsByModel = new Map();
    let current = null;
    for (const it of items) {
      const isEffort =
        /^(low|medium|high|fast)\b/i.test(it.label.trim()) || /\beffort\b/i.test(it.label);
      // Section headers like "Thinking level" are not selectable models.
      if (/^thinking\s*level$/i.test(it.label.trim())) continue;
      if (isEffort && current) {
        const arr = effortsByModel.get(current) || [];
        const e = it.label.toLowerCase().match(/low|medium|high|fast/)?.[0] || slugify(it.label);
        if (!arr.includes(e)) arr.push(e);
        effortsByModel.set(current, arr);
        continue;
      }
      if (
        looksLikeModelLabel(it.label) ||
        /\b(flash|pro|ultra|argon|helium|hydrogen|neon|xenon|krypton|radon|carbon)\b/i.test(it.label) ||
        // Live picker rows: "Quick answers 3.5 Flash-Lite", "Code & analysis 4 Argon", …
        /\b(flash-?lite|answers|research|analysis|complex work|everyday help)\b/i.test(it.label) ||
        (/^[A-Z][a-z]+(?:\s+(Low|Medium|High|Fast))?$/.test(it.label) && it.label.length <= 40)
      ) {
        const emb = effortFromLabel(it.label);
        const baseLabel = it.label.replace(/\b(low|medium|high|fast)\b/gi, "").replace(/\s+/g, " ").trim();
        const id = slugify(baseLabel || it.label);
        current = id;
        if (!models.find((m) => m.id === id)) {
          models.push({ id, label: baseLabel || it.label, efforts: [] });
        }
        const arr = effortsByModel.get(id) || [];
        const e = emb || "medium";
        if (!arr.includes(e)) arr.push(e);
        effortsByModel.set(id, arr);
      }
    }
    for (const m of models) {
      m.efforts = effortsByModel.get(m.id) || ["medium"];
    }
    await closePicker();
    if (!models.length) {
      // Surface raw Gemini labels so callers know what the picker actually showed.
      return {
        models: items.map((i) => ({
          id: slugify(i.label),
          label: i.label,
          efforts: effortFromLabel(i.label) ? [effortFromLabel(i.label)] : ["medium"],
        })),
        debug,
      };
    }
    return { models, debug };
  };

  // Match only against Gemini's own labels (no aliases).
  // "Argon" → "… 4 Argon"; "Flash" does NOT match "… Flash-Lite".
  const modelMatches = (label, wantRaw) => {
    const a = slugify(label);
    const b = slugify(wantRaw);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.endsWith("-" + b) || a.startsWith(b + "-")) return true;
    // Embedded effort: "argon-high" vs want "argon"
    for (const e of ["low", "medium", "high", "fast"]) {
      if (a === `${b}-${e}` || a.endsWith(`-${b}-${e}`)) return true;
    }
    return false;
  };

  const selectModelAndEffort = async (model, effort) => {
    const want = slugify(model);
    const wantEffort = (effort || "medium").toLowerCase();
    await openPicker();
    let items = await waitForMenuItems(12);
    if (items.length <= 1) {
      const syn = syntheticItemsFromText();
      if (syn.length) items = syn;
    }
    const candidates = items.filter((i) => modelMatches(i.label, model));
    // Prefer combined rows like "Argon High" when effort is embedded in the label.
    let modelItem =
      candidates.find((i) => effortFromLabel(i.label) === wantEffort) ||
      candidates.find((i) => !effortFromLabel(i.label)) ||
      candidates[0];
    if (!modelItem) {
      await closePicker();
      throw new Error(
        `model not found: ${model}. Available from Gemini: ${formatAvailable(items)}`
      );
    }
    await H().humanClick(modelItem.el);
    await H().betweenActions();

    const embedded = effortFromLabel(modelItem.label);
    if (embedded && embedded === wantEffort) {
      await closePicker();
      return { model: want, effort: wantEffort, label: readActiveModelLabel() };
    }

    // Effort submenu may appear after selecting model
    items = menuItems().filter((i) => !i.locked);
    const effortItem = items.find((i) => {
      const l = i.label.toLowerCase();
      return (
        /^(low|medium|high|fast)\b/.test(l.trim()) &&
        (l.includes(wantEffort) || slugify(i.label).includes(wantEffort))
      );
    });
    if (effortItem) {
      await H().humanClick(effortItem.el);
      await H().betweenActions();
    } else if (embedded && embedded !== wantEffort) {
      await closePicker();
      throw new Error(
        `effort not found: ${effort}. Available from Gemini: ${embedded}`
      );
    } else if (effort && effort !== "medium") {
      // Explicit non-default effort requested but no effort row appeared.
      const effortOpts = items
        .filter((i) => /^(low|medium|high|fast)\b/i.test(i.label.trim()) || effortFromLabel(i.label))
        .map((i) => i.label);
      await closePicker();
      throw new Error(
        `effort not found: ${effort}. Available from Gemini: ${
          effortOpts.length ? effortOpts.join(" | ") : formatAvailable(items) || "none (model has no effort picker)"
        }`
      );
    } else {
      // Default medium / no separate effort UI — model row click is enough.
      await closePicker();
    }
    return { model: want, effort: wantEffort, label: readActiveModelLabel() };
  };

  global.KBGeminiModels = {
    isLocked,
    findModelTrigger,
    readActiveModelLabel,
    listUnlockedModels,
    selectModelAndEffort,
  };
})(globalThis);
