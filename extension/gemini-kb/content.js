/**
 * Gemini page content script: extract full thread via hNvQHb → structured turns.
 * No markdown formatting — server owns format/fingerprint.
 */

const PAGE_SIZE = 10;
const DEBOUNCE_MS = 2000;
const COOLDOWN_MS = 30000;

let debounceTimer = null;
let lastAttemptAt = 0;
let extracting = false;

function conversationIdFromUrl(href = location.href) {
  const m = String(href).match(/\/app\/([a-f0-9]+)(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function findAtToken() {
  const html = document.documentElement.innerHTML;
  const patterns = [
    /"SNlM0e"\s*:\s*"([^"]+)"/,
    /\bat=([^&\s"']+)/,
    /"at"\s*:\s*"([^"]+)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].includes(":")) return m[1];
  }
  // WIZ data blobs sometimes use unicode escapes
  const m2 = html.match(/SNlM0e\\u003d([^\\"]+)/);
  if (m2) {
    try {
      return decodeURIComponent(m2[1].replace(/\\u003d/g, "="));
    } catch {
      return m2[1];
    }
  }
  return null;
}

function stripWidgets(text) {
  if (!text) return "";
  let s = String(text);
  s = s.replace(/<FinanceWidget[\s\S]*?<\/FinanceWidget>/gi, "");
  s = s.replace(/<GenerateWidget[\s\S]*?<\/GenerateWidget>/gi, "");
  s = s.replace(/<ElicitationsGroup[\s\S]*?<\/ElicitationsGroup>/gi, "");
  s = s.replace(/<FollowUps?[\s\S]*?\/>/gi, "");
  s = s.replace(/<FollowUps?[\s\S]*?<\/FollowUps?>/gi, "");
  // Drop mega HTML documents embedded in answers
  if (s.includes("<!DOCTYPE html") || s.includes("<html")) {
    const md = s.match(/```[\s\S]*?```/);
    if (md && md[0].length < 50000) return md[0];
    s = s.replace(/<!DOCTYPE html[\s\S]*$/i, "").replace(/<html[\s\S]*$/i, "");
  }
  return s.trim();
}

function preferFinalAnswer(text) {
  const cleaned = stripWidgets(text);
  // Drop leading English "thinking" sections when a later substantial block exists
  const parts = cleaned.split(/\n{2,}/);
  if (parts.length > 3 && /^(\*\*)?(Defining|Initiating|Reviewing|Processing)/i.test(parts[0])) {
    const later = parts.slice(Math.floor(parts.length / 2)).join("\n\n").trim();
    if (later.length > 80) return later;
  }
  return cleaned;
}

function walkCollectTurns(node, out, seen) {
  if (!Array.isArray(node)) return;
  // Turn shape: [[c,r], [c,r,rc], [[user],…], [[model…]], …, [sec,nanos]]
  if (
    node.length >= 4 &&
    Array.isArray(node[0]) &&
    typeof node[0][0] === "string" &&
    node[0][0].startsWith("c_") &&
    Array.isArray(node[2]) &&
    Array.isArray(node[2][0]) &&
    typeof node[2][0][0] === "string"
  ) {
    const idKey = JSON.stringify(node[0]);
    if (!seen.has(idKey)) {
      seen.add(idKey);
      const userText = preferFinalAnswer(node[2][0][0] || "");
      let modelText = "";
      const modelSlot = node[3];
      if (Array.isArray(modelSlot) && Array.isArray(modelSlot[0])) {
        const rcBlock = modelSlot[0][0];
        if (Array.isArray(rcBlock) && Array.isArray(rcBlock[1]) && typeof rcBlock[1][0] === "string") {
          modelText = preferFinalAnswer(rcBlock[1][0]);
        } else if (Array.isArray(rcBlock) && typeof rcBlock[1] === "string") {
          modelText = preferFinalAnswer(rcBlock[1]);
        }
      }
      let tsSec = null;
      let tsNanos = 0;
      for (let i = node.length - 1; i >= 0; i--) {
        const t = node[i];
        if (Array.isArray(t) && t.length >= 1 && typeof t[0] === "number" && t[0] > 1e9) {
          tsSec = t[0];
          tsNanos = typeof t[1] === "number" ? t[1] : 0;
          break;
        }
      }
      const replyId = Array.isArray(node[1]) ? node[1][1] || node[0][1] : node[0][1];
      if (userText) {
        out.push({
          role: "user",
          text: userText,
          ts_sec: tsSec,
          ts_nanos: tsNanos,
          _id: replyId || idKey,
        });
      }
      if (modelText) {
        out.push({
          role: "gemini",
          text: modelText,
          ts_sec: tsSec != null ? tsSec + 1 : null,
          ts_nanos: 0,
          _id: (replyId || idKey) + ":m",
        });
      }
    }
  }
  for (const child of node) {
    if (Array.isArray(child)) walkCollectTurns(child, out, seen);
  }
}

function extractContinuationToken(parsedInner) {
  // Walk for long base64-ish strings near the end of the payload
  const tokens = [];
  function walk(n, depth) {
    if (depth > 12) return;
    if (typeof n === "string") {
      if (
        (n.length > 80 && /[A-Za-z0-9+/=]{40,}/.test(n) && n.includes("==")) ||
        n.length > 120
      ) {
        if (/^[A-Za-z0-9+/=\-_]+$/.test(n.replace(/\\u003d/g, "="))) {
          tokens.push(n.replace(/\\u003d/g, "="));
        }
      }
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c, depth + 1);
    }
  }
  walk(parsedInner, 0);
  return tokens.length ? tokens[tokens.length - 1] : null;
}

function parseBatchexecute(text) {
  let body = text;
  if (body.startsWith(")]}'")) {
    body = body.replace(/^\)\]\}'\s*/, "");
  }
  const turns = [];
  const seen = new Set();
  let nextCursor = null;
  // Length-delimited chunks: optional <len>\n<json>
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) {
      // next line(s) are payload — join until parse works or next length
      let jsonStr = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\d+$/.test(lines[j].trim()) && jsonStr) break;
        jsonStr += (jsonStr ? "\n" : "") + lines[j];
        try {
          const chunk = JSON.parse(jsonStr);
          handleChunk(chunk);
          i = j;
          break;
        } catch {
          /* keep appending */
        }
      }
      continue;
    }
    try {
      handleChunk(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }

  function handleChunk(chunk) {
    if (!Array.isArray(chunk)) return;
    for (const row of chunk) {
      if (!Array.isArray(row)) continue;
      if (row[0] === "wrb.fr" && row[1] === "hNvQHb") {
        let inner = row[2];
        if (typeof inner === "string") {
          try {
            inner = JSON.parse(inner);
          } catch {
            return;
          }
        }
        walkCollectTurns(inner, turns, seen);
        const tok = extractContinuationToken(inner);
        if (tok) nextCursor = tok;
      }
    }
  }

  // Oldest→newest for ingest
  turns.reverse();
  return { turns, nextCursor };
}

