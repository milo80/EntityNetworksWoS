"""FastAPI application.

    uvicorn app.main:app --proxy-headers   (in production behind Caddy)
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, datasets, health, runs
from .config import get_settings
from .logging import configure_logging


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.upload_dir.mkdir(parents=True, exist_ok=True)
        yield

    production = settings.app_env == "production"
    app = FastAPI(
        title="EntityNetworks API",
        version="0.1.0",
        lifespan=lifespan,
        # Interactive docs only outside production.
        docs_url=None if production else "/api/docs",
        redoc_url=None,
        openapi_url=None if production else "/api/openapi.json",
    )

    if settings.allowed_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins,
                           allow_credentials=True, allow_methods=["GET", "POST", "DELETE"],
                           allow_headers=[settings.csrf_header, "Content-Type"])

    for module in (health, auth, datasets, runs):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
