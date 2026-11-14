/**
 * DEV-only live reload client (classic script, importScripts'd into the SW).
 * Connects to ws://127.0.0.1:9333; on session/generation change → chrome.runtime.reload().
 * Never calls chrome.tabs.reload.
 */
(() => {
  const WS_URL = "ws://127.0.0.1:9333";
  const STORAGE_KEY = "kbDevReload";
  const ALARM = "kb_dev_reload";

  let socket = null;

  const persistAndMaybeReload = async (sessionId, generation) => {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    const prev = data[STORAGE_KEY] || {};
    const next = { sessionId, generation };
    if (!prev.sessionId) {
      // First load (or session storage cleared): adopt ids, do not reload.
      await chrome.storage.session.set({ [STORAGE_KEY]: next });
      return;
    }
    if (prev.sessionId !== sessionId || generation > (prev.generation || 0)) {
      await chrome.storage.session.set({ [STORAGE_KEY]: next });
      chrome.runtime.reload();
      return;
    }
  };

  const onFrame = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || (msg.type !== "hello" && msg.type !== "reload")) return;
    if (!msg.sessionId) return;
    persistAndMaybeReload(msg.sessionId, Number(msg.generation) || 0).catch(() => {});
  };

  const keepAlive = (ws) => {
    const id = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "keepalive" }));
        } catch {
          clearInterval(id);
        }
      } else {
        clearInterval(id);
      }
    }, 20_000);
  };

  const connect = () => {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      return;
    }
    socket = ws;
    ws.onopen = () => keepAlive(ws);
    ws.onmessage = (ev) => onFrame(ev.data);
    ws.onclose = () => {
      if (socket === ws) socket = null;
      setTimeout(connect, 1000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  };

  const ensureAlarm = async () => {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) {
      await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    }
  };

  ensureAlarm().catch(() => {});
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) connect();
  });
  connect();
})();
