/**
 * Gemini page content script: extract full thread via hNvQHb → structured turns.
 * No markdown formatting — server owns format/fingerprint.
 */

// Bumped with manifest; background reloads the tab when this mismatches.
const EXT_BUILD = "0.3.4";

const PAGE_SIZE = 10;
const DEBOUNCE_MS = 4000;
const COOLDOWN_MS = 60_000;
const MAX_RPC_PAGES = 8;

let debounceTimer = null;
let lastAttemptAt = 0;
let extracting = false;
let batchexecuteReqId = 100000 + Math.floor(Math.random() * 9000);
let lastScheduledCid = null;

const conversationIdFromUrl = (href = location.href) => {
  const m = String(href).match(/\/app\/([a-f0-9]+)(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
};

const findAtToken = () => {
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
};

const findRuntimeParams = () => {
  const html = document.documentElement.innerHTML;
  const at = findAtToken();
  const sid =
    html.match(/"FdrFJe"\s*:\s*"(-?\d+)"/)?.[1] ||
    html.match(/FdrFJe\\u003d(-?\d+)/)?.[1] ||
    null;
  const bl =
    html.match(/"cfb2h"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/cfb2h\\u003d([^\\"]+)/)?.[1] ||
    null;
  const hl = (document.documentElement.lang || "en").slice(0, 2) || "en";
  return { at, sid, bl, hl };
};

const stripWidgets = (text) => {
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
};

const preferFinalAnswer = (text) => {
  const cleaned = stripWidgets(text);
  // Drop leading English "thinking" sections when a later substantial block exists
  const parts = cleaned.split(/\n{2,}/);
  if (parts.length > 3 && /^(\*\*)?(Defining|Initiating|Reviewing|Processing)/i.test(parts[0])) {
    const later = parts.slice(Math.floor(parts.length / 2)).join("\n\n").trim();
    if (later.length > 80) return later;
  }
  return cleaned;
};

const tsvToMarkdown = (text) => {
  const lines = text.split(/\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  if (lines.length < 2) return null;
  if (!lines.every((l) => l.includes("\t"))) return null;
  const rows = lines.map((l) => l.split("\t").map((c) => c.trim()));
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  const norm = rows.map((r) => {
    const x = r.slice();
    while (x.length < width) x.push("");
    return x;
  });
  const head = norm[0];
  const sep = head.map(() => "---");
  return [head, sep, ...norm.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n");
};

const looksLikeCodeBody = (s) =>
  /^(const|let|var|function|def|class|import|from|export|async|public|package)\b/m.test(s) ||
  /=>|{\s*$/m.test(s);

/** Strip Gemini UI chrome and normalize code/tables/images for LLMs. */
const cleanDomTurnText = (role, raw) => {
  let s = preferFinalAnswer(raw);
  if (!s) return "";

  // Leading role labels (EN + common variants).
  s = s.replace(/^(You said|You asked|Twój prompt|Twoje pytanie)\s*/i, "");
  s = s.replace(/^(Gemini said|Gemini replied|Model said|Odpowiedź Gemini)\s*/i, "");

  // Trailing action chrome often glued onto innerText.
  s = s.replace(
    /\n+(More options|Copy code|Copy|Regenerate|Show more|Show less|Export to Docs|Good response|Bad response|Listen|Edit|Share|Thumb up|Thumb down|Rate this response)\b[\s\S]*$/i,
    ""
  );
  s = s.replace(
    /\b(More options|Copy code|Copy prompt|Regenerate|Good response|Bad response)\b\s*$/gi,
    ""
  );

  // "truncated…\n\nfull prompt" or duplicated prompt → keep the fuller copy.
  const blocks = s
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) {
    const a = blocks[0];
    const b = blocks[1];
    const aStem = a.replace(/…|\.\.\./g, "").trim();
    if (a === b || b.startsWith(a) || a.startsWith(b) || (aStem && b.startsWith(aStem))) {
      s = a.length >= b.length ? a : b;
    } else if (role === "user" && blocks.length === 2 && a.length < 120 && b.includes(aStem || a)) {
      s = b;
    } else if (role === "gemini" || role === "model") {
      if (/^(gemini|model)\b/i.test(a) && b.length > a.length) s = blocks.slice(1).join("\n\n");
    }
  }

  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return "";

  // Image URL-only replies (common for generated images via RPC).
  if (
    (role === "gemini" || role === "model") &&
    /^https?:\/\/\S+$/i.test(s) &&
    /image|googleusercontent|ggpht|lh3\.google/i.test(s)
  ) {
    return `![generated image](${s})`;
  }

  // Tab-separated "tables" from DOM → markdown.
  if (role === "gemini" || role === "model") {
    const asTable = tsvToMarkdown(s);
    if (asTable) return asTable;
  }

  // Language header + code body without fences → fenced block.
  if ((role === "gemini" || role === "model") && !s.includes("```")) {
    const m = s.match(
      /^(JavaScript|TypeScript|Python|Java|Go|Rust|C\+\+|C|HTML|CSS|JSON|Bash|Shell|SQL)\s*\n([\s\S]+)$/i
    );
    if (m && looksLikeCodeBody(m[2])) {
      const lang = m[1].toLowerCase().replace("c++", "cpp").replace("shell", "bash");
      return `\`\`\`${lang}\n${m[2].replace(/\n+$/, "")}\n\`\`\``;
    }
    if (looksLikeCodeBody(s) && s.split("\n").length >= 1 && s.length < 4000) {
      return `\`\`\`\n${s}\n\`\`\``;
    }
  }

  return s;
};

const tableToMarkdown = (table) => {
  const rows = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")].map((c) => (c.innerText || "").replace(/\s+/g, " ").trim())
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const x = r.slice();
    while (x.length < width) x.push("");
    return x;
  });
  const head = norm[0];
  const sep = head.map(() => "---");
  const lines = [head, sep, ...norm.slice(1)].map((r) => `| ${r.join(" | ")} |`);
  return lines.join("\n");
};

const enrichStructuredContent = (root) => {
  // Build LLM-friendly text for code / tables / images that innerText alone mangles.
  const parts = [];
  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") {
      const md = tableToMarkdown(node);
      if (md) parts.push(md);
      return; // don't descend into cells again
    }
    if (tag === "pre") {
      const code = (node.innerText || "").replace(/\n+$/, "");
      if (code) {
        const lang =
          (node.querySelector("code")?.className || "").match(/language-([\w+-]+)/i)?.[1] ||
          (node.className || "").match(/language-([\w+-]+)/i)?.[1] ||
          "";
        parts.push(lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``);
      }
      return;
    }
    if (tag === "img") {
      const alt = (node.getAttribute("alt") || "image").replace(/\s+/g, " ").trim();
      const src = node.getAttribute("src") || node.getAttribute("data-src") || "";
      if (src && !/^data:image\/svg/i.test(src)) {
        parts.push(`![${alt}](${src})`);
      } else if (alt && !/^(image|img)$/i.test(alt)) {
        parts.push(`[image: ${alt}]`);
      } else {
        parts.push("[image]");
      }
      return;
    }
    // Generated-image containers without a usable <img> yet
    if (
      /image|generated|media/i.test(node.getAttribute("data-test-id") || "") ||
      /image|generated|media/i.test(node.className || "")
    ) {
      const img = node.querySelector("img");
      if (img) {
        walk(img);
        return;
      }
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  // Dedup while preserving order
  const seen = new Set();
  return parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
};

const textFromTurnEl = (el, role) => {
  // Prefer content nodes over the whole card (avoids "You said" / toolbar labels).
  const sels =
    role === "user"
      ? [".query-text", "message-content", ".user-query-bubble", ".prompt-text"]
      : [
          "model-response-content",
          ".model-response-text",
          ".response-content",
          "message-content",
          ".markdown",
          ".response-container",
        ];
  let root = el;
  for (const sel of sels) {
    const node = el.querySelector(sel);
    if (node) {
      root = node;
      break;
    }
  }
  const structured = enrichStructuredContent(root);
  const plain = cleanDomTurnText(role, (root.innerText || "").trim());

  if (role === "user") return plain;

  // Merge: if structured bits aren't already represented in plain text, append them.
  if (!structured.length) return plain;
  const missing = structured.filter((p) => {
    if (p.startsWith("![") || p === "[image]" || p.startsWith("[image:")) return true;
    if (p.startsWith("```")) {
      const body = p.replace(/^```[\w+-]*\n?/, "").replace(/\n?```$/, "");
      return body && !plain.includes(body.slice(0, Math.min(80, body.length)));
    }
    if (p.includes("| ---")) return !plain.includes("|") || plain.split("\n").length < 3;
    return !plain.includes(p.slice(0, Math.min(60, p.length)));
  });
  if (!missing.length) {
    // Prefer fenced/table form when plain already has the substance.
    if (structured.some((p) => p.startsWith("```")) && !plain.includes("```")) {
      return [plain, ...structured.filter((p) => p.startsWith("```"))].filter(Boolean).join("\n\n");
    }
    return plain;
  }
  return [plain, ...missing].filter(Boolean).join("\n\n").trim();
};

const walkCollectTurns = (node, out, seen) => {
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
          text: cleanDomTurnText("user", userText),
          ts_sec: tsSec,
          ts_nanos: tsNanos,
          _id: replyId || idKey,
        });
      }
      if (modelText) {
        out.push({
          role: "gemini",
          text: cleanDomTurnText("gemini", modelText),
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
};

const extractContinuationToken = (parsedInner) => {
  // Walk for long base64-ish strings near the end of the payload
  const tokens = [];
  const walk = (n, depth) => {
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
};

const parseBatchexecute = (text) => {
  let body = text;
  if (body.startsWith(")]}'")) {
    body = body.replace(/^\)\]\}'\s*/, "");
  }
  const turns = [];
  const seen = new Set();
  let nextCursor = null;

  // Must be declared before the parse loop (const is not hoisted).
  const handleChunk = (chunk) => {
    if (!Array.isArray(chunk)) return;
    for (const row of chunk) {
      if (!Array.isArray(row)) continue;
      if (row[0] === "wrb.fr" && row[1] === "hNvQHb") {
        let inner = row[2];
        if (typeof inner === "string") {
          try {
            inner = JSON.parse(inner);
          } catch {
            continue;
          }
        }
        walkCollectTurns(inner, turns, seen);
        const tok = extractContinuationToken(inner);
        if (tok) nextCursor = tok;
      }
    }
  };

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

  // API page is typically newest-first; reverse turn *pairs* so user/gemini order stays intact.
  const paired = [];
  for (let i = 0; i < turns.length; ) {
    const a = turns[i];
    const b = turns[i + 1];
    if (
      a &&
      a.role === "user" &&
      b &&
      (b.role === "gemini" || b.role === "model")
    ) {
      paired.push([a, b]);
      i += 2;
    } else {
      paired.push([a]);
      i += 1;
    }
  }
  paired.reverse();
  return { turns: paired.flat(), nextCursor };
};

const fetchPage = async (conversationId, cursor, runtime) => {
  const H = globalThis.KBHuman;
  const cId = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
  const args = [cId, PAGE_SIZE, cursor, 1, [1], [4], null, 1];
  const inner = JSON.stringify(args);
  // "generic" is what the real web client also uses in f.req; keep it but send real sid/bl/_reqid.
  const freq = JSON.stringify([[["hNvQHb", inner, null, "generic"]]]);
  const reqId = batchexecuteReqId;
  batchexecuteReqId += 100000;
  const params = new URLSearchParams({
    rpcids: "hNvQHb",
    "source-path": `/app/${conversationId.replace(/^c_/, "")}`,
    rt: "c",
    _reqid: String(reqId),
    hl: runtime.hl || "en",
  });
  if (runtime.sid) params.set("f.sid", runtime.sid);
  if (runtime.bl) params.set("bl", runtime.bl);
  const body = new URLSearchParams({ "f.req": freq });
  if (runtime.at) body.set("at", runtime.at);
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
  // Seconds between pages — never hammer the private RPC.
  if (H?.sleep) await H.sleep(H.gaussianDelay(2200, 500, 1200, 4000));
  return parseBatchexecute(await res.text());
};

const extractFullThread = async (conversationId) => {
  const runtime = findRuntimeParams();
  if (!runtime.at) throw new Error("CSRF at token not found on page");
  const all = [];
  const seenIds = new Set();
  let cursor = null;
  let prevCursor = null;
  for (let page = 0; page < MAX_RPC_PAGES; page++) {
    const { turns, nextCursor } = await fetchPage(conversationId, cursor, runtime);
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
};

const pageTitle = () => {
  const t = (document.title || "").replace(/\s*[—|-]\s*Gemini.*$/i, "").trim();
  return t || "Gemini conversation";
};

const runExtractAndSend = async ({ force = false } = {}) => {
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
      error: String(err?.message ?? err),
    });
  } finally {
    extracting = false;
  }
};

const scheduleExtract = () => {
  const id = conversationIdFromUrl();
  if (!id) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runExtractAndSend({ force: false }), DEBOUNCE_MS);
};

const detectAccount = () => {
  const sels = [
    'a[aria-label*="@" i]',
    'img[alt*="@" i]',
    '[data-email]',
    'a[href*="AccountChooser"]',
    'button[aria-label*="Google Account" i]',
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) continue;
    const raw =
      el.getAttribute("data-email") ||
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.textContent ||
      "";
    const m = String(raw).match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (m) return m[0];
    if (raw && raw.length < 80) return raw.trim();
  }
  return null;
};

