/**
 * Human-like interaction helpers.
 * Prefers chrome.debugger trusted input (isTrusted: true) via the background;
 * falls back to improved synthetic DOM events if debugger is unavailable.
 */
import { TrustedAction, MsgType, gaussMs } from "../shared/constants.js";
import {
  normalizePrompt,
  composeCompareNormalize,
  promptTextsMatch,
  splitTypeAndPaste as splitTypeAndPastePure,
} from "./compose_verify.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rand = (min, max) => min + Math.random() * (max - min);

  const gaussianDelay = (mean, sigma, min, max) => gaussMs(mean, sigma, min, max);

  const betweenActions = async () => {
    await sleep(gaussianDelay(450, 120, 200, 800));
  };

  // Persist cursor across actions (avoid teleporting ±80px each click).
  const cursor = () => {
    if (!globalThis.__KB_CURSOR__) {
      globalThis.__KB_CURSOR__ = {
        x: window.innerWidth * 0.5,
        y: window.innerHeight * 0.5,
      };
    }
    return globalThis.__KB_CURSOR__;
  };

  const callTrusted = async (action, payload = {}) => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: MsgType.TRUSTED_INPUT,
        action,
        ...payload,
      });
      if (res?.aborted) {
        throw Object.assign(new Error("command cancelled"), {
          cancelled: true,
          aborted: true,
        });
      }
      return res || { ok: false };
    } catch (err) {
      if (err?.aborted || err?.cancelled) throw err;
      return { ok: false, error: String(err?.message ?? err) };
    }
  };

  /** Bring the Gemini tab/window to the front (generation often stalls in background). */
  const focusTab = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: MsgType.FOCUS_TAB });
      if (res?.ok === false) return res;
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    // Wait until the document is visible (activateTab is async across processes).
    const t0 = Date.now();
    while (document.visibilityState !== "visible" && Date.now() - t0 < 2500) {
      await sleep(gaussianDelay(120, 35, 60, 220));
    }
    await sleep(gaussianDelay(180, 50, 80, 320));
    return { ok: true, visible: document.visibilityState === "visible" };
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
    if (ch === "Escape" || ch === "Esc") {
      return { key: "Escape", code: "Escape", keyCode: 27, text: "" };
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
    if (trusted?.ok) return;

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

  /** Prefer a scrollable ancestor of fromEl over document.scrollingElement. */
  const resolveScrollRoot = (fromEl) => {
    // Start at parent so a nested <pre>/<code> overflow box is never the chat root.
    let node =
      fromEl && fromEl.nodeType === 1 ? fromEl.parentElement : null;
    const minH = window.innerHeight * 0.4;
    while (node && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 8 && node.clientHeight >= minH) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.body;
  };

  /** Wheel over root’s content area; last-resort scrollTop if wheel is a no-op. */
  const humanScrollInRoot = async (root, deltaY) => {
    if (!root) {
      await humanScroll(deltaY);
      return;
    }
    const rect = root.getBoundingClientRect();
    const cur = cursor();
    const x = Math.max(
      8,
      Math.min(window.innerWidth - 8, rect.left + rect.width * 0.5)
    );
    const y = Math.max(
      8,
      Math.min(window.innerHeight - 8, rect.top + rect.height * 0.5)
    );
    cur.x = x;
    cur.y = y;
    const before = root.scrollTop;
    await humanScroll(deltaY);
    if (Math.abs(root.scrollTop - before) < 2 && Math.abs(deltaY) > 40) {
      root.scrollTop = before + deltaY;
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

  const humanClick = async (el, opts = {}) => {
    if (!el) throw new Error("humanClick: missing element");
    const forceCdp = !!opts.forceCdp;
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
      ...(forceCdp ? { forceCdp: true } : {}),
    });
    cur.x = x;
    cur.y = y;
    if (trusted?.ok) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
      return;
    }
    // Submit Send fallback must be CDP-trusted; never synthesize.
    if (forceCdp) {
      throw new Error(
        `forceCdp click failed: ${trusted?.reason || trusted?.error || "not ok"}`
      );
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

  const splitTypeAndPaste = (text) =>
    splitTypeAndPastePure(text, () => Math.random());

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

  const composerText = (el) => {
    if (!el) return "";
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
    }
    return String(el.value || "");
  };

  /** True when composer holds the intended prompt (Quill-aware squash compare). */
  const composerHasPrompt = (el, text) =>
    promptTextsMatch(composerText(el), text);

  const clearComposerSync = (el, isCE) => {
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

  /** Clear Quill/CE; if text remains after a tick, one CDP select-all + Backspace. */
  const clearComposer = async (el, isCE) => {
    clearComposerSync(el, isCE);
    await sleep(gaussianDelay(90, 25, 40, 180));
    if (!normalizePrompt(composerText(el))) return;
    try {
      el.focus();
    } catch {
      /* ignore */
    }
    selectAllIn(el);
    const wiped = await callTrusted(TrustedAction.KEY, keyMeta("Backspace"));
    if (wiped?.ok) {
      await sleep(gaussianDelay(80, 20, 40, 160));
      return;
    }
    // Last resort without Enter: empty insert after select-all.
    selectAllIn(el);
    insertPlainAtCaret(el, "", "insertText");
  };

  const waitComposerHasPrompt = async (el, full) => {
    let lastLen = normalizePrompt(composerText(el)).length;
    let grewExtra = false;
    for (let i = 0; i < 4; i++) {
      if (composerHasPrompt(el, full)) return true;
      await sleep(gaussianDelay(220, 60, 100, 420));
      const len = normalizePrompt(composerText(el)).length;
      if (len > lastLen) {
        lastLen = len;
        if (!grewExtra) {
          grewExtra = true;
          // One extra sample while Quill is still painting.
          await sleep(gaussianDelay(280, 70, 120, 500));
          if (composerHasPrompt(el, full)) return true;
          lastLen = normalizePrompt(composerText(el)).length;
        }
      }
    }
    return composerHasPrompt(el, full);
  };

  const humanType = async (el, text) => {
    if (!el) throw new Error("humanType: missing element");
    await humanClick(el);
    await sleep(gaussianDelay(180, 50, 100, 350));
    el.focus();

    const isCE = el.isContentEditable || el.getAttribute("contenteditable") === "true";
    const full = String(text ?? "");
    const { typePart, pastePart } = splitTypeAndPaste(full);
    if (/[\r\n]/.test(typePart)) {
      throw new Error("humanType: typePart must not contain newlines");
    }

    await clearComposer(el, isCE);

    const typeChars = Array.from(typePart);
    const typeDelays = typeChars.map((_, i) => {
      let d = gaussianDelay(75, 25, 40, 140);
      if (i > 0 && i % Math.floor(rand(8, 14)) === 0) d += gaussianDelay(280, 80, 150, 550);
      if (".?!,".includes(typeChars[i])) d += gaussianDelay(160, 50, 80, 320);
      return Math.round(d);
    });

    const missingPromptError = (why, primary) => {
      const haveRaw = composerText(el);
      const have = composeCompareNormalize(haveRaw);
      const want = composeCompareNormalize(full);
      const okBit =
        primary == null
          ? ""
          : ` primary.ok=${primary.ok === true} cdpTimeout=${!!primary.cdpTimeout}`;
      return Object.assign(
        new Error(
          `composer missing full prompt after ${why} ` +
            `(have ${have.length} chars, want ${want.length} squashed, raw ${full.length})${okBit}`
        ),
        { composeFailed: true, cdpTimeout: !!primary?.cdpTimeout }
      );
    };

    // Always slow-type the prefix first; paste only the remainder (never skip TYPE).
    let typed = { ok: true };
    let pasted = { ok: true };
    if (typePart) {
      typed = await callTrusted(TrustedAction.TYPE, {
        text: typePart,
        delays: typeDelays,
      });
    }
    if (pastePart) {
      pasted = await callTrusted(TrustedAction.PASTE, { text: pastePart });
    }
    const primary = {
      ok: !!(typed?.ok !== false && pasted?.ok !== false),
      skipped: !!(typed?.skipped || pasted?.skipped),
      cdpTimeout: !!(typed?.cdpTimeout || pasted?.cdpTimeout),
      typedOk: typed?.ok !== false,
      pastedOk: pasted?.ok !== false,
    };

    if (await waitComposerHasPrompt(el, full)) return;

    // CDP stall: clear then one full PASTE only — no re-type (avoid duplicate prefix).
    const cdpFailed = primary && !primary.ok && !primary.skipped;
    if (cdpFailed) {
      // Do not clear while Quill is still growing.
      const lenBefore = normalizePrompt(composerText(el)).length;
      await sleep(gaussianDelay(200, 50, 100, 380));
      const lenAfter = normalizePrompt(composerText(el)).length;
      if (lenAfter > lenBefore) {
        if (await waitComposerHasPrompt(el, full)) return;
      }
      await clearComposer(el, isCE);
      try {
        el.focus();
      } catch {
        /* ignore */
      }
      const recovery = await callTrusted(TrustedAction.PASTE, { text: full });
      if (await waitComposerHasPrompt(el, full)) return;
      throw Object.assign(
        missingPromptError("CDP stall", {
          ok: false,
          cdpTimeout: !!(primary.cdpTimeout || recovery?.cdpTimeout),
        }),
        { cdpTimeout: !!(primary.cdpTimeout || recovery?.cdpTimeout) }
      );
    }

    // Unexpected miss after ok CDP — one paste recovery, then fail.
    await clearComposer(el, isCE);
    try {
      el.focus();
    } catch {
      /* ignore */
    }
    await callTrusted(TrustedAction.PASTE, { text: full });
    if (await waitComposerHasPrompt(el, full)) return;
    throw missingPromptError("type/paste", primary);
  };

  const humanKey = async (el, key, opts = {}) => {
    if (el) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    const requireCdp = !!opts.requireCdp;
    const trusted = await callTrusted(TrustedAction.KEY, keyMeta(key));
    if (trusted?.ok) return;
    if (requireCdp) {
      throw new Error(
        `CDP key failed: ${trusted?.reason || trusted?.error || "not ok"}`
      );
    }
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
    if (trusted?.ok) return;
    let prev = { x: cur.x, y: cur.y };
    for (const p of path) {
      const target = document.elementFromPoint(p.x, p.y) || document.body;
      dispatchPointer(target, "pointermove", p.x, p.y, 0, prev);
      prev = p;
      await sleep(gaussianDelay(14, 5, 8, 30));
    }
  };

export {
  sleep,
  rand,
  gaussianDelay,
  betweenActions,
  humanScroll,
  resolveScrollRoot,
  humanScrollInRoot,
  scrollIntoViewHuman,
  humanClick,
  humanType,
  humanKey,
  focusTab,
  wanderPointer,
  composerText,
  composerHasPrompt,
};
