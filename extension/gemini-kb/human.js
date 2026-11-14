/**
 * Human-like interaction helpers.
 * Prefers chrome.debugger trusted input (isTrusted: true) via the background;
 * falls back to improved synthetic DOM events if debugger is unavailable.
 */
((global) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rand = (min, max) => min + Math.random() * (max - min);

  const gaussianDelay = (mean, sigma, min, max) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
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
        type: "kb_trusted_input",
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
    const trusted = await callTrusted("wheel", {
      deltaY,
      x: cursor().x,
      y: cursor().y,
      steps: Math.max(3, Math.min(12, Math.round(Math.abs(deltaY) / 80))),
    });
    if (trusted) return;

    const steps = Math.max(3, Math.min(12, Math.round(Math.abs(deltaY) / 80)));
    const step = deltaY / steps;
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, step + rand(-4, 4));
      await sleep(gaussianDelay(40, 12, 16, 80));
    }
  };

  const scrollIntoViewHuman = async (el) => {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const target = window.innerHeight * 0.45;
    const delta = mid - target;
    if (Math.abs(delta) > 40) await humanScroll(delta);
  };

  const humanClick = async (el) => {
    if (!el) throw new Error("humanClick: missing element");
    await scrollIntoViewHuman(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * rand(0.25, 0.75);
    const y = rect.top + rect.height * rand(0.25, 0.75);
    const cur = cursor();
    const path = bezierPoints(cur.x, cur.y, x, y, Math.floor(rand(14, 28)));

    const trusted = await callTrusted("click", {
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

  const insertCharFallback = (el, ch, isCE) => {
    if (isCE) {
      try {
        document.execCommand("insertText", false, ch);
        return;
      } catch {
        /* fall through */
      }
      // Last resort: append without replacing the whole node each time when possible
      el.textContent = (el.textContent || "") + ch;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      return;
    }
    setNativeValue(el, (el.value || "") + ch);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  };

  const deleteCharFallback = (el, isCE) => {
    if (isCE) {
      try {
        document.execCommand("delete", false);
        return;
      } catch {
        /* fall through */
      }
      el.textContent = (el.textContent || "").slice(0, -1);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null })
      );
      return;
    }
    setNativeValue(el, (el.value || "").slice(0, -1));
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null })
    );
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

  const humanType = async (el, text) => {
    if (!el) throw new Error("humanType: missing element");
    await humanClick(el);
    await sleep(gaussianDelay(180, 50, 100, 350));
    el.focus();

    const isCE = el.isContentEditable || el.getAttribute("contenteditable") === "true";

    // Clear existing content once
    if (!isCE && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      setNativeValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (isCE) {
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      } catch {
        el.textContent = "";
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
        );
      }
    }

    const chars = Array.from(String(text));
    const trusted = await callTrusted("type", {
      text: String(text),
      // Precomputed inter-key delays so background can stay dumb.
      delays: chars.map((_, i) => {
        let d = gaussianDelay(75, 25, 40, 140);
        if (i > 0 && i % Math.floor(rand(8, 14)) === 0) d += gaussianDelay(280, 80, 150, 550);
        if (".?!,".includes(chars[i])) d += gaussianDelay(160, 50, 80, 320);
        return Math.round(d);
      }),
    });
    if (trusted) return;

    // Synthetic fallback with better event shape than wholesale textContent replace.
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
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

  const humanKey = async (el, key) => {
    if (el) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    const trusted = await callTrusted("key", keyMeta(key));
    if (trusted) return;
    if (el) await fireKeyPairFallback(el, key === "Enter" ? "\n" : key);
  };

  const wanderPointer = async () => {
    const cur = cursor();
    const x = Math.max(20, Math.min(window.innerWidth - 20, cur.x + rand(-120, 120)));
    const y = Math.max(20, Math.min(window.innerHeight - 20, cur.y + rand(-80, 80)));
    const path = bezierPoints(cur.x, cur.y, x, y, Math.floor(rand(8, 16)));
    const trusted = await callTrusted("move", {
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
    humanClick,
    humanType,
    humanKey,
    wanderPointer,
  };
})(globalThis);