const findComposer = () => {
  const sels = [
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="Enter" i]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
    "textarea",
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return null;
};

const findSendButton = () => {
  const sels = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[data-test-id*="send" i]',
  ];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && !el.disabled) return el;
  }
  // mat-icon send near composer
  for (const b of document.querySelectorAll("button")) {
    const t = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase();
    if (/send|submit/.test(t) && !b.disabled) return b;
  }
  return null;
};

const isGenerating = () => {
  const stop = document.querySelector(
    'button[aria-label*="Stop" i], button[aria-label*="stop generating" i]'
  );
  if (stop && !stop.disabled) return true;
  return !!document.querySelector('[aria-label*="Generating" i], .generating, [data-generating]');
};

const responseTextLen = () => {
  // Measure only the latest model-response (avoid trailing message-content freezing the length).
  const models = document.querySelectorAll("model-response");
  if (models.length) {
    const last = models[models.length - 1];
    const inner =
      last.querySelector("model-response-content, .response-container, .model-response-text, .response-content") ||
      last;
    return (inner.innerText || "").length;
  }
  const fallback = document.querySelectorAll(
    "model-response-content, .response-container, .model-response-text, .response-content"
  );
  if (fallback.length) {
    return (fallback[fallback.length - 1].innerText || "").length;
  }
  return 0;
};

