import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from knowledge_base.config import load_config
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


def create_app(cfg: dict[str, Any] | None = None, *, fake_ollama: bool | None = None) -> FastAPI:
    if fake_ollama is None:
        fake_ollama = os.environ.get("KB_FAKE_OLLAMA", "").lower() in ("1", "true", "yes")
    kb = KnowledgeBase(cfg or load_config(), fake_ollama=fake_ollama)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await kb.start()
        app.state.kb = kb
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

    if _STATIC.exists():
        app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")

    return app


app = create_app()
