import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from knowledge_base.config import load_config
from knowledge_base.ext_broker import ExtBroker
from knowledge_base.ext_protocol import Capability, CommandKind, EventType
from knowledge_base.service import KnowledgeBase

_STATIC = Path(__file__).resolve().parent / "static"


class StoreRequest(BaseModel):
    path: str
    content: str
    metadata: dict[str, Any] | None = None
    block_metadata: dict[str, Any] | None = None


class GeminiTurn(BaseModel):
    role: str
    text: str = ""
    ts_sec: int | float | None = None
    ts_nanos: int | float | None = 0


class GeminiIngestRequest(BaseModel):
    conversation_id: str
    title: str | None = None
    ingest: Literal["takeout", "extension"] = "extension"
    turns: list[GeminiTurn] = Field(default_factory=list)


class SearchRequest(BaseModel):
    phrases: list[str] | None = None
    q: str | list[str] | None = None
    limit: int = 10
    fusion: str | None = None
    weights: dict[str, float] | None = None
    adaptive_fusion: bool | None = None
    min_confidence: float | None = None
    candidate_k: int | None = None
    rescore_multiplier: int | None = None
    identifier_fast_path: bool | None = None
    date: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    path: str | None = None
    fuzziness: Any = "auto"
    sibling_window: int | None = None
    sibling_base: float | None = None
    complement_bonus: float | None = None
    cross_signal_bonus: float | None = None
    sibling_inject_max: int | None = None
    rrf_k: int | None = None


class ExtRegisterRequest(BaseModel):
    browser_id: str
    account: str | None = None
    capabilities: list[Capability] | None = None
    conversation_ids: list[str] | None = None


class ExtHeartbeatRequest(BaseModel):
    browser_id: str
    account: str | None = None
    conversation_ids: list[str] | None = None


class ExtEventRequest(BaseModel):
    command_id: str
    type: EventType
    payload: dict[str, Any] | None = None
    seq: int | None = None


class ExtCommandRequest(BaseModel):
    kind: CommandKind
    params: dict[str, Any] | None = None


def create_app(cfg: dict[str, Any] | None = None, *, fake_ollama: bool | None = None) -> FastAPI:
    if fake_ollama is None:
        fake_ollama = os.environ.get("KB_FAKE_OLLAMA", "").lower() in ("1", "true", "yes")
    kb = KnowledgeBase(cfg or load_config(), fake_ollama=fake_ollama)
    broker = ExtBroker(list_docs=kb.list_docs, get_document=kb.get_document)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await kb.start()
        app.state.kb = kb
        app.state.broker = broker
        yield
        await kb.stop()

    app = FastAPI(
        title="Knowledge Base",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "embeddings": kb.embeddings_enabled}

    @app.post("/store")
    async def store(req: StoreRequest) -> dict[str, Any]:
        if not req.path or not req.path.strip():
            raise HTTPException(400, "path required")
        try:
            return await kb.store_document(
                req.path.strip(),
                req.content,
                metadata=req.metadata,
                block_metadata=req.block_metadata,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.post("/ingest/gemini")
    async def ingest_gemini(req: GeminiIngestRequest) -> dict[str, Any]:
        try:
            return await kb.ingest_gemini(
                conversation_id=req.conversation_id,
                title=req.title,
                turns=[t.model_dump() for t in req.turns],
                ingest=req.ingest,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/docs")
    async def list_docs(prefix: str | None = Query(None)) -> dict[str, Any]:
        return {"docs": kb.list_docs(prefix=prefix)}

    @app.get("/docs/{doc_path:path}")
    async def get_document(doc_path: str) -> dict[str, Any]:
        doc = kb.get_document(doc_path)
        if doc is None:
            raise HTTPException(404, "document not found")
        return doc

    @app.post("/search")
    async def search(req: SearchRequest, request: Request) -> dict[str, Any]:
        body = req.model_dump(exclude_none=True)
        # disconnect cancel: cooperative check
        if await request.is_disconnected():
            return {"results": [], "cancelled": True}
        return await kb.search(body)

    @app.get("/search")
    async def search_get(
        q: str = Query(...),
        limit: int = 10,
        fusion: str | None = None,
        path: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"phrases": [q], "limit": limit}
        if fusion:
            body["fusion"] = fusion
        if path:
            body["path"] = path
        return await kb.search(body)

    @app.get("/")
    async def index_page() -> FileResponse:
        return FileResponse(_STATIC / "index.html")

    @app.get("/browse/{doc_path:path}")
    async def browse_page(doc_path: str) -> FileResponse:
        """SPA shell for path-based document browsing (client loads /docs/…)."""
        return FileResponse(_STATIC / "index.html")

    # --- Extension remote-control broker ---

    @app.post("/ext/register")
    async def ext_register(req: ExtRegisterRequest) -> dict[str, Any]:
        return await broker.register(
            req.browser_id,
            account=req.account,
            capabilities=req.capabilities,
            conversation_ids=req.conversation_ids,
        )

    @app.post("/ext/heartbeat")
    async def ext_heartbeat(req: ExtHeartbeatRequest) -> dict[str, Any]:
        return await broker.heartbeat(
            req.browser_id,
            account=req.account,
            conversation_ids=req.conversation_ids,
        )

    @app.get("/ext/browsers")
    async def ext_browsers() -> dict[str, Any]:
        return {"browsers": broker.live_browsers()}

    @app.get("/ext/poll")
    async def ext_poll(
        browser_id: str = Query(...),
        wait_s: float = Query(25.0, ge=0.0, le=25.0),
    ) -> Any:
        from fastapi.responses import Response

        cmd = await broker.poll(browser_id, wait_s=wait_s)
        if cmd is None:
            return Response(status_code=204)
        return cmd

    @app.post("/ext/events")
    async def ext_events(req: ExtEventRequest) -> dict[str, Any]:
        try:
            event = await broker.post_event(
                req.command_id, type=req.type, payload=req.payload, seq=req.seq
            )
            return {"ok": True, "event": event}
        except KeyError as e:
            raise HTTPException(404, "command not found") from e

    @app.post("/ext/commands")
    async def ext_commands(req: ExtCommandRequest) -> dict[str, Any]:
        try:
            return await broker.enqueue(req.kind, req.params)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/ext/commands/{command_id}")
    async def ext_command_get(
        command_id: str, after_seq: int = Query(0, ge=0)
    ) -> dict[str, Any]:
        cmd = broker.get(command_id, after_seq=after_seq)
        if cmd is None:
            raise HTTPException(404, "command not found")
        return cmd

    @app.get("/ext/commands/{command_id}/wait")
    async def ext_command_wait(
        command_id: str,
        timeout_s: float | None = Query(None, ge=1.0, le=650.0),
    ) -> dict[str, Any]:
        try:
            return await broker.wait(command_id, timeout_s=timeout_s)
        except KeyError as e:
            raise HTTPException(404, "command not found") from e

    @app.post("/ext/commands/{command_id}/cancel")
    async def ext_command_cancel(command_id: str) -> dict[str, Any]:
        try:
            return await broker.cancel(command_id)
        except KeyError as e:
            raise HTTPException(404, "command not found") from e

    if _STATIC.exists():
        app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")

    return app


app = create_app()
