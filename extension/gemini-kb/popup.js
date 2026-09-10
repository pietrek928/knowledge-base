const kbUrlEl = document.getElementById("kbUrl");
const autoSaveEl = document.getElementById("autoSave");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function renderChats(chats) {
  const items = Object.values(chats || {}).sort((a, b) =>
    String(b.lastCheckedAt || "").localeCompare(String(a.lastCheckedAt || ""))
  );
  if (!items.length) {
    listEl.innerHTML = "<div class='chat'>No tracked chats yet.</div>";
    return;
  }
  listEl.innerHTML = items
    .slice(0, 30)
    .map((c) => {
      const pending = c.pendingFullSync
        ? "<span class='badge'>pending</span>"
        : "";
      const pushed = c.lastPushedAt
        ? `pushed ${new Date(c.lastPushedAt).toLocaleString()}`
        : "never pushed";
      return `<div class="chat"><div class="title">${escapeHtml(
        c.title || c.id
      )}${pending}</div><div>${escapeHtml(pushed)}</div></div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function refresh() {
  chrome.runtime.sendMessage({ type: "get_state" }, (state) => {
    if (!state) {
      setStatus("Background unavailable");
      return;
    }
    kbUrlEl.value = state.kbUrl || "";
    autoSaveEl.checked = !!state.autoSave;
    const n = Object.keys(state.chats || {}).length;
    const pending = Object.values(state.chats || {}).filter(
      (c) => c.pendingFullSync
    ).length;
    setStatus(`Tracked: ${n}${pending ? ` · pending: ${pending}` : ""}`);
    renderChats(state.chats);
  });
}

document.getElementById("saveSettings").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    {
      type: "set_settings",
      kbUrl: kbUrlEl.value.trim(),
      autoSave: autoSaveEl.checked,
    },
    () => {
      setStatus("Settings saved");
      refresh();
    }
  );
});

document.getElementById("pushNow").addEventListener("click", () => {
  setStatus("Pushing…");
  chrome.runtime.sendMessage({ type: "push_active_tab" }, (res) => {
    if (!res?.ok) {
      setStatus(res?.error || "Push failed");
      return;
    }
    setStatus("Extract requested — check status after a few seconds");
    setTimeout(refresh, 3000);
  });
});

refresh();