const generationProgressSignals = () => {
  const gen = isGenerating();
  const len = responseTextLen();
  const busy = !!document.querySelector(
    '[aria-busy="true"], [data-is-streaming], .loading-indicator, .partial-response, [class*="streaming" i], [class*="generating" i]'
  );
  return { gen, len, busy, active: gen || busy };
};

const scrapeDomTurns = () => {
  const turns = [];
  const pairs = document.querySelectorAll("user-query, model-response");
  if (pairs.length) {
    for (const el of pairs) {
      const tag = el.tagName.toLowerCase();
      const role = tag.includes("user") ? "user" : "gemini";
      const text = textFromTurnEl(el, role);
      if (text) turns.push({ role, text, ts_sec: null, ts_nanos: 0 });
    }
    return turns;
  }
  // Fallback: message-content blocks alternating when custom elements missing
  const blocks = [...document.querySelectorAll("message-content, .query-text, .response-content")];
  for (const el of blocks) {
    const cls = `${el.className || ""} ${el.tagName}`.toLowerCase();
    const role = /query|user/.test(cls) ? "user" : "gemini";
    const text = cleanDomTurnText(role, (el.innerText || "").trim());
    if (!text || text.length < 2) continue;
    turns.push({ role, text, ts_sec: null, ts_nanos: 0 });
  }
  return turns;
};

