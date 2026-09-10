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

  function renderBody(item) {
    const src = item.source || item.text || "";
    const kind = sniff(src);
    if (kind === "markdown" && window.marked && window.DOMPurify) {
      return DOMPurify.sanitize(marked.parse(src));
    }
    if (kind === "html" && window.DOMPurify) {
      return DOMPurify.sanitize(src);
    }
    return highlight(item.text || src, item.matches);
  }

  function renderResults(data) {
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
      el.innerHTML = `
        <div class="meta">
          <span class="path">${escapeHtml(r.path || "")}</span>
          <span class="score">score ${Number(r.score).toFixed(4)} · conf ${Number(r.confidence).toFixed(4)}</span>
          <span>#${r.index} · ${escapeHtml(r.hash || "").slice(0, 16)}…</span>
        </div>
        <div class="body">${renderBody(r)}</div>`;
      root.appendChild(el);
    }
  }

  async function runSearch() {
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
  loadConfigList();
})();
