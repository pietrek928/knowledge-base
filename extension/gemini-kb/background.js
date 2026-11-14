/**
 * Background: ingest POSTs, chrome.storage tracking, weekly sweep,
 * remote-command poll loop against the knowledge-base server.
 */

importScripts("constants.js");

const {
  CommandKind,
  CAPABILITIES,
  TrustedAction,
  EventType,
  CommandStatus,
  MsgType,
  gaussMs,
} = globalThis.KB;

const DEFAULTS = {
  kbUrl: "http://127.0.0.1:8080",
  autoSave: true,
  lastSweepAt: null,
  chats: {},
  browserId: null,
  account: null,
  captchaBlockedUntil: 0,
  captchaStrikes: 0,
  captchaNeedsUser: false,
  lastQueryAt: 0,
  nextQueryAfter: 0,
  lastReplyChars: 0,
  // Off by default: debugger banner resizes the viewport and is an anti-bot tell.
  trustedInput: false,
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ALARM_NAME = "gemini_kb_weekly";
const HEARTBEAT_ALARM = "gemini_kb_heartbeat";

let pollRunning = false;
let commandBusy = false;
let lastBusyHeartbeatAt = 0;
let backoffUntil = 0;
let lastRegisterOk = null;

const log = (...args) => {
  console.log("[gemini-kb]", ...args);
};

const logWarn = (...args) => {
  console.warn("[gemini-kb]", ...args);
};

const getState = async () => {
  const data = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...data, chats: data.chats || {} };
};

const setState = async (patch) => {
  await chrome.storage.local.set(patch);
};

const isoNow = () => {
  return new Date().toISOString();
};

const uuid = () => {
  return crypto.randomUUID();
};

const ensureBrowserId = async () => {
  const state = await getState();
  if (state.browserId) return state.browserId;
  const browserId = uuid();
  await setState({ browserId });
  return browserId;
};

const kbFetch = async (path, options = {}) => {
  const { kbUrl } = await getState();
  const base = String(kbUrl || DEFAULTS.kbUrl).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
};

const healthOk = async () => {
  try {
    const res = await kbFetch("/health");
    return res.ok;
  } catch {
    return false;
  }
};

const gaussian = (mean, sigma, min, max) => gaussMs(mean, sigma, min, max);

const sleep = (ms) => {
  return new Promise((r) => setTimeout(r, ms));
};

/** Sleep a Gaussian duration (never a flat constant). */
const sleepGauss = (mean, sigma, min, max) => sleep(gaussian(mean, sigma, min, max));

/** @type {Set<number>} */
const debuggerSessions = new Set();

const debuggerAttach = async (tabId) => {
  if (debuggerSessions.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerSessions.add(tabId);
    return true;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/already attached/i.test(msg)) {
      debuggerSessions.add(tabId);
      return true;
    }
    logWarn("debugger attach failed", msg);
    return false;
  }
};

const debuggerDetach = async (tabId) => {
  if (!debuggerSessions.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* ignore */
  }
  debuggerSessions.delete(tabId);
};

const dbg = async (tabId, method, params) => {
  return chrome.debugger.sendCommand({ tabId }, method, params);
};

const trustedMovePath = async (tabId, path) => {
  for (const p of path || []) {
    await dbg(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: p.x,
      y: p.y,
      button: "none",
    });
    await sleep(gaussian(12, 4, 6, 28));
  }
};

const trustedClick = async (tabId, { path, x, y }) => {
  if (!(await debuggerAttach(tabId))) return false;
  if (path?.length) await trustedMovePath(tabId, path);
  await sleep(gaussian(50, 15, 30, 80));
  await dbg(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(gaussian(70, 20, 40, 120));
  await dbg(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  return true;
};

const trustedType = async (tabId, { text, delays }) => {
  if (!(await debuggerAttach(tabId))) return false;
  const chars = Array.from(String(text || ""));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const delay = (delays && delays[i]) || Math.round(gaussian(75, 25, 40, 140));
    if (ch === "\n" || ch === "\r") {
      // Bare Enter submits Gemini; insert a newline without sending.
      await dbg(tabId, "Input.insertText", { text: "\n" });
    } else {
      await dbg(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: ch,
        unmodifiedText: ch,
      });
      await sleep(gaussian(40, 12, 25, 80));
      await dbg(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        text: ch,
        unmodifiedText: ch,
      });
    }
    await sleep(delay);
  }
  return true;
};