const waitForGenerationEnd = async (timeoutMs, onProgress) => {
  const H = globalThis.KBHuman;
  const start = Date.now();
  // Idle budget: no DOM/generation progress for this long → stop waiting.
  // Hard cap: absolute ceiling even while streaming (keeps runaway chats bounded).
  const idleLimitMs = Math.max(15_000, timeoutMs);
  const hardLimitMs = Math.min(600_000, Math.max(timeoutMs * 3, timeoutMs + 120_000));
  let sawGen = false;
  let stable = 0;
  let lastLen = -1;
  let lastProgressAt = Date.now();
  const minWaitMs = 2500;
  const markProgress = () => {
    lastProgressAt = Date.now();
  };

  while (true) {
    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= hardLimitMs) break;
    if (now - lastProgressAt >= idleLimitMs) break;

    if (location.pathname.includes("/sorry")) {
      throw Object.assign(new Error("captcha /sorry page"), { captcha: true });
    }

    const { gen, len: bodyLen, busy, active } = generationProgressSignals();
    if (active) {
      sawGen = true;
      stable = 0;
      markProgress();
    }
    // Any length change counts as progress (thinking collapse can shrink then grow again).
    if (lastLen >= 0 && Math.abs(bodyLen - lastLen) > 15) {
      markProgress();
      stable = 0;
    }

    // Stop/streaming gone after we saw generation, and response text settled.
    if (sawGen && !active) {
      if (lastLen >= 0 && Math.abs(bodyLen - lastLen) < 40) stable += 1;
      else stable = 0;
      if (stable >= 4 && elapsed >= minWaitMs) {
        lastLen = bodyLen;
        await H.sleep(1500); // let batchexecute index the new turn
        return { sawGen, elapsed_ms: Date.now() - start };
      }
    }
    // Fast models sometimes never show Stop; require growth then plateau.
    if (!sawGen && !active && elapsed >= minWaitMs) {
      if (lastLen >= 0 && bodyLen > lastLen + 40) {
        // Saw some growth without Stop — treat as generation.
        sawGen = true;
        markProgress();
        stable = 0;
      } else if (lastLen >= 0 && bodyLen > 80 && Math.abs(bodyLen - lastLen) < 40) {
        stable += 1;
        if (stable >= 8) {
          // No Stop and no growth for a while — likely a failed/empty submit.
          await H.sleep(800);
          return { sawGen: false, elapsed_ms: Date.now() - start };
        }
      } else {
        stable = 0;
      }
    }

    lastLen = bodyLen;
    // Occasional pointer wander so the generation wait is not a frozen document.
    if (elapsed > 2000 && Math.random() < 0.12) {
      try {
        await H.wanderPointer();
      } catch {
        /* ignore */
      }
    }
    if (typeof onProgress === "function") {
      try {
        onProgress({
          generating: !!(gen || busy),
          elapsed_ms: elapsed,
          response_len: bodyLen,
          idle_ms: now - lastProgressAt,
          hard_left_ms: hardLimitMs - elapsed,
        });
      } catch {
        /* ignore */
      }
    }
    await H.sleep(H.gaussianDelay(450, 100, 250, 800));
  }
  // Soft timeout: still attempt extract rather than hard-fail after long wait.
  await H.sleep(800);
  return { sawGen, timedOut: true, elapsed_ms: Date.now() - start };
};

