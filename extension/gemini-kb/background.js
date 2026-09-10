/**
 * Background: ingest POSTs, chrome.storage tracking, weekly 7-day sweep.
 */

const DEFAULTS = {
  kbUrl: "http://127.0.0.1:8080",
  autoSave: true,
  lastSweepAt: null,
  chats: {},
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ALARM_NAME = "gemini_kb_weekly";

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...data, chats: data.chats || {} };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function isoNow() {
  return new Date().toISOString();
}

async function kbFetch(path, options = {}) {
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
}

async function healthOk() {
  try {
    const res = await kbFetch("/health");
    return res.ok;
  } catch {
    return false;
  }
}

async function reconcileDocs() {
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
}

async function ingestTurns({ conversationId, title, turns, complete, error }) {
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
  }

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
}

function isEligible(chat, now = Date.now()) {
  if (!chat || !chat.tracked) return false;
  if (!chat.lastPushedAt) return true;
  if (chat.pendingFullSync) return true;
  const t = Date.parse(chat.lastPushedAt);
  if (Number.isNaN(t)) return true;
  return now - t > WEEK_MS;
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 * 24 });
  }
}

async function weeklySweep() {
  await reconcileDocs();
  const state = await getState();
  const now = Date.now();
  if (state.lastSweepAt) {
    const last = Date.parse(state.lastSweepAt);
    // Still run eligibility check even if last sweep recent — catch pending
  }
  const eligible = Object.values(state.chats || {}).filter((c) => isEligible(c, now));
  for (const chat of eligible.slice(0, 20)) {
    try {
      const tab = await chrome.tabs.create({
        url: chat.appUrl || `https://gemini.google.com/app/${chat.id}`,
        active: false,
      });
      // Wait for content script to load, then request push
      await new Promise((r) => setTimeout(r, 5000));
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "gemini_push_now" });
        await new Promise((r) => setTimeout(r, 15000));
      } catch {
        /* tab may not be ready / logged out */
      }
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* already closed */
      }
    } catch {
      /* soft fail */
    }
  }
  await setState({ lastSweepAt: isoNow() });
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await setState(state);
  await ensureAlarm();
  await reconcileDocs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const state = await getState();
  const last = state.lastSweepAt ? Date.parse(state.lastSweepAt) : 0;
  if (!last || Date.now() - last > WEEK_MS) {
    weeklySweep();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) weeklySweep();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    if (msg.type === "gemini_extract_result") {
      const state = await getState();
      if (!state.autoSave && !msg.force) {
        sendResponse({ ignored: true });
        return;
      }
      // Browse auto-save from content script
      const result = await ingestTurns(msg);
      sendResponse(result);
      return;
    }

    if (msg.type === "get_state") {
      await reconcileDocs();
      sendResponse(await getState());
      return;
    }

    if (msg.type === "set_settings") {
      const patch = {};
      if (typeof msg.kbUrl === "string") patch.kbUrl = msg.kbUrl;
      if (typeof msg.autoSave === "boolean") patch.autoSave = msg.autoSave;
      await setState(patch);
      sendResponse(await getState());
      return;
    }

    if (msg.type === "push_active_tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.includes("gemini.google.com/app/")) {
        sendResponse({ ok: false, error: "Open a gemini.google.com/app/<id> tab" });
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "gemini_push_now" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    if (msg.type === "run_sweep") {
      weeklySweep();
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});

ensureAlarm();