/** Bulk insert (paste-like) via CDP — no per-key delays. */
const trustedPaste = async (tabId, { text }) => {
  if (!(await debuggerAttach(tabId))) return false;
  const chunk = String(text || "");
  if (!chunk) return true;
  await dbg(tabId, "Input.insertText", { text: chunk });
  return true;
};

const trustedKey = async (tabId, meta) => {
  if (!(await debuggerAttach(tabId))) return false;
  const key = meta.key || "Enter";
  const code = meta.code || key;
  const keyCode = meta.keyCode || (key === "Enter" ? 13 : key === "Escape" ? 27 : 0);
  await dbg(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text: meta.text || (key === "Enter" ? "\r" : undefined),
  });
  await sleep(gaussian(50, 15, 30, 90));
  await dbg(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  return true;
};

const trustedWheel = async (tabId, { deltaY, x, y, steps }) => {
  if (!(await debuggerAttach(tabId))) return false;
  const n = Math.max(1, steps || 6);
  const step = (deltaY || 0) / n;
  for (let i = 0; i < n; i++) {
    await dbg(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: x || 400,
      y: y || 400,
      deltaX: 0,
      deltaY: step + gaussian(0, 2, -4, 4),
    });
    await sleep(gaussian(40, 12, 16, 80));
  }
  return true;
};

const handleTrustedInput = async (tabId, msg) => {
  if (!tabId) return { ok: false, error: "no tab" };
  if (msg.action === TrustedAction.DETACH) {
    await debuggerDetach(tabId);
    return { ok: true };
  }
  const state = await getState();
  // TYPE/PASTE always use CDP: document.execCommand is deprecated and Range+synthetic
  // InputEvent does not stick in Gemini's Angular contenteditable. The popup
  // "trustedInput" flag still gates click/move/wheel (debugger banner for those).
  const alwaysCdp =
    msg.action === TrustedAction.TYPE || msg.action === TrustedAction.PASTE;
  if (!state.trustedInput && !alwaysCdp) {
    return { ok: false, skipped: true, reason: "trustedInput disabled" };
  }
  try {
    switch (msg.action) {
      case TrustedAction.CLICK:
        return { ok: await trustedClick(tabId, msg) };
      case TrustedAction.MOVE:
        if (!(await debuggerAttach(tabId))) return { ok: false };
        await trustedMovePath(tabId, msg.path || []);
        return { ok: true };
      case TrustedAction.TYPE:
        return { ok: await trustedType(tabId, msg) };
      case TrustedAction.PASTE:
        return { ok: await trustedPaste(tabId, msg) };
      case TrustedAction.KEY:
        return { ok: await trustedKey(tabId, msg) };
      case TrustedAction.WHEEL:
        return { ok: await trustedWheel(tabId, msg) };
      default:
        return { ok: false, error: `unknown action ${msg.action}` };
    }
  } catch (err) {
    logWarn("trusted input failed", String(err?.message ?? err));
    return { ok: false, error: String(err?.message ?? err) };
  }
};

const readingGapMs = (replyChars, promptChars = 0) => {
  // ~220 wpm reading + think pause; floor tens of seconds.
  const words = Math.max(1, Math.round((replyChars || 0) / 5));
  const readMs = (words / 220) * 60_000;
  const think = gaussian(12_000, 4_000, 6_000, 25_000);
  const promptBonus = Math.min(20_000, (promptChars || 0) * 15);
  return Math.max(25_000, Math.min(180_000, readMs + think + promptBonus));
};

const scheduleCaptchaBackoff = async (reason = "captcha") => {
  const state = await getState();
  const strikes = (state.captchaStrikes || 0) + 1;
  // 30m, 60m, 120m… capped at 24h
  const minutes = Math.min(24 * 60, 30 * Math.pow(2, Math.min(strikes - 1, 6)));
  const baseMs = minutes * 60_000;
  const until = Date.now() + gaussian(baseMs, baseMs * 0.12, baseMs * 0.75, baseMs * 1.25);
  await setState({
    captchaBlockedUntil: until,
    captchaStrikes: strikes,
    captchaNeedsUser: true,
  });
  backoffUntil = until;
  logWarn(
    reason,
    `backoff ~${Math.round((until - Date.now()) / 60_000)}m strike=${strikes}; needs user gesture to clear`
  );
  return until;
};