const turnsLookComplete = (turns, { minTurns, needle, nearDeadline, attempt }) => {
  const hasUser = turns.some((t) => t.role === "user" && (t.text || "").trim());
  const hasModel = turns.some(
    (t) => (t.role === "gemini" || t.role === "model") && (t.text || "").trim()
  );
  const promptOk =
    !needle ||
    turns.some((t) => t.role === "user" && (t.text || "").toLowerCase().includes(needle));
  return (
    turns.length >= minTurns &&
    hasUser &&
    promptOk &&
    (hasModel || (nearDeadline && attempt >= 3))
  );
};

const extractTurnsWithRetry = async (
  conversationId,
  { minTurns = 1, timeoutMs = 40000, promptText = null, preferDom = false } = {}
) => {
  const H = globalThis.KBHuman;
  const start = Date.now();
  let last = { turns: [], complete: false };
  let attempt = 0;
  const needle = promptText ? String(promptText).slice(0, 48).toLowerCase() : null;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const nearDeadline = Date.now() - start > timeoutMs * 0.75;
    // Prefer DOM after a live generate — avoids hammering private hNvQHb.
    if (preferDom || attempt === 1) {
      const dom = scrapeDomTurns();
      if (
        turnsLookComplete(dom, { minTurns, needle, nearDeadline, attempt })
      ) {
        return { turns: dom, complete: false, source: "dom" };
      }
    }
    // RPC at most every other attempt, and not on the first preferDom pass.
    if (!preferDom || attempt >= 2) {
      try {
        last = await extractFullThread(conversationId);
        last.source = "rpc";
        if (
          turnsLookComplete(last.turns || [], { minTurns, needle, nearDeadline, attempt })
        ) {
          return last;
        }
      } catch (err) {
        if (Date.now() - start > timeoutMs - 2000) throw err;
      }
    }
    await H.sleep(H.gaussianDelay(2200, 400, 1400, 3500));
  }
  const dom = scrapeDomTurns();
  if (dom.length > (last.turns || []).length) {
    return { turns: dom, complete: false, source: "dom" };
  }
  return last;
};

const assertOnConversation = (wantId) => {
  const have = conversationIdFromUrl();
  const want = String(wantId || "").toLowerCase();
  if (!want) return have;
  if (have !== want) {
    throw new Error(`wrong conversation open: have=${have || "none"} want=${want}`);
  }
  return have;
};

