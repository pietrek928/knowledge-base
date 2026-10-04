(() => {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "kb.savedConfigs";
  const HEALTH_MS = 2 * 60 * 1000;

  function setHealth(state, label, title) {
    const el = $("health");
    const lab = $("health_label");
    if (!el || !lab) return;
    el.classList.remove("health-ok", "health-bad", "health-unknown");
    el.classList.add(`health-${state}`);
    lab.textContent = label;
    el.title = title || label;
  }

  async function checkHealth() {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        setHealth(
          "bad",
          `API error ${res.status}`,
          (body && (body.detail || body.status)) || res.statusText
        );
        return;
      }
      const status = (body && body.status) || "ok";
      if (String(status).toLowerCase() === "ok") {
        setHealth("ok", "API online", "Last health check succeeded");
      } else {
        setHealth("bad", String(status), JSON.stringify(body));
      }
    } catch (e) {
      setHealth("bad", e.message || "unreachable", String(e));
    }
  }

  // Run before anything else so CDN / UI setup cannot block status.
  checkHealth();
  setInterval(checkHealth, HEALTH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkHealth();
  });

  let timer = null;
  let controller = null;

  function readParams() {
    const phrases = $("q").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const body = {
      phrases,
      limit: Number($("limit").value) || 10,
      fusion: $("fusion").value,
      adaptive_fusion: $("adaptive").checked,
      identifier_fast_path: $("id_fast").checked,
      weights: {
        exact: Number($("w_exact").value),
        fuzzy: Number($("w_fuzzy").value),
        bm25: Number($("w_bm25").value),
        embed: Number($("w_embed").value),
      },
      candidate_k: Number($("candidate_k").value),
      rescore_multiplier: Number($("rescore_mult").value),
      fuzziness: $("fuzziness").value === "auto" ? "auto" : Number($("fuzziness").value) || "auto",
      sibling_window: Number($("sib_win").value),
      sibling_base: Number($("sib_base").value),
      complement_bonus: Number($("comp_bonus").value),
      cross_signal_bonus: Number($("cross_bonus").value),
      sibling_inject_max: Number($("sib_inject").value),
      date: {
        from: $("date_from").value || null,
        to: $("date_to").value || null,
        near: $("date_near").value || null,
        weight: Number($("date_w").value),
        half_life_days: Number($("half_life").value),
      },
    };
    const mc = $("min_conf").value;
    if (mc !== "") body.min_confidence = Number(mc);
    const pp = $("path_prefix").value.trim();
    if (pp) body.path = pp;
    const metaRaw = $("meta_json").value.trim();
    if (metaRaw) {
      try {
        body.meta = JSON.parse(metaRaw);
      } catch {
        /* ignore */
      }
    }
    return body;
  }

  function applyParams(p) {
    if (!p) return;
    if (p.phrases) $("q").value = p.phrases.join("\n");
    if (p.limit != null) $("limit").value = p.limit;
    if (p.fusion) $("fusion").value = p.fusion;
    if (p.adaptive_fusion != null) $("adaptive").checked = !!p.adaptive_fusion;
    if (p.identifier_fast_path != null) $("id_fast").checked = !!p.identifier_fast_path;
    const w = p.weights || {};
    if (w.exact != null) $("w_exact").value = w.exact;
    if (w.fuzzy != null) $("w_fuzzy").value = w.fuzzy;
    if (w.bm25 != null) $("w_bm25").value = w.bm25;
    if (w.embed != null) $("w_embed").value = w.embed;
    if (p.candidate_k != null) $("candidate_k").value = p.candidate_k;
    if (p.rescore_multiplier != null) $("rescore_mult").value = p.rescore_multiplier;
    if (p.min_confidence != null) $("min_conf").value = p.min_confidence;
    if (p.fuzziness != null) $("fuzziness").value = p.fuzziness;
    if (p.sibling_window != null) $("sib_win").value = p.sibling_window;
    if (p.sibling_base != null) $("sib_base").value = p.sibling_base;
    if (p.complement_bonus != null) $("comp_bonus").value = p.complement_bonus;
    if (p.cross_signal_bonus != null) $("cross_bonus").value = p.cross_signal_bonus;
    if (p.sibling_inject_max != null) $("sib_inject").value = p.sibling_inject_max;
    if (p.path) $("path_prefix").value = p.path;
    const d = p.date || {};
    if (d.from) $("date_from").value = d.from;
    if (d.to) $("date_to").value = d.to;
    if (d.near) $("date_near").value = d.near;
    if (d.weight != null) $("date_w").value = d.weight;
    if (d.half_life_days != null) $("half_life").value = d.half_life_days;
    if (p.meta) $("meta_json").value = JSON.stringify(p.meta);
  }

  function loadConfigList() {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const sel = $("cfg_list");
    const cur = sel.value;
    sel.innerHTML = '<option value="">— saved configs —</option>';
    Object.keys(all)
      .sort()
      .forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
    sel.value = cur;
    return all;
  }

  function sniff(source) {
    const s = (source || "").trim();
    if (s.startsWith("<") && s.includes(">")) return "html";
    if (/^#{1,6}\s|\*\*[^*]+\*\*|^\s*[-*+]\s|```/m.test(source || "")) return "markdown";
    return "plain";
  }

  function highlight(text, matches) {
    if (!matches || !matches.length) return escapeHtml(text);
    const spans = [...matches].sort((a, b) => a.start - b.start);
    let out = "";
    let i = 0;
    for (const m of spans) {
      if (m.start < i) continue;
      out += escapeHtml(text.slice(i, m.start));
      out += "<mark>" + escapeHtml(text.slice(m.start, m.end)) + "</mark>";
      i = m.end;
    }
    out += escapeHtml(text.slice(i));
    return out;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function fenceLineInfo(line) {
    const m = /^( {0,3})([`~]{3,})(.*)$/.exec(String(line).replace(/\r$/, ""));
    if (!m) return null;
    return { tick: m[2][0], n: m[2].length };
  }

  function updateFenceStack(src, stack) {
    const next = stack.slice();
    const lines = String(src || "").split("\n");
    for (const line of lines) {
      const info = fenceLineInfo(line);
      if (!info) continue;
      if (!next.length) {
        next.push(info);
        continue;
      }
      const top = next[next.length - 1];
      if (info.tick === top.tick && info.n >= top.n) next.pop();
      else next.push(info);
    }
    return next;
  }

  function looksLikeCode(src) {
    const text = String(src || "");
    if (!text.trim()) return false;
    if (/^\s*(def |class |import |from |async def )/m.test(text)) return true;
    const lines = text.split("\n").filter((l) => l.trim().length);
    if (lines.length < 2) return false;
    const indented = lines.filter((l) => /^(?: {2,}|\t)/.test(l)).length;
    return indented >= 2 && indented >= lines.length * 0.3;
  }

  function repairMarkdownSource(src, opts) {
    const options = opts || {};
    let stack = Array.isArray(options.fenceStack) ? options.fenceStack.slice() : [];
    let display = String(src || "");
    const startedOpen = stack.length > 0;
    if (startedOpen) display = "```\n" + display;
    stack = updateFenceStack(src, stack);
    if (stack.length > 0) {
      display += display.endsWith("\n") ? "```" : "\n```";
    }
    return { display, fenceStack: stack };
  }

  function matchNeedles(item) {
    const text = item && item.text ? String(item.text) : "";
    const needles = [];
    for (const m of (item && item.matches) || []) {
      if (m && typeof m.start === "number" && typeof m.end === "number" && text) {
        const sub = text.slice(m.start, m.end);
        if (sub) needles.push(sub);
      }
      if (m && m.text) needles.push(String(m.text));
    }
    return [...new Set(needles)].sort((a, b) => b.length - a.length);
  }

  function highlightHtml(html, item) {
    const needles = matchNeedles(item);
    if (!needles.length || !html) return html;
    const root = document.createElement("div");
    root.innerHTML = html;
    const skip = new Set(["MARK", "SCRIPT", "STYLE"]);

    function wrapNode(node, needle) {
      const value = node.nodeValue;
      if (!value) return;
      const parts = value.split(needle);
      if (parts.length < 2) return;
      const frag = document.createDocumentFragment();
      parts.forEach((part, idx) => {
        if (part) frag.appendChild(document.createTextNode(part));
        if (idx < parts.length - 1) {
          const mark = document.createElement("mark");
          mark.textContent = needle;
          frag.appendChild(mark);
        }
      });
      node.parentNode.replaceChild(frag, node);
    }

    function walk(node, needle) {
      if (!node) return;
      if (node.nodeType === 1 && skip.has(node.nodeName)) return;
      if (node.nodeType === 3) {
        wrapNode(node, needle);
        return;
      }
      const children = Array.from(node.childNodes);
      for (const child of children) walk(child, needle);
    }

    for (const needle of needles) walk(root, needle);
    return root.innerHTML;
  }

  function ensureMarkedOptions() {
    if (!window.marked || marked.__kbConfigured) return;
    marked.setOptions({ breaks: true, gfm: true });
    marked.__kbConfigured = true;
  }

  function renderBody(item, opts) {
    const options = opts || {};
    let src = item.source || item.text || "";
    let kind = sniff(src);
    let fenceStack = Array.isArray(options.fenceStack) ? options.fenceStack : [];

    if (kind === "plain" && fenceStack.length > 0) {
      // Continuation of a torn fence from the previous browse block.
      kind = "markdown";
    } else if (kind === "plain" && looksLikeCode(src)) {
      src = "```\n" + src.replace(/\s*$/, "") + "\n```";
      kind = "markdown";
    }

    if (kind === "markdown" && window.marked && window.DOMPurify) {
      ensureMarkedOptions();
      const repaired = repairMarkdownSource(src, { fenceStack });
      fenceStack = repaired.fenceStack;
      let html = DOMPurify.sanitize(marked.parse(repaired.display), {
        ADD_TAGS: ["mark"],
      });
      html = highlightHtml(html, item);
      return { html, fenceStack };
    }
    if (kind === "html" && window.DOMPurify) {
      let html = DOMPurify.sanitize(src, { ADD_TAGS: ["mark"] });
      html = highlightHtml(html, item);
      return { html, fenceStack };
    }
    return {
      html: `<div class="plain-body">${highlight(item.text || src, item.matches)}</div>`,
      fenceStack,
    };
  }

  let lastResultsData = null;
  let browsing = false;

  function showResultsPanel() {
    browsing = false;
    const rp = $("results_panel");
    const bp = $("browse_panel");
    if (rp) {
      rp.classList.remove("hidden");
      rp.hidden = false;
    }
    if (bp) {
      bp.classList.add("hidden");
      bp.hidden = true;
    }
  }

  function showBrowsePanel() {
    browsing = true;
    const rp = $("results_panel");
    const bp = $("browse_panel");
    if (rp) {
      rp.classList.add("hidden");
      rp.hidden = true;
    }
    if (bp) {
      bp.classList.remove("hidden");
      bp.hidden = false;
    }
  }

  function browseUrl(path, hash) {
    const segs = String(path)
      .split("/")
      .filter((s) => s.length)
      .map(encodeURIComponent);
    let url = "/browse/" + segs.join("/");
    if (hash) url += "?h=" + encodeURIComponent(hash);
    return url;
  }

  function setBrowseUrl(path, hash) {
    const next = browseUrl(path, hash || "");
    const cur = location.pathname + location.search;
    if (cur !== next) history.pushState(null, "", next);
  }

  function clearBrowseUrl() {
    if (location.pathname.startsWith("/browse/")) {
      history.pushState(null, "", "/");
    }
  }

  function parseBrowsePath() {
    const m = location.pathname.match(/^\/browse\/(.+)$/);
    if (!m) return null;
    const path = m[1]
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
    const hash = new URLSearchParams(location.search).get("h") || "";
    return { path, hash };
  }

  async function openBrowse(path, hitHash, matches, opts) {
    if (!path) return;
    const updateUrl = !opts || opts.updateUrl !== false;
    showBrowsePanel();
    $("browse_title").textContent = path;
    $("browse_meta").textContent = "loading…";
    $("browse_body").innerHTML = "";
    if (updateUrl) setBrowseUrl(path, hitHash || "");
    try {
      const docApi =
        "/docs/" +
        String(path)
          .split("/")
          .filter((s) => s.length)
          .map(encodeURIComponent)
          .join("/");
      const res = await fetch(docApi, { cache: "no-store" });
      if (!res.ok) {
        $("browse_meta").textContent = res.status === 404 ? "document not found" : "failed to load";
        return;
      }
      const doc = await res.json();
      const title = (doc.metadata && doc.metadata.title) || path;
      $("browse_title").textContent = title;
      const n = (doc.blocks || []).length;
      $("browse_meta").textContent = `${path} · ${n} block${n === 1 ? "" : "s"}`;
      const root = $("browse_body");
      root.innerHTML = "";
      let hitEl = null;
      let fenceStack = [];
      for (const b of doc.blocks || []) {
        const el = document.createElement("article");
        el.className = "browse-block";
        el.dataset.hash = b.hash || "";
        if (hitHash && b.hash === hitHash) {
          el.classList.add("block-hit");
          hitEl = el;
        }
        const item = {
          source: b.source,
          text: b.text,
          matches: hitHash && b.hash === hitHash ? matches || [] : [],
        };
        const rendered = renderBody(item, { fenceStack });
        fenceStack = rendered.fenceStack || [];
        el.innerHTML = `
          <div class="block-meta">#${b.index} · ${escapeHtml((b.hash || "").slice(0, 16))}…</div>
          <div class="body">${rendered.html}</div>`;
        root.appendChild(el);
      }
      if (hitEl) {
        requestAnimationFrame(() => hitEl.scrollIntoView({ block: "center", behavior: "smooth" }));
      }
    } catch (e) {
      $("browse_meta").textContent = e.message || "failed to load";
    }
  }

  function closeBrowse() {
    showResultsPanel();
    clearBrowseUrl();
  }

  function renderResults(data) {
    lastResultsData = data;
    showResultsPanel();
    const root = $("results");
    root.innerHTML = "";
    const results = (data && data.results) || [];
    if (!results.length) {
      root.innerHTML = '<p class="hint">No results</p>';
      return;
    }
    for (const r of results) {
      const el = document.createElement("article");
      el.className = "result";
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `Open ${r.path || "document"}`);
      el.innerHTML = `
        <div class="meta">
          <span class="path">${escapeHtml(r.path || "")}</span>
          <span class="score">score ${Number(r.score).toFixed(4)} · conf ${Number(r.confidence).toFixed(4)}</span>
          <span>#${r.index} · ${escapeHtml(r.hash || "").slice(0, 16)}…</span>
        </div>
        <div class="body">${renderBody(r).html}</div>`;
      const open = () => openBrowse(r.path, r.hash, r.matches);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
      root.appendChild(el);
    }
  }

  async function runSearch() {
    if (browsing) return;
    const body = readParams();
    if (!body.phrases.length) {
      $("results").innerHTML = "";
      $("status").textContent = "";
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    $("status").textContent = "searching…";
    try {
      const res = await fetch("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      renderResults(data);
      $("status").textContent = `${(data.results || []).length} hits · ${data.fusion || ""}`;
    } catch (e) {
      if (e.name === "AbortError") return;
      $("status").textContent = "error";
    }
  }

  async function syncBrowseFromPath() {
    const loc = parseBrowsePath();
    if (!loc) {
      if (browsing) showResultsPanel();
      return;
    }
    await openBrowse(loc.path, loc.hash, [], { updateUrl: false });
  }

  function scheduleSearch() {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  }

  function on(id, ev, fn) {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
  }

  on("q", "input", scheduleSearch);
  [
    "limit",
    "fusion",
    "adaptive",
    "id_fast",
    "w_exact",
    "w_fuzzy",
    "w_bm25",
    "w_embed",
    "candidate_k",
    "rescore_mult",
    "min_conf",
    "fuzziness",
    "sib_win",
    "sib_base",
    "comp_bonus",
    "cross_bonus",
    "sib_inject",
    "path_prefix",
    "date_from",
    "date_to",
    "date_near",
    "date_w",
    "half_life",
    "meta_json",
  ].forEach((id) => {
    on(id, "input", scheduleSearch);
    on(id, "change", scheduleSearch);
  });

  on("save_cfg", "click", () => {
    const name = $("cfg_name").value.trim();
    if (!name) return;
    const all = loadConfigList();
    all[name] = readParams();
    localStorage.setItem(LS_KEY, JSON.stringify(all));
    loadConfigList();
    $("cfg_list").value = name;
  });
  on("load_cfg", "click", () => {
    const all = loadConfigList();
    const name = $("cfg_list").value;
    if (!name || !all[name]) return;
    applyParams(all[name]);
    $("cfg_name").value = name;
    scheduleSearch();
  });
  on("del_cfg", "click", () => {
    const all = loadConfigList();
    const name = $("cfg_list").value;
    if (!name) return;
    delete all[name];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
    loadConfigList();
  });
  on("browse_back", "click", () => {
    closeBrowse();
    if (lastResultsData) renderResults(lastResultsData);
  });
  window.addEventListener("popstate", () => {
    syncBrowseFromPath();
  });
  loadConfigList();
  syncBrowseFromPath();
})();