const reconcileDocs = async () => {
  try {
    const res = await kbFetch("/docs?prefix=gemini/");
    if (!res.ok) return;
    const body = await res.json();
    const state = await getState();
    const chats = { ...state.chats };
    for (const doc of body.docs || []) {
      const meta = doc.metadata || {};
      const cid = meta.conversation_id;
      if (!cid) continue;
      const prev = chats[cid] || {};
      chats[cid] = {
        ...prev,
        id: cid,
        path: doc.path,
        title: meta.title || prev.title || cid,
        appUrl: prev.appUrl || `https://gemini.google.com/app/${cid}`,
        contentFingerprint: meta.content_fingerprint || prev.contentFingerprint || null,
        messageCount: meta.message_count ?? prev.messageCount ?? null,
        tracked: true,
        ingestLast: meta.ingest || prev.ingestLast || "unknown",
        lastPushedAt: prev.lastPushedAt || meta.updated_at || null,
        pendingFullSync: prev.pendingFullSync || false,
      };
    }
    await setState({ chats });
  } catch {
    /* soft fail */
  }
};

const ingestTurns = async ({ conversationId, title, turns, complete, error }) => {
  const state = await getState();
  const chats = { ...state.chats };
  const prev = chats[conversationId] || {};
  const base = {
    id: conversationId,
    title: title || prev.title || conversationId,
    appUrl: prev.appUrl || `https://gemini.google.com/app/${conversationId}`,
    tracked: true,
    lastCheckedAt: isoNow(),
    pendingFullSync: prev.pendingFullSync || false,
    lastPushedAt: prev.lastPushedAt ?? null,
    contentFingerprint: prev.contentFingerprint ?? null,
    messageCount: prev.messageCount ?? null,
    ingestLast: prev.ingestLast || "unknown",
  };

  if (error || !complete) {
    chats[conversationId] = { ...base, pendingFullSync: true };
    await setState({ chats });
    return { ok: false, pending: true, error: error || "incomplete extract" };
  }

  if (!(await healthOk())) {
    chats[conversationId] = { ...base, pendingFullSync: true };
    await setState({ chats });
    return { ok: false, pending: true, error: "KB unreachable" };
  };

  const res = await kbFetch("/ingest/gemini", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId,
      title,
      ingest: "extension",
      turns,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    chats[conversationId] = { ...base, pendingFullSync: true };
    await setState({ chats });
    return { ok: false, pending: true, error: text || `HTTP ${res.status}` };
  }
  const body = await res.json();
  chats[conversationId] = {
    ...base,
    path: body.path,
    contentFingerprint: body.content_fingerprint,
    messageCount: body.message_count,
    pendingFullSync: false,
    ingestLast: "extension",
    lastPushedAt: body.skipped ? base.lastPushedAt || isoNow() : isoNow(),
  };
  await setState({ chats });
  return { ok: true, skipped: !!body.skipped, body };
};

const isEligible = (chat, now = Date.now()) => {
  if (!chat || !chat.tracked) return false;
  if (!chat.lastPushedAt) return true;
  if (chat.pendingFullSync) return true;
  const t = Date.parse(chat.lastPushedAt);
  if (Number.isNaN(t)) return true;
  return now - t > WEEK_MS;
};

const ensureAlarm = async () => {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 * 24 });
  }
  const hb = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!hb) {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  }
};

const weeklySweep = async () => {
  // Slow, foreground-only sync — never machine-gun hidden tabs with hNvQHb.
  if (Date.now() < backoffUntil || Date.now() < (await getState()).captchaBlockedUntil) {
    logWarn("weeklySweep skipped (backoff/captcha)");
    return;
  }
  await reconcileDocs();
  const state = await getState();
  const now = Date.now();
  const eligible = Object.values(state.chats || {}).filter((c) => isEligible(c, now));
  for (const chat of eligible.slice(0, 3)) {
    try {
      const opened = await findOrCreateTab(chat.id, { forNew: false });
      const tab = opened.tab;
      await activateTab(tab);
      await sleep(gaussian(4000, 800, 2500, 6000));
      try {
        await waitTabReady(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: MsgType.PUSH_NOW });
        await sleep(gaussian(20_000, 4_000, 12_000, 35_000));
      } catch {
        /* tab may not be ready / logged out */
      }
      // Leave the tab open — closing after scrape is a strong bot tell.
    } catch {
      /* soft fail */
    }
    await sleep(gaussian(15_000, 4_000, 8_000, 30_000));
  }
  await setState({ lastSweepAt: isoNow() });
};

