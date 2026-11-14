"""Wire-protocol enums for the Gemini extension ↔ KB broker."""

from __future__ import annotations

from enum import StrEnum


class CommandKind(StrEnum):
    QUERY = "query"
    SEARCH = "search"
    LIST_MODELS = "list-models"
    PAGE_HTML = "page-html"


class Capability(StrEnum):
    """Browser-advertised capabilities (same values as CommandKind today)."""

    QUERY = "query"
    SEARCH = "search"
    LIST_MODELS = "list-models"
    PAGE_HTML = "page-html"


DEFAULT_CAPABILITIES: tuple[Capability, ...] = (
    Capability.QUERY,
    Capability.SEARCH,
    Capability.LIST_MODELS,
    Capability.PAGE_HTML,
)


class CommandStatus(StrEnum):
    PENDING = "pending"
    CLAIMED = "claimed"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


TERMINAL_STATUSES: frozenset[CommandStatus] = frozenset(
    {
        CommandStatus.DONE,
        CommandStatus.ERROR,
        CommandStatus.TIMEOUT,
        CommandStatus.CANCELLED,
    }
)


class EventType(StrEnum):
    RUNNING = "running"
    CLAIMED = "claimed"
    TAB_OPENED = "tab_opened"
    SUBMITTED = "submitted"
    TURN = "turn"
    DELTA = "delta"
    MODEL_SELECTED = "model_selected"
    MODEL_CHANGED = "model_changed"
    DONE = "done"
    ERROR = "error"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class Effort(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    FAST = "fast"


class SearchSource(StrEnum):
    CACHE = "cache"
    GEMINI_LIVE = "gemini-live"


class ExtractSource(StrEnum):
    DOM = "dom"
    RPC = "rpc"


def normalize_command_kind(raw: str) -> CommandKind:
    key = raw.strip().lower().replace("_", "-")
    try:
        return CommandKind(key)
    except ValueError as e:
        raise ValueError(f"unknown command kind: {raw}") from e
