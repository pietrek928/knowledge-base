/**
 * Human-like interaction helpers.
 * Prefers chrome.debugger trusted input (isTrusted: true) via the background;
 * falls back to improved synthetic DOM events if debugger is unavailable.
 */
((global) => {
  const { TrustedAction, MsgType } = global.KB || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rand = (min, max) => min + Math.random() * (max - min);

  const gaussianDelay = (mean, sigma, min, max) => {
    if (typeof global.KB?.gaussMs === "function") {
      return global.KB.gaussMs(mean, sigma, min, max);
    }
    // Fallback Box-Muller if constants.js not loaded: clamp away from 0 so Math.log(u) never -Inf / NaN.
    const eps = Number.EPSILON;
    const u = Math.max(eps, Math.random());
    const v = Math.max(eps, Math.random());
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const val = mean + z * sigma;
    return Math.max(min, Math.min(max, val));
  };

  const betweenActions = async () => {
    await sleep(gaussianDelay(450, 120, 200, 800));
  };

  // Persist cursor across actions (avoid teleporting ±80px each click).
  const cursor = () => {
    if (!global.__KB_CURSOR__) {
      global.__KB_CURSOR__ = {
        x: window.innerWidth * 0.5,
        y: window.innerHeight * 0.5,
      };
    }
    return global.__KB_CURSOR__;
  };

  const callTrusted = async (action, payload = {}) => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: MsgType.TRUSTED_INPUT,
        action,
        ...payload,
      });
      return res && res.ok ? res : null;
    } catch {
      return null;
    }
  };

  const bezierPoints = (x0, y0, x1, y1, steps) => {
    const cx = x0 + (x1 - x0) * rand(0.2, 0.5) + rand(-40, 40);
    const cy = y0 + (y1 - y0) * rand(0.2, 0.5) + rand(-40, 40);
    const out = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      out.push({ x, y });
    }
    return out;
  };

  const keyMeta = (ch) => {
    if (ch === "\n" || ch === "Enter") {
      return { key: "Enter", code: "Enter", keyCode: 13, text: "\r" };
    }
    if (ch === "Backspace") {
      return { key: "Backspace", code: "Backspace", keyCode: 8, text: "" };
    }
    if (ch === " ") {
      return { key: " ", code: "Space", keyCode: 32, text: " " };
    }
    const upper = ch.length === 1 && ch !== ch.toLowerCase();
    const letter = ch.length === 1 && /[a-z]/i.test(ch);
    const code = letter ? `Key${ch.toUpperCase()}` : ch.length === 1 ? `Digit${ch}` : ch;
    return {
      key: ch,
      code: letter ? `Key${ch.toUpperCase()}` : code,
      keyCode: letter ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0),
      text: ch,
      shiftKey: upper,
    };
  };

  const screenXY = (clientX, clientY) => ({
    screenX: Math.round((window.screenX || 0) + clientX),
    screenY: Math.round((window.screenY || 0) + clientY),
  });

  const dispatchPointer = (el, type, x, y, buttons, prev) => {
    const scr = screenXY(x, y);
    const movementX = prev ? x - prev.x : 0;
    const movementY = prev ? y - prev.y : 0;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: scr.screenX,
      screenY: scr.screenY,
      movementX,
      movementY,
      button: 0,
      buttons: buttons ?? (type === "pointerdown" ? 1 : 0),
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      detail: type === "click" ? 1 : 0,
    };
    el.dispatchEvent(new PointerEvent(type, opts));
    const mouseType =
      type === "pointerdown" ? "mousedown" : type === "pointerup" ? "mouseup" : "mousemove";
    el.dispatchEvent(new MouseEvent(mouseType, opts));
  };

  const humanScroll = async (deltaY) => {
    const cap = gaussianDelay(520, 120, 240, 720);
    const sign = deltaY === 0 ? 1 : Math.sign(deltaY);
    const mag = Math.min(Math.abs(deltaY), cap);
    const total = sign * mag;
    const steps = Math.max(3, Math.min(8, Math.round(mag / 80)));
    const cur = cursor();

    const trusted = await callTrusted(TrustedAction.WHEEL, {
      deltaY: total,
      x: cur.x,
      y: cur.y,
      steps,
    });
    if (trusted) return;

    const step = total / steps;
    const scrollEl = () =>
      document.elementFromPoint(cur.x, cur.y) ||
      document.scrollingElement ||
      document.body;
    for (let i = 0; i < steps; i++) {
      const dy = step + rand(-4, 4);
      const target = scrollEl();
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          view: window,
          deltaY: dy,
          deltaMode: 0,
          clientX: cur.x,
          clientY: cur.y,
        })
      );
      await sleep(gaussianDelay(40, 12, 16, 80));
    }
  };

  const scrollIntoViewHuman = async (el) => {
    for (let iter = 0; iter < 3; iter++) {
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const targetY = window.innerHeight * 0.45;
      const delta = mid - targetY;
      if (Math.abs(delta) <= 40) return;
      await humanScroll(delta);
      if (iter < 2) await sleep(gaussianDelay(320, 90, 160, 640));
    }
  };

  const humanClick = async (el) => {
    if (!el) throw new Error("humanClick: missing element");
    await scrollIntoViewHuman(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * rand(0.25, 0.75);
    const y = rect.top + rect.height * rand(0.25, 0.75);
    const cur = cursor();
    const path = bezierPoints(cur.x, cur.y, x, y, Math.floor(rand(14, 28)));

    const trusted = await callTrusted(TrustedAction.CLICK, {
      path: path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
      x: Math.round(x),
      y: Math.round(y),
    });
    cur.x = x;
    cur.y = y;
    if (trusted) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
      return;
    }

    let prev = { x: cur.x, y: cur.y };
    for (const p of path) {
      const target = document.elementFromPoint(p.x, p.y) || el;
      dispatchPointer(target, "pointermove", p.x, p.y, 0, prev);
      prev = p;
      await sleep(gaussianDelay(12, 4, 6, 28));
    }
    await sleep(gaussianDelay(50, 15, 30, 80));
    dispatchPointer(el, "pointerdown", x, y, 1, prev);
    await sleep(gaussianDelay(70, 20, 40, 120));
    dispatchPointer(el, "pointerup", x, y, 0, { x, y });
    const scr = screenXY(x, y);
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: scr.screenX,
        screenY: scr.screenY,
        detail: 1,
        button: 0,
        buttons: 0,
      })
    );
    try {
      el.focus();
    } catch {
      /* ignore */
    }
  };

  const setNativeValue = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  };

  /**
   * Modern CE editing without deprecated document.execCommand.
   * Selection/Range mutates the DOM; InputEvent (beforeinput + input) notifies
   * framework listeners (Angular/Gemini). Trusted CDP path remains preferred.
   */
  const fireEditorInput = (el, inputType, data = null) => {
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType,
          data,
        })
      );
    } catch {
      /* InputEvent ctor / beforeinput unsupported */
    }
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType,
          data,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  const selectionIn = (el) => {
    const sel = window.getSelection?.();
    if (!sel) return null;
    if (sel.rangeCount && el.contains(sel.anchorNode)) return sel;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel;
    } catch {
      return null;
    }
  };

  const selectAllIn = (el) => {
    const sel = window.getSelection?.();
    if (!sel) return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  };

  /** Insert plain text at caret (newlines → <br>). Replaces any selection. */
  const insertPlainAtCaret = (el, text, inputType = "insertText") => {
    const data = String(text ?? "");
    const sel = selectionIn(el);
    if (!sel || !sel.rangeCount) return false;
    try {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const frag = document.createDocumentFragment();
      const parts = data.split("\n");
      let lastNode = null;
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lastNode = document.createElement("br");
          frag.appendChild(lastNode);
        }
        if (parts[i]) {
          lastNode = document.createTextNode(parts[i]);
          frag.appendChild(lastNode);
        }
      }
      if (!lastNode && data === "") {
        // no-op insert (used after select-all clear)
        fireEditorInput(el, inputType, data || null);
        return true;
      }
      range.insertNode(frag);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      fireEditorInput(el, inputType, data || null);
      return true;
    } catch {
      return false;
    }
  };

  const deleteSelectionOrBackward = (el) => {
    const sel = selectionIn(el);
    if (!sel || !sel.rangeCount) return false;
    try {
      let range = sel.getRangeAt(0);
      if (range.collapsed) {
        // Extend one character backward (Chromium Selection#modify).
        if (typeof sel.modify === "function") {
          sel.modify("extend", "backward", "character");
          if (!sel.rangeCount || sel.isCollapsed) return false;
          range = sel.getRangeAt(0);
        } else if (range.startOffset > 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
          range.setStart(range.startContainer, range.startOffset - 1);
        } else {
          return false;
        }
      }
      range.deleteContents();
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      fireEditorInput(el, "deleteContentBackward", null);
      return true;
    } catch {
      return false;
    }
  };

  const clearContentEditable = (el) => {
    if (!selectAllIn(el)) return false;
    const sel = window.getSelection?.();
    if (!sel?.rangeCount) return false;
    try {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      fireEditorInput(el, "deleteByCut", null);
      return true;
    } catch {
      return false;
    }
  };

  const insertCharFallback = (el, ch, isCE) => {
    if (isCE) {
      if (insertPlainAtCaret(el, ch, "insertText")) return;
      // Last resort: append without replacing the whole node each time when possible
      el.textContent = (el.textContent || "") + ch;
      fireEditorInput(el, "insertText", ch);
      return;
    }
    setNativeValue(el, (el.value || "") + ch);
    fireEditorInput(el, "insertText", ch);
  };

  /** Bulk insert as a paste (not per-key). Selection/Range + insertFromPaste InputEvent. */
  const insertPasteFallback = (el, chunk, isCE) => {
    const data = String(chunk || "");
    if (!data) return;
    if (isCE) {
      if (insertPlainAtCaret(el, data, "insertFromPaste")) return;
      el.textContent = (el.textContent || "") + data;
      fireEditorInput(el, "insertFromPaste", data);
      return;
    }
    setNativeValue(el, (el.value || "") + data);
    fireEditorInput(el, "insertFromPaste", data);
  };

  /**
   * Long prompts: human-type a short prefix, paste the rest immediately.
   * Short prompts: type everything (threshold below).
   *
   * CRITICAL: typePart must never contain \\n/\\r — Gemini treats bare Enter as
   * submit, which truncated live prompts to headings like "## Context".
   */
  const PASTE_THRESHOLD = 48;
  const TYPE_PREFIX_MIN = 20;
  const TYPE_PREFIX_MAX = 48;

  const splitTypeAndPaste = (text) => {
    const s = String(text ?? "");
    const firstNl = s.search(/[\r\n]/);
    // Any multiline text: type only the first line fragment, paste from the newline.
    // (Even below PASTE_THRESHOLD — otherwise per-key Enter submits mid-prompt.)
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
        // Tiny first line ("## Context"): still type it, paste from newline.
        cut = firstNl;
      }
      return { typePart: s.slice(0, cut), pastePart: s.slice(cut) };
    }
    if (s.length <= PASTE_THRESHOLD) return { typePart: s, pastePart: "" };
    const target = Math.floor(rand(TYPE_PREFIX_MIN, TYPE_PREFIX_MAX + 1));
    let cut = Math.min(target, s.length);
    const window = s.slice(0, Math.min(s.length, target + 24));
    const space = window.search(/[ \t]\S*$/);
    if (space >= TYPE_PREFIX_MIN) cut = space + 1;
    return { typePart: s.slice(0, cut), pastePart: s.slice(cut) };
  };

  const deleteCharFallback = (el, isCE) => {
    if (isCE) {
      if (deleteSelectionOrBackward(el)) return;
      el.textContent = (el.textContent || "").slice(0, -1);
      fireEditorInput(el, "deleteContentBackward", null);
      return;
    }
    setNativeValue(el, (el.value || "").slice(0, -1));
    fireEditorInput(el, "deleteContentBackward", null);
  };

  const fireKeyPairFallback = async (el, ch) => {
    const meta = keyMeta(ch);
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: meta.key,
        code: meta.code,
        keyCode: meta.keyCode,
        which: meta.keyCode,
        bubbles: true,
        cancelable: true,
        shiftKey: !!meta.shiftKey,
      })
    );
    await sleep(gaussianDelay(55, 15, 35, 110));
    el.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: meta.key,
        code: meta.code,
        keyCode: meta.keyCode,
        which: meta.keyCode,
        bubbles: true,
        cancelable: true,
        shiftKey: !!meta.shiftKey,
      })
    );
  };

  const typeCharsSynthetic = async (el, chars, isCE) => {
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      // Never key Enter for newlines during compose — that submits Gemini.
      if (ch === "\n" || ch === "\r") {
        insertPasteFallback(el, "\n", isCE);
        await sleep(gaussianDelay(75, 25, 40, 140));
        continue;
      }
      if (i > 0 && i % Math.floor(rand(8, 14)) === 0) {
        await sleep(gaussianDelay(280, 80, 150, 550));
      }
      if (".?!".includes(ch)) {
        await sleep(gaussianDelay(180, 50, 100, 350));
      }

      // Rare real typo: wrong char then Backspace then correct.
      if (i > 12 && Math.random() < 0.025) {
        const wrong = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        await fireKeyPairFallback(el, wrong);
        insertCharFallback(el, wrong, isCE);
        await sleep(gaussianDelay(90, 30, 40, 160));
        await fireKeyPairFallback(el, "Backspace");
        deleteCharFallback(el, isCE);
        await sleep(gaussianDelay(70, 20, 40, 120));
      }

      await fireKeyPairFallback(el, ch);
      insertCharFallback(el, ch, isCE);
      await sleep(gaussianDelay(75, 25, 40, 140));
    }
  };

  const composerText = (el) => {
    if (!el) return "";
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
    }
    return String(el.value || "");
  };

  const normalizePrompt = (s) =>
    String(s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();

  /** True when composer holds the intended prompt (length + head/tail needles). */
  const composerHasPrompt = (el, text) => {
    const want = normalizePrompt(text);
    const have = normalizePrompt(composerText(el));
    if (!want) return true;
    if (!have) return false;
    if (have === want) return true;
    // Allow minor CE whitespace drift; require near-full length + anchors.
    if (have.length < Math.floor(want.length * 0.92)) return false;
    const head = want.slice(0, Math.min(32, want.length));
    const tail = want.slice(-Math.min(32, want.length));
    return have.includes(head) && (want.length < 40 || have.includes(tail));
  };

  const clearComposer = (el, isCE) => {
    if (!isCE && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      setNativeValue(el, "");
      fireEditorInput(el, "deleteByCut", null);
      return;
    }
    // Avoid textContent wipe (breaks Angular CE binding).
    if (clearContentEditable(el)) return;
    if (normalizePrompt(composerText(el))) {
      selectAllIn(el);
      insertPlainAtCaret(el, "", "insertText");
    }
  };

  const humanType = async (el, text) => {
    if (!el) throw new Error("humanType: missing element");
    await humanClick(el);
    await sleep(gaussianDelay(180, 50, 100, 350));
    el.focus();

    const isCE = el.isContentEditable || el.getAttribute("contenteditable") === "true";
    const full = String(text ?? "");
    if (/[\r\n]/.test(splitTypeAndPaste(full).typePart)) {
      throw new Error("humanType: typePart must not contain newlines");
    }

    clearComposer(el, isCE);

    const fillOnce = async ({ allowTrusted }) => {
      const { typePart, pastePart } = splitTypeAndPaste(full);
      const typeChars = Array.from(typePart);
      const typeDelays = typeChars.map((_, i) => {
        let d = gaussianDelay(75, 25, 40, 140);
        if (i > 0 && i % Math.floor(rand(8, 14)) === 0) d += gaussianDelay(280, 80, 150, 550);
        if (".?!,".includes(typeChars[i])) d += gaussianDelay(160, 50, 80, 320);
        return Math.round(d);
      });

      if (allowTrusted) {
        // Multiline: one CDP insertText of the full prompt (Enter would submit).
        if (pastePart) {
          const pasted = await callTrusted(TrustedAction.PASTE, { text: full });
          if (pasted && composerHasPrompt(el, full)) return;
          if (pasted) {
            // CDP reported ok but composer empty/partial — fall through to retry paths.
            clearComposer(el, isCE);
          }
        } else if (typePart) {
          const typed = await callTrusted(TrustedAction.TYPE, {
            text: typePart,
            delays: typeDelays,
          });
          if (typed && composerHasPrompt(el, full)) return;
          if (typed) clearComposer(el, isCE);
        }
      }

      if (typePart) await typeCharsSynthetic(el, typeChars, isCE);
      if (pastePart) {
        await sleep(gaussianDelay(180, 50, 90, 320));
        try {
          el.focus();
        } catch {
          /* ignore */
        }
        // Prefer CDP paste of the remainder (or full if type failed).
        const pasted = await callTrusted(TrustedAction.PASTE, {
          text: composerHasPrompt(el, typePart) ? pastePart : full,
        });
        if (!pasted) insertPasteFallback(el, pastePart, isCE);
      }
    };

    await fillOnce({ allowTrusted: true });
    if (composerHasPrompt(el, full)) return;

    // Retry: clear + synthetic-only paste/type path.
    clearComposer(el, isCE);
    await sleep(gaussianDelay(120, 40, 60, 220));
    try {
      el.focus();
    } catch {
      /* ignore */
    }
    await fillOnce({ allowTrusted: false });
    // Final bulk insert if still short (last resort for stubborn CE).
    if (!composerHasPrompt(el, full)) {
      clearComposer(el, isCE);
      insertPasteFallback(el, full, isCE);
    }
    if (!composerHasPrompt(el, full)) {
      const have = normalizePrompt(composerText(el));
      throw new Error(
        `composer missing full prompt after type/paste (have ${have.length} chars, want ${full.length})`
      );
    }
  };

  const humanKey = async (el, key) => {
    if (el) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    const trusted = await callTrusted(TrustedAction.KEY, keyMeta(key));
    if (trusted) return;
    if (el) await fireKeyPairFallback(el, key === "Enter" ? "\n" : key);
  };

  const wanderPointer = async () => {
    const cur = cursor();
    const x = Math.max(20, Math.min(window.innerWidth - 20, cur.x + rand(-120, 120)));
    const y = Math.max(20, Math.min(window.innerHeight - 20, cur.y + rand(-80, 80)));
    const path = bezierPoints(cur.x, cur.y, x, y, Math.floor(rand(8, 16)));
    const trusted = await callTrusted(TrustedAction.MOVE, {
      path: path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    });
    cur.x = x;
    cur.y = y;
    if (trusted) return;
    let prev = { x: cur.x, y: cur.y };
    for (const p of path) {
      const target = document.elementFromPoint(p.x, p.y) || document.body;
      dispatchPointer(target, "pointermove", p.x, p.y, 0, prev);
      prev = p;
      await sleep(gaussianDelay(14, 5, 8, 30));
    }
  };

  global.KBHuman = {
    sleep,
    rand,
    gaussianDelay,
    betweenActions,
    humanScroll,
    scrollIntoViewHuman,
    humanClick,
    humanType,
    humanKey,
    wanderPointer,
    composerText,
    composerHasPrompt,
  };
})(globalThis);