async function fetchPage(conversationId, cursor, at) {
  const cId = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
  const args = [cId, PAGE_SIZE, cursor, 1, [1], [4], null, 1];
  const inner = JSON.stringify(args);
  const freq = JSON.stringify([[["hNvQHb", inner, null, "generic"]]]);
  const params = new URLSearchParams({
    rpcids: "hNvQHb",
    "source-path": `/app/${conversationId.replace(/^c_/, "")}`,
    rt: "c",
  });
  const body = new URLSearchParams({ "f.req": freq, at });
  const res = await fetch(
    `https://gemini.google.com/_/BardChatUi/data/batchexecute?${params}`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`batchexecute HTTP ${res.status}`);
  return parseBatchexecute(await res.text());
}

async function extractFullThread(conversationId) {
  const at = findAtToken();
  if (!at) throw new Error("CSRF at token not found on page");
  const all = [];
  const seenIds = new Set();
  let cursor = null;
  let prevCursor = null;
  for (let page = 0; page < 50; page++) {
    const { turns, nextCursor } = await fetchPage(conversationId, cursor, at);
    let newCount = 0;
    for (const t of turns) {
      const id = t._id || `${t.role}:${t.text.slice(0, 40)}:${t.ts_sec}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const { _id, ...clean } = t;
      all.push(clean);
      newCount++;
    }
    if (!nextCursor || nextCursor === prevCursor || newCount === 0) {
      return { turns: all, complete: true };
    }
    prevCursor = cursor;
    cursor = nextCursor;
  }
  return { turns: all, complete: false };
}

function pageTitle() {
  const t = (document.title || "").replace(/\s*[—|-]\s*Gemini.*$/i, "").trim();
  return t || "Gemini conversation";
}

async function runExtractAndSend({ force = false } = {}) {
  const id = conversationIdFromUrl();
  if (!id) return;
  if (extracting) return;
  const now = Date.now();
  if (!force && now - lastAttemptAt < COOLDOWN_MS) return;
  lastAttemptAt = now;
  extracting = true;
  try {
    const { turns, complete } = await extractFullThread(id);
    chrome.runtime.sendMessage({
      type: "gemini_extract_result",
      conversationId: id,
      title: pageTitle(),
      appUrl: `https://gemini.google.com/app/${id}`,
      turns,
      complete,
      force,
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "gemini_extract_result",
      conversationId: id,
      title: pageTitle(),
      appUrl: `https://gemini.google.com/app/${id}`,
      turns: [],
      complete: false,
      force,
      error: String(err && err.message ? err.message : err),
    });
  } finally {
    extracting = false;
  }
}

function scheduleExtract() {
  if (!conversationIdFromUrl()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runExtractAndSend({ force: false }), DEBOUNCE_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "gemini_push_now") {
    runExtractAndSend({ force: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// SPA navigation hooks
const _push = history.pushState;
history.pushState = function (...args) {
  const r = _push.apply(this, args);
  scheduleExtract();
  return r;
};
const _replace = history.replaceState;
history.replaceState = function (...args) {
  const r = _replace.apply(this, args);
  scheduleExtract();
  return r;
};
window.addEventListener("popstate", scheduleExtract);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleExtract();
});

scheduleExtract();