const openConversationIds = async () => {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/app/*" });
  const ids = [];
  for (const t of tabs) {
    const m = String(t.url || "").match(/\/app\/([a-f0-9]+)/i);
    if (m) ids.push(m[1].toLowerCase());
  }
  return ids;
};

const registerOrHeartbeat = async () => {
  const browserId = await ensureBrowserId();
  const state = await getState();
  const { kbUrl } = state;
  const conversation_ids = await openConversationIds();
  const body = {
    browser_id: browserId,
    account: state.account || null,
    conversation_ids,
    capabilities: [...CAPABILITIES],
  };
  try {
    const res = await kbFetch("/ext/register", { method: "POST", body: JSON.stringify(body) });
    if (res.status === 429) {
      const wait = gaussian(60_000, 12_000, 35_000, 95_000);
      backoffUntil = Date.now() + wait;
      logWarn("register rate-limited (429); backing off", Math.round(wait / 1000), "s");
      lastRegisterOk = false;
      return false;
    }
    if (!res.ok) {
      logWarn("register failed", res.status, await res.text().catch(() => ""));
      lastRegisterOk = false;
      return false;
    }
    if (lastRegisterOk !== true) {
      log(
        "connected to KB",
        kbUrl || DEFAULTS.kbUrl,
        "browser_id=",
        browserId.slice(0, 8),
        "account=",
        state.account || "-"
      );
    }
    lastRegisterOk = true;
    return true;
  } catch (err) {
    if (lastRegisterOk !== false) {
      logWarn("KB unreachable", kbUrl || DEFAULTS.kbUrl, String(err?.message ?? err));
    }
    lastRegisterOk = false;
    return false;
  }
};

const postEvent = async (commandId, type, payload) => {
  try {
    await kbFetch("/ext/events", {
      method: "POST",
      body: JSON.stringify({ command_id: commandId, type, payload: payload || {} }),
    });
  } catch {
    /* soft */
  }
};

const activateTab = async (tab) => {
  // Gemini UI / contenteditable often stalls in background tabs; bring to front.
  if (!tab?.id) return tab;
  try {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    const updated = await chrome.tabs.update(tab.id, { active: true });
    return updated || tab;
  } catch (err) {
    logWarn("activateTab failed", String(err?.message ?? err));
    return tab;
  }
};

const findOrCreateTab = async (conversationId, { forNew } = {}) => {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (conversationId) {
    const want = conversationId.toLowerCase();
    for (const t of tabs) {
      if (String(t.url || "").toLowerCase().includes(`/app/${want}`)) {
        return { tab: await activateTab(t), created: false };
      }
    }
    const tab = await chrome.tabs.create({
      url: `https://gemini.google.com/app/${want}`,
      active: true,
    });
    return { tab: await activateTab(tab), created: true };
  }
  if (forNew) {
    const tab = await chrome.tabs.create({
      url: "https://gemini.google.com/app",
      active: true,
    });
    return { tab: await activateTab(tab), created: true };
  }
  // reuse any gemini app tab
  for (const t of tabs) {
    if (/gemini\.google\.com\/app/i.test(t.url || "")) {
      return { tab: await activateTab(t), created: false };
    }
  }
  const tab = await chrome.tabs.create({
    url: "https://gemini.google.com/app",
    active: true,
  });
  return { tab: await activateTab(tab), created: true };
};

const injectContentScripts = async (tabId) => {
  // Needed after extension reload: existing Gemini tabs keep the old page without CS.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["constants.js", "human.js", "gemini_models.js", "content.js"],
  });
};

const refreshPickerHelpers = async (tabId) => {
  // Re-assign KBGeminiModels from disk without duplicating content.js listeners.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["constants.js", "human.js", "gemini_models.js"],
  });
};