const scrapeConversations = ({ query, limit, offset }) => {
  const H = globalThis.KBHuman;
  const q = (query || "").toLowerCase();
  const links = [...document.querySelectorAll('a[href*="/app/"]')];
  const seen = new Set();
  const rows = [];
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/app\/([a-f0-9]+)/i);
    if (!m) continue;
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const title = (a.getAttribute("aria-label") || a.textContent || id).replace(/\s+/g, " ").trim();
    if (q && !title.toLowerCase().includes(q) && !id.includes(q)) continue;
    rows.push({ conversation_id: id, title, source: "gemini-live" });
  }
  return rows.slice(offset || 0, (offset || 0) + (limit || 20));
};

const remoteSearchConversations = async (params) => {
  const H = globalThis.KBHuman;
  // Wheel-scroll the sidebar (not scrollTop+=) so it looks like real input.
  for (let i = 0; i < 5; i++) {
    await H.humanScroll(H.rand(280, 420));
    await H.betweenActions();
  }
  return {
    hits: scrapeConversations(params).map((h) => ({
      ...h,
      account: detectAccount(),
    })),
  };
};

const remoteSearchMessages = async (params) => {
  const id = params.conversation_id || conversationIdFromUrl();
  if (!id) throw new Error("conversation_id required");
  // Background should already open this conversation; fail loudly if not.
  assertOnConversation(id);
  let { turns, complete } = await extractTurnsWithRetry(id, {
    minTurns: 1,
    timeoutMs: 25000,
  });
  if (!(turns || []).length) {
    const dom = scrapeDomTurns();
    if (dom.length) {
      turns = dom;
      complete = false;
    }
  }
  const q = (params.query || "").toLowerCase();
  let rows = turns.map((t) => ({
    source: "gemini-live",
    conversation_id: id,
    title: pageTitle(),
    role: t.role,
    text: t.text,
    account: detectAccount(),
  }));
  if (q) rows = rows.filter((r) => (r.text || "").toLowerCase().includes(q));
  const offset = params.offset || 0;
  const limit = params.limit || 20;
  return { hits: rows.slice(offset, offset + limit), complete, turns };
};

const remoteListModels = async () => {
  const listed = await globalThis.KBGeminiModels.listUnlockedModels();
  // Newer scrapers return { models, debug }; keep array return compatible.
  const models = Array.isArray(listed) ? listed : listed?.models || [];
  const debug = Array.isArray(listed) ? undefined : listed?.debug;
  return {
    models,
    debug,
    account: detectAccount(),
    conversation_id: conversationIdFromUrl(),
  };
};

const remotePageHtml = (params = {}) => {
  const maxChars = Math.max(1000, Math.min(5_000_000, Number(params.max_chars) || 200_000));
  const selector = (params.selector || "").trim() || null;
  let html = "";
  let matchCount = null;
  if (selector) {
    const nodes = [...document.querySelectorAll(selector)];
    matchCount = nodes.length;
    html = nodes.map((n) => n.outerHTML).join("\n");
  } else {
    html = document.documentElement?.outerHTML || document.body?.outerHTML || "";
  }
  const length = html.length;
  const truncated = length > maxChars;
  if (truncated) html = html.slice(0, maxChars);
  return {
    url: location.href,
    title: document.title || "",
    conversation_id: conversationIdFromUrl(),
    account: detectAccount(),
    html,
    length,
    truncated,
    selector: selector || undefined,
    match_count: matchCount ?? undefined,
    max_chars: maxChars,
  };
};

