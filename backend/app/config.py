"""Application settings, read from environment variables (and .env in development)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"

    database_url: str = "postgresql+psycopg://entitynet:entitynet@localhost:5432/entitynet"
    upload_dir: Path = Path("var/uploads")

    # Uploads
    max_upload_mb: int = Field(50, ge=1)
    max_files_per_dataset: int = Field(10, ge=1)

    # Auth
    allow_registration: bool = True
    session_ttl_hours: int = Field(24 * 7, ge=1)
    cookie_secure: bool = True
    session_cookie: str = "entitynet_session"
    csrf_cookie: str = "entitynet_csrf"
    csrf_header: str = "X-CSRF-Token"

    # Rate limits (requests per minute per client IP; in-memory, single process)
    login_rate_per_minute: int = 10
    register_rate_per_minute: int = 5
    upload_rate_per_minute: int = 10

    # Only needed if the UI is served from a different origin than the API.
    # In dev the Vite proxy and in prod Caddy keep everything same-origin.
    allowed_origins: list[str] = []

    # Worker
    worker_poll_seconds: float = Field(2.0, gt=0)
    worker_max_attempts: int = Field(3, ge=1)

    @model_validator(mode="after")
    def _production_guards(self) -> Settings:
        if self.app_env == "production" and not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be true in production")
        return self

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
