const { MsgType, gaussMs } = globalThis.KB;

const kbUrlEl = document.getElementById("kbUrl");
const autoSaveEl = document.getElementById("autoSave");
const trustedInputEl = document.getElementById("trustedInput");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

const setStatus = (text) => {
  statusEl.textContent = text || "";
};

const renderChats = (chats) => {
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
};

const escapeHtml = (s) => {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

const refresh = () => {
  chrome.runtime.sendMessage({ type: MsgType.GET_STATE }, (state) => {
    if (!state) {
      setStatus("Background unavailable");
      return;
    }
    kbUrlEl.value = state.kbUrl || "";
    autoSaveEl.checked = !!state.autoSave;
    trustedInputEl.checked = !!state.trustedInput;
    const n = Object.keys(state.chats || {}).length;
    const pending = Object.values(state.chats || {}).filter(
      (c) => c.pendingFullSync
    ).length;
    let status = `Tracked: ${n}${pending ? ` · pending: ${pending}` : ""}`;
    if (state.captchaNeedsUser || (state.captchaBlockedUntil || 0) > Date.now()) {
      status += " · captcha gate (cleared on popup open)";
      chrome.runtime.sendMessage({ type: MsgType.CLEAR_CAPTCHA_GATE });
    }
    setStatus(status);
    renderChats(state.chats);
  });
};

document.getElementById("saveSettings").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    {
      type: MsgType.SET_SETTINGS,
      kbUrl: kbUrlEl.value.trim(),
      autoSave: autoSaveEl.checked,
      trustedInput: trustedInputEl.checked,
    },
    () => {
      setStatus(
        trustedInputEl.checked
          ? "Saved — click/move/wheel use CDP (banner may appear); TYPE/PASTE always CDP"
          : "Saved — click/move/wheel synthetic; TYPE/PASTE still always use CDP"
      );
      refresh();
    }
  );
});

document.getElementById("pushNow").addEventListener("click", () => {
  setStatus("Pushing…");
  chrome.runtime.sendMessage({ type: MsgType.PUSH_ACTIVE_TAB }, (res) => {
    if (!res?.ok) {
      setStatus(res?.error || "Push failed");
      return;
    }
    setStatus("Extract requested — check status after a few seconds");
    setTimeout(refresh, gaussMs(3200, 700, 1800, 5500));
  });
});

refresh();