const remoteQuery = async (params, emit) => {
  const H = globalThis.KBHuman;
  const Models = globalThis.KBGeminiModels;
  const text = params.text || "";
  if (!text) throw new Error("query text required");

  if (params.conversation_id) {
    assertOnConversation(params.conversation_id);
  }

  const modelRequested = params.model || null;
  const effortRequested = params.effort || (params.model ? "medium" : null);
  let modelActualLabel = Models.readActiveModelLabel();

  if (modelRequested) {
    const sel = await Models.selectModelAndEffort(modelRequested, effortRequested || "medium");
    await emit("model_selected", sel);
    modelActualLabel = sel.label || Models.readActiveModelLabel();
  }

  const composer = findComposer();
  if (!composer) throw new Error("composer not found");
  // Brief settle / pointer wander before first keystroke after navigation.
  await H.sleep(H.gaussianDelay(1800, 400, 1200, 3200));
  try {
    await H.wanderPointer();
  } catch {
    /* ignore */
  }
  await H.betweenActions();
  await H.humanType(composer, text);
  await H.betweenActions();
  const send = findSendButton();
  if (!send) {
    await H.humanKey(composer, "Enter");
  } else {
    await H.humanClick(send);
  }

  // Conversation id often appears shortly after submit on /app → /app/<id>.
  let id = conversationIdFromUrl();
  for (let i = 0; i < 24 && !id; i++) {
    await H.sleep(250);
    id = conversationIdFromUrl();
  }
  await emit("submitted", { conversation_id: id });

  // Idle budget while Gemini makes DOM progress; hard cap is 3× inside waiter.
  const timeoutMs = Math.max(15, Math.min(600, Number(params.timeout_s) || 180)) * 1000;
  await waitForGenerationEnd(timeoutMs, (p) => emit("delta", p));

  id = conversationIdFromUrl() || id;
  for (let i = 0; i < 20 && !id; i++) {
    await H.sleep(250);
    id = conversationIdFromUrl();
  }
  if (!id) throw new Error("conversation id missing after submit");

  const afterLabel = Models.readActiveModelLabel();
  const reqSlug = String(modelRequested || "").toLowerCase();
  const afterSlug = String(afterLabel || "").toLowerCase();
  const modelChanged = !!(
    modelRequested &&
    afterLabel &&
    modelActualLabel &&
    afterLabel !== modelActualLabel &&
    !afterSlug.includes(reqSlug.slice(0, Math.min(6, reqSlug.length)))
  );

  if (modelChanged) {
    await emit("model_changed", {
      from: modelActualLabel || modelRequested,
      to: afterLabel,
      reason: "gemini_auto_switch",
    });
  }

  const { turns, complete, source } = await extractTurnsWithRetry(id, {
    minTurns: 1,
    timeoutMs: Math.max(12000, Math.min(45000, Math.floor(timeoutMs / 3))),
    promptText: text,
    preferDom: true,
  });
  await emit("turn", {
    conversation_id: id,
    turn_count: turns.length,
    extract_source: source || "dom",
  });

  try {
    await chrome.runtime.sendMessage({ type: "kb_trusted_input", action: "detach" });
  } catch {
    /* ignore */
  }

  return {
    conversation_id: id,
    title: pageTitle(),
    turns,
    complete,
    model: modelRequested,
    effort: effortRequested,
    model_requested: modelRequested,
    model_actual: afterLabel || modelActualLabel,
    model_changed: !!modelChanged,
    account: detectAccount(),
  };
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "gemini_push_now") {
    runExtractAndSend({ force: true }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "kb_ping") {
    sendResponse({
      ok: true,
      build: EXT_BUILD,
      conversation_id: conversationIdFromUrl(),
      account: detectAccount(),
      title: pageTitle(),
    });
    return true;
  }

  if (msg.type === "kb_remote") {
    const { commandId, kind, params } = msg;
    (async () => {
      const emit = async (type, payload) => {
        chrome.runtime.sendMessage({
          type: "kb_remote_event",
          commandId,
          eventType: type,
          payload: payload || {},
        });
      };
      try {
        if (kind === "list-models") {
          const result = await remoteListModels();
          sendResponse({ ok: true, result });
          return;
        }
        if (kind === "page-html") {
          const result = remotePageHtml(params || {});
          sendResponse({ ok: true, result });
          return;
        }
        if (kind === "search") {
          const result = params.conversation_id
            ? await remoteSearchMessages(params)
            : await remoteSearchConversations(params);
          sendResponse({ ok: true, result });
          return;
        }
        if (kind === "query") {
          const result = await remoteQuery(params || {}, emit);
          sendResponse({ ok: true, result });
          return;
        }
        sendResponse({ ok: false, error: `unknown kind ${kind}` });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err?.message ?? err),
          captcha: !!err?.captcha,
        });
      }
    })();
    return true;
  }

  return false;
});

// Soft URL poll instead of wrapping history.pushState (less fingerprintable).
setInterval(() => {
  const id = conversationIdFromUrl();
  if (id && id !== lastScheduledCid) {
    lastScheduledCid = id;
    scheduleExtract();
  }
}, 5000);
window.addEventListener("popstate", scheduleExtract);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleExtract();
});

scheduleExtract();