const waitTabReady = async (tabId, timeoutMs = 25000) => {
  const wantBuild = chrome.runtime.getManifest().version;
  const start = Date.now();
  let injected = false;
  let reloaded = false;
  let buildReloaded = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: MsgType.PING });
      if (ping && ping.ok) {
        // Unpacked updates leave old content scripts until navigation/reload.
        if (ping.build && ping.build !== wantBuild && !buildReloaded) {
          log("content build mismatch", ping.build, "→", wantBuild, "reloading tab", tabId);
          buildReloaded = true;
          reloaded = true;
          await chrome.tabs.reload(tabId);
          await sleepGauss(2200, 500, 1400, 3600);
          continue;
        }
        return ping;
      }
    } catch {
      /* not ready / no receiver */
    }
    if (!injected && Date.now() - start > gaussian(1200, 250, 800, 1800)) {
      try {
        await injectContentScripts(tabId);
        injected = true;
        log("injected content scripts into tab", tabId);
        await sleepGauss(550, 120, 300, 900);
        continue;
      } catch (err) {
        logWarn("script inject failed", String(err?.message ?? err));
        injected = true; // don't spam
      }
    }
    // After extension reload, a hard refresh re-runs content_scripts matches.
    if (!reloaded && Date.now() - start > gaussian(6000, 900, 4500, 8500)) {
      try {
        log("reloading tab to attach content scripts", tabId);
        await chrome.tabs.reload(tabId);
        reloaded = true;
        await sleepGauss(2200, 500, 1400, 3600);
        continue;
      } catch (err) {
        logWarn("tab reload failed", String(err?.message ?? err));
        reloaded = true;
      }
    }
    await sleepGauss(420, 90, 220, 750);
  }
  throw new Error("content script not ready");
};

