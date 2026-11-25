from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..auth.ratelimit import check_user_hourly_limit
from ..auth.sessions import CurrentUser
from ..config import Settings, get_settings
from ..db import get_db
from ..schemas.assistant import MAX_MESSAGE_CHARS, AssistantStatusOut, ChatIn, ChatOut
from ..services.assistant.chat import (
    NOT_AVAILABLE,
    TOO_LONG,
    TOO_MANY,
    UNAVAILABLE_NOW,
    AssistantUnavailable,
    ModelClient,
    answer,
    make_client,
)
from ..services.assistant.tools import ToolContext

router = APIRouter(prefix="/assistant", tags=["assistant"])

Db = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


def get_model_client(settings: Config) -> ModelClient | None:
    """The Claude API client, or None without a key. Tests override this dependency."""
    if settings.anthropic_api_key is None:
        return None
    return make_client(settings.anthropic_api_key.get_secret_value())


@router.get("/status", response_model=AssistantStatusOut)
def assistant_status(user: CurrentUser, settings: Config) -> AssistantStatusOut:
    """Whether the assistant is on (an API key is configured)."""
    return AssistantStatusOut(enabled=settings.assistant_enabled)


@router.post(
    "/chat",
    response_model=ChatOut,
    responses={
        422: {"description": "A message is too long or the conversation doesn't end with one"},
        429: {"description": "Too many messages this hour"},
        502: {"description": "The Claude API failed or timed out"},
        503: {"description": "The assistant is off on this server (no API key)"},
    },
)
def chat(
    body: ChatIn,
    user: CurrentUser,
    db: Db,
    settings: Config,
    client: Annotated[ModelClient | None, Depends(get_model_client)],
) -> ChatOut:
    """One answer to the conversation. Nothing is stored; only ids of what is open are used.

    The reply may carry a proposal for the open dataset's Build network form and,
    while a network is open, explorer actions to apply in order. Nothing is built.
    """
    if not settings.assistant_enabled or client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_AVAILABLE)
    if any(m.role == "user" and len(m.text) > MAX_MESSAGE_CHARS for m in body.messages):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, TOO_LONG)
    if body.messages[-1].role != "user":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "The conversation must end with a question."
        )
    check_user_hourly_limit("assistant", user.id, settings.assistant_messages_per_hour, TOO_MANY)

    ctx = ToolContext(
        db=db,
        user_id=user.id,
        page=body.context.page,
        dataset_id=body.context.dataset_id,
        run_id=body.context.run_id,
    )
    try:
        return answer(client, settings.assistant_model, body.messages, ctx, body.context)
    except AssistantUnavailable:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, UNAVAILABLE_NOW) from None
    finally:
        db.rollback()  # the assistant only reads
