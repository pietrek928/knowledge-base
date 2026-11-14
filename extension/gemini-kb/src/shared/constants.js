/**
 * Wire-protocol string variants (keep in sync with knowledge_base.ext_protocol).
 */
const freeze = (o) => Object.freeze(o);

  /** Box–Muller sample, rounded ms, clamped to [min, max]. */
  const gaussMs = (mean, sigma, min, max) => {
    // Box-Muller: clamp away from 0 so Math.log(u) never -Inf / NaN.
    const eps = Number.EPSILON;
    const u = Math.max(eps, Math.random());
    const v = Math.max(eps, Math.random());
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const val = mean + z * sigma;
    return Math.max(min, Math.min(max, Math.round(val)));
  };

  const CommandKind = freeze({
    QUERY: "query",
    SEARCH: "search",
    LIST_MODELS: "list-models",
    PAGE_HTML: "page-html",
  });

  const Capability = freeze({
    QUERY: "query",
    SEARCH: "search",
    LIST_MODELS: "list-models",
    PAGE_HTML: "page-html",
  });

  const CAPABILITIES = freeze([
    Capability.QUERY,
    Capability.SEARCH,
    Capability.LIST_MODELS,
    Capability.PAGE_HTML,
  ]);

  const TrustedAction = freeze({
    DETACH: "detach",
    CLICK: "click",
    MOVE: "move",
    TYPE: "type",
    PASTE: "paste",
    KEY: "key",
    WHEEL: "wheel",
  });

  const EventType = freeze({
    RUNNING: "running",
    CLAIMED: "claimed",
    TAB_OPENED: "tab_opened",
    SUBMITTED: "submitted",
    TURN: "turn",
    DELTA: "delta",
    MODEL_SELECTED: "model_selected",
    MODEL_CHANGED: "model_changed",
    DONE: "done",
    ERROR: "error",
    TIMEOUT: "timeout",
    CANCELLED: "cancelled",
  });

  const Effort = freeze({
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    FAST: "fast",
  });

  const EFFORT_VALUES = freeze([Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.FAST]);

  const SearchSource = freeze({
    CACHE: "cache",
    GEMINI_LIVE: "gemini-live",
  });

  const ExtractSource = freeze({
    DOM: "dom",
    RPC: "rpc",
  });

  const MsgType = freeze({
    TRUSTED_INPUT: "kb_trusted_input",
    PING: "kb_ping",
    REMOTE: "kb_remote",
    REMOTE_EVENT: "kb_remote_event",
    REMOTE_CANCEL: "kb_remote_cancel",
    EXTRACT_RESULT: "gemini_extract_result",
    PUSH_NOW: "gemini_push_now",
    GET_STATE: "get_state",
    SET_SETTINGS: "set_settings",
    CLEAR_CAPTCHA_GATE: "clear_captcha_gate",
    PUSH_ACTIVE_TAB: "push_active_tab",
    RUN_SWEEP: "run_sweep",
  });

  const CommandStatus = freeze({
    PENDING: "pending",
    CLAIMED: "claimed",
    RUNNING: "running",
    DONE: "done",
    ERROR: "error",
    TIMEOUT: "timeout",
    CANCELLED: "cancelled",
  });

export {
  gaussMs,
  CommandKind,
  Capability,
  CAPABILITIES,
  TrustedAction,
  EventType,
  CommandStatus,
  Effort,
  EFFORT_VALUES,
  SearchSource,
  ExtractSource,
  MsgType,
};