const runRemoteCommand = async (cmd) => {
  const kind = cmd.kind;
  const params = cmd.params || {};
  const commandId = cmd.id;

  const state0 = await getState();
  if (state0.captchaNeedsUser || Date.now() < backoffUntil || Date.now() < state0.captchaBlockedUntil) {
    await postEvent(commandId, EventType.ERROR, {
      error: state0.captchaNeedsUser
        ? "captcha backoff active — open the extension popup after solving /sorry"
        : "captcha/backoff active",
      captcha: true,
    });
    return;
  }

  // Pace after query writes: reading-time dwell, not a few seconds.
  const state = await getState();
  if (kind === CommandKind.QUERY) {
    const until = Math.max(state.nextQueryAfter || 0, state.lastQueryAt || 0);
    const wait = until - Date.now();
    if (wait > 0) {
      log("pacing before query", Math.round(wait / 1000), "s");
      await sleepGauss(wait, wait * 0.08, wait * 0.85, wait * 1.15);
    }
  } else {
    await sleepGauss(800, 250, 400, 1600);
  }

  let created = false;
  let tab = null;
  try {
    await postEvent(commandId, EventType.RUNNING, { kind });
    const forNew = kind === CommandKind.QUERY && !params.conversation_id;
    const opened = await findOrCreateTab(params.conversation_id || null, { forNew });
    tab = opened.tab;
    created = opened.created;
    // chrome.tabs.create can return before url is set; wait for a real gemini /app URL.
    const isGeminiApp = (u) => /gemini\.google\.com\/app/i.test(u || "");
    if (!isGeminiApp(tab.url)) {
      for (let i = 0; i < 15; i++) {
        await sleepGauss(380, 90, 180, 700);
        try {
          tab = await chrome.tabs.get(tab.id);
        } catch {
          break;
        }
        if (isGeminiApp(tab.url)) break;
      }
    }
    await postEvent(commandId, EventType.TAB_OPENED, { tabId: tab.id, created, url: tab.url });
    // Settle after navigation before first gesture.
    await sleepGauss(
      created ? 3500 : 1200,
      created ? 600 : 300,
      created ? 2500 : 700,
      created ? 5500 : 2200
    );
    let ping = await waitTabReady(tab.id);
    if (ping.account) await setState({ account: ping.account });

    // Ensure we landed on the requested conversation (SPA can leave us on /app).
    const wantCid = (params.conversation_id || "").toLowerCase() || null;
    if (wantCid && ping.conversation_id !== wantCid) {
      await chrome.tabs.update(tab.id, { url: `https://gemini.google.com/app/${wantCid}` });
      await sleepGauss(2600, 500, 1600, 4200);
      ping = await waitTabReady(tab.id);
      if (ping.conversation_id && ping.conversation_id !== wantCid) {
        throw new Error(
          `tab on wrong conversation: have=${ping.conversation_id} want=${wantCid}`
        );
      }
    }

    // Unpacked updates: refresh picker helpers from disk (no listener duplication).
    try {
      await refreshPickerHelpers(tab.id);
    } catch (err) {
      logWarn("refreshPickerHelpers failed", String(err?.message ?? err));
    }

    // Idle timeout extends only on real progress; hardDeadline is the safety net.
    const timeoutMs = Math.max(15, Math.min(600, Number(cmd.timeout_s) || Number(params.timeout_s) || 180)) * 1000;
    const hardMs = Math.min(600_000, Math.max(timeoutMs * 3, timeoutMs + 120_000));
    const startedAt = Date.now();
    let idleDeadline = startedAt + timeoutMs;
    const hardDeadline = startedAt + hardMs;
    let lastResponseLen = -1;
    let settled = null;
    let settleErr = null;
    let aborted = false;
    let lastStatusPollAt = 0;

    const bumpIdle = () => {
      idleDeadline = Math.min(hardDeadline, Date.now() + timeoutMs);
    };

    const signalContentCancel = async (reason) => {
      aborted = true;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: MsgType.REMOTE_CANCEL,
          commandId,
          reason: reason || "cancelled",
        });
      } catch {
        /* content may already be gone */
      }
    };

    const fetchCommandStatus = async () => {
      try {
        const res = await kbFetch(`/ext/commands/${encodeURIComponent(commandId)}`);
        if (!res.ok) return null;
        const body = await res.json();
        return body?.status || null;
      } catch {
        return null;
      }
    };

    const onMsg = (msg) => {
      if (!msg || msg.type !== MsgType.REMOTE_EVENT || msg.commandId !== commandId) return;
      if (aborted) return;
      postEvent(commandId, msg.eventType, msg.payload);
      const p = msg.payload || {};
      switch (msg.eventType) {
        case EventType.SUBMITTED:
        case EventType.TURN:
        case EventType.MODEL_SELECTED:
          bumpIdle();
          break;
        case EventType.DELTA:
          // Composing/generating/len change only — not empty poll ticks.
          if (p.generating || p.composing) bumpIdle();
          if (typeof p.response_len === "number" && p.response_len !== lastResponseLen) {
            lastResponseLen = p.response_len;
            bumpIdle();
          }
          break;
        default:
          // list-models scrape progress (model_selected phases already handled).
          if (kind === CommandKind.LIST_MODELS) bumpIdle();
          break;
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    // Broker pops timeout_s from params; re-attach so content shares the same budget.
    const contentParams = { ...params, timeout_s: Math.round(timeoutMs / 1000) };
    let response;
    try {
      const sendP = chrome.tabs
        .sendMessage(tab.id, {
          type: MsgType.REMOTE,
          commandId,
          kind,
          params: contentParams,
        })
        .then((r) => {
          settled = r;
          return r;
        })
        .catch((err) => {
          settleErr = err;
          throw err;
        });

      while (!settled && !settleErr) {
        const now = Date.now();
        if (now >= hardDeadline || now >= idleDeadline) {
          const secs = Math.round((now - startedAt) / 1000);
          const hard = now >= hardDeadline;
          await signalContentCancel(hard ? "timeout_hard" : "timeout_idle");
          throw Object.assign(
            new Error(
              `content command timed out after ${secs}s` +
                (hard ? " (hard cap)" : " (idle — no Gemini progress)")
            ),
            { timeout: true }
          );
        }
        // Poll broker so CLI cancel/timeout aborts in-flight content work.
        if (now - lastStatusPollAt > 900) {
          lastStatusPollAt = now;
          const st = await fetchCommandStatus();
          if (st === CommandStatus.CANCELLED || st === CommandStatus.TIMEOUT) {
            await signalContentCancel(st);
            throw Object.assign(new Error(`command ${st}`), {
              cancelled: st === CommandStatus.CANCELLED,
              timeout: st === CommandStatus.TIMEOUT,
            });
          }
        }
        // Do NOT bumpIdle on empty poll ticks — idle and broker timeout must be able to fire.
        await Promise.race([sendP.catch(() => null), sleepGauss(420, 90, 220, 750)]);
      }
      if (settleErr) throw settleErr;
      if (aborted) {
        throw Object.assign(new Error("command cancelled"), { cancelled: true });
      }
      response = settled;
    } finally {
      chrome.runtime.onMessage.removeListener(onMsg);
    }

    if (!response || !response.ok) {
      if (response && response.captcha) {
        await scheduleCaptchaBackoff("captcha from content");
        await postEvent(commandId, EventType.ERROR, {
          error: response.error || "captcha",
          captcha: true,
        });
        return;
      }
      if (response && response.cancelled) {
        await postEvent(commandId, EventType.CANCELLED, {
          error: response.error || "command cancelled",
          cancelled: true,
        });
        return;
      }
      await postEvent(commandId, EventType.ERROR, {
        error: (response && response.error) || "command failed",
      });
      return;
    }

    const result = response.result || {};

    const turnsLookReal = (turns, complete) => {
      if (!Array.isArray(turns) || !turns.length) return false;
      if (complete === false) return false;
      return turns.some(
        (t) =>
          (t.role === "gemini" || t.role === "model") && String(t.text || "").trim()
      );
    };

    // Live ingest for query / search-with-messages — empty/stale must not look like success.
    if (kind === CommandKind.QUERY) {
      if (!turnsLookReal(result.turns, result.complete)) {
        await postEvent(commandId, EventType.ERROR, {
          error: "stale or empty extract; refusing success",
          conversation_id: result.conversation_id || null,
          turn_count: Array.isArray(result.turns) ? result.turns.length : 0,
          complete: result.complete,
        });
        return;
      }
      if (result.conversation_id && result.turns) {
        await ingestTurns({
          conversationId: result.conversation_id,
          title: result.title,
          turns: result.turns,
          complete: result.complete !== false,
        });
        const replyChars = (result.turns || [])
          .filter((t) => t.role === "gemini" || t.role === "model")
          .reduce((n, t) => n + String(t.text || "").length, 0);
        const promptChars = String(params.text || "").length;
        const gap = readingGapMs(replyChars, promptChars);
        await setState({
          lastQueryAt: Date.now(),
          lastReplyChars: replyChars,
          nextQueryAfter: Date.now() + gap,
          captchaStrikes: 0,
        });
        log("next query after reading dwell", Math.round(gap / 1000), "s");
      }
    }
    if (
      kind === CommandKind.SEARCH &&
      params.conversation_id &&
      Array.isArray(result.turns) &&
      result.turns.length &&
      result.complete !== false
    ) {
      await ingestTurns({
        conversationId: params.conversation_id,
        title: result.title || params.conversation_id,
        turns: result.turns,
        complete: result.complete !== false,
      });
    }

    if (aborted) {
      await postEvent(commandId, EventType.CANCELLED, { error: "command cancelled" });
      return;
    }
    await postEvent(commandId, EventType.DONE, result);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/sorry|captcha/i.test(msg)) {
      await scheduleCaptchaBackoff("captcha exception");
    }
    if (err?.cancelled) {
      await postEvent(commandId, EventType.CANCELLED, { error: msg, cancelled: true });
    } else if (err?.timeout) {
      await postEvent(commandId, EventType.TIMEOUT, { error: msg });
    } else {
      await postEvent(commandId, EventType.ERROR, { error: msg });
    }
  } finally {
    // Keep chat tabs open (closing after send is a bot tell). Detach debugger.
    if (tab && tab.id) {
      try {
        await debuggerDetach(tab.id);
      } catch {
        /* ignore */
      }
    }
  }
};

const pollLoop = async () => {
  if (pollRunning) return;
  pollRunning = true;
  log("poll loop started");
  try {
    while (true) {
      if (commandBusy) {
        // Poll is skipped while busy; refresh last_seen so broker TTL (60s) does not
        // drop browsers[] during long query/pacing (heartbeat alarm alone can miss).
        if (Date.now() - lastBusyHeartbeatAt > gaussian(15_000, 3_000, 10_000, 22_000)) {
          lastBusyHeartbeatAt = Date.now();
          try {
            await registerOrHeartbeat();
          } catch {
            /* soft */
          }
        }
        await sleepGauss(520, 120, 280, 900);
        continue;
      }
      if (Date.now() < backoffUntil) {
        await sleepGauss(2100, 450, 1200, 3500);
        continue;
      }
      const browserId = await ensureBrowserId();
      let res;
      try {
        const waitS = Math.max(8, Math.min(25, Math.round(gaussian(18, 4, 10, 24))));
        res = await kbFetch(
          `/ext/poll?browser_id=${encodeURIComponent(browserId)}&wait_s=${waitS}`
        );
      } catch (err) {
        logWarn("poll failed", String(err?.message ?? err));
        await sleepGauss(3200, 700, 1600, 5500);
        continue;
      }
      if (res.status === 204) {
        continue;
      }
      if (res.status === 429) {
        const wait = gaussian(60_000, 12_000, 35_000, 95_000);
        backoffUntil = Date.now() + wait;
        logWarn("poll rate-limited (429); backing off", Math.round(wait / 1000), "s");
        continue;
      }
      if (!res.ok) {
        logWarn("poll HTTP", res.status);
        await sleepGauss(2100, 450, 1200, 3500);
        continue;
      }
      const cmd = await res.json();
      if (!cmd || !cmd.id) continue;
      log("claimed command", cmd.kind, cmd.id?.slice?.(0, 8) || cmd.id);
      commandBusy = true;
      lastBusyHeartbeatAt = Date.now();
      try {
        await runRemoteCommand(cmd);
      } finally {
        commandBusy = false;
        // serialize: jitter after each command
        await sleepGauss(600, 150, 300, 1200);
      }
    }
  } finally {
    pollRunning = false;
    logWarn("poll loop stopped; restarting");
    // restart later
    setTimeout(() => pollLoop(), gaussian(2200, 500, 1200, 4000));
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await setState(state);
  await ensureBrowserId();
  await ensureAlarm();
  await reconcileDocs();
  await registerOrHeartbeat();
  pollLoop();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await ensureBrowserId();
  await registerOrHeartbeat();
  pollLoop();
  const state = await getState();
  const last = state.lastSweepAt ? Date.parse(state.lastSweepAt) : 0;
  if (!last || Date.now() - last > WEEK_MS) {
    weeklySweep();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) weeklySweep();
  if (alarm.name === HEARTBEAT_ALARM) registerOrHeartbeat();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MsgType.TRUSTED_INPUT: {
        const tabId = sender.tab?.id;
        sendResponse(await handleTrustedInput(tabId, msg));
        return;
      }

      case MsgType.CLEAR_CAPTCHA_GATE:
        // User opened the popup / acknowledged — allow queries again after /sorry.
        await setState({
          captchaNeedsUser: false,
          captchaBlockedUntil: 0,
          captchaStrikes: 0,
        });
        backoffUntil = 0;
        sendResponse({ ok: true });
        return;

      case MsgType.EXTRACT_RESULT: {
        const state = await getState();
        if (!state.autoSave && !msg.force) {
          sendResponse({ ignored: true });
          return;
        }
        sendResponse(await ingestTurns(msg));
        return;
      }

      case MsgType.REMOTE_EVENT:
        // handled via temporary listener during command; also accept orphaned
        sendResponse({ ok: true });
        return;

      case MsgType.GET_STATE:
        await reconcileDocs();
        sendResponse(await getState());
        return;

      case MsgType.SET_SETTINGS: {
        const patch = {};
        if (typeof msg.kbUrl === "string") patch.kbUrl = msg.kbUrl;
        if (typeof msg.autoSave === "boolean") patch.autoSave = msg.autoSave;
        if (typeof msg.trustedInput === "boolean") patch.trustedInput = msg.trustedInput;
        await setState(patch);
        // Turning trusted input off: drop debugger sessions unless a command is mid-flight
        // (TYPE/PASTE still need CDP; detaching mid-command breaks compose).
        if (patch.trustedInput === false && !commandBusy) {
          for (const tabId of [...debuggerSessions]) {
            await debuggerDetach(tabId);
          }
        }
        sendResponse(await getState());
        return;
      }

      case MsgType.PUSH_ACTIVE_TAB: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url?.includes("gemini.google.com/app")) {
          sendResponse({ ok: false, error: "Open a gemini.google.com/app tab" });
          return;
        }
        try {
          await chrome.tabs.sendMessage(tab.id, { type: MsgType.PUSH_NOW });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      case MsgType.RUN_SWEEP:
        weeklySweep();
        sendResponse({ ok: true });
        return;

      default:
        return;
    }
  })();
  return true;
});

ensureAlarm();
ensureBrowserId().then(async (browserId) => {
  log("service worker awake browser_id=", browserId.slice(0, 8));
  await registerOrHeartbeat();
  pollLoop();
});
