"""One assistant answer: a manual tool-use loop on the Claude Messages API.

The conversation comes from the browser (nothing is stored); only its last
MAX_MODEL_MESSAGES messages reach the model. The model may use tools in at most
MAX_TOOL_ROUNDS turns, and the whole answer gets ANSWER_TIMEOUT_SECONDS.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol, cast

import anthropic
from anthropic.types import Message, MessageParam, TextBlockParam, ToolResultBlockParam

from ...schemas.assistant import ChatContext, ChatMessage, ChatOut
from .guide import SYSTEM_PROMPT
from .tools import TOOLS, Collected, ToolContext, run_tool

log = logging.getLogger(__name__)

MAX_MODEL_MESSAGES = 20
MAX_TOOL_ROUNDS = 5
ANSWER_TIMEOUT_SECONDS = 30.0
MAX_TOKENS = 4096

NOT_AVAILABLE = "The assistant is not available on this server."
UNAVAILABLE_NOW = "The assistant is not available right now. Please try again later."
TOO_MANY = "You've asked a lot of questions. Please wait a few minutes and try again."
TOO_LONG = "Your message is too long (at most 2000 characters)."
COULD_NOT_FINISH = "I couldn't finish that. Please ask a simpler or narrower question."
REFUSED = (
    "Sorry, I can't help with that. I can explain EntityNetworks, suggest network settings "
    "and change the explorer's filters."
)

SYSTEM: list[TextBlockParam] = [
    # Static prefix (tools, then this prompt): cached across requests and users.
    {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
]


class _Messages(Protocol):
    def create(self, **kwargs: Any) -> Message: ...


class ModelClient(Protocol):
    """The part of anthropic.Anthropic the assistant uses (tests pass a scripted fake)."""

    @property
    def messages(self) -> _Messages: ...


@lru_cache(maxsize=2)
def make_client(api_key: str) -> ModelClient:
    # No SDK retries: the answer's deadline bounds every call instead.
    client = anthropic.Anthropic(api_key=api_key, timeout=ANSWER_TIMEOUT_SECONDS, max_retries=0)
    return cast(ModelClient, client)


class AssistantUnavailable(Exception):
    """The Claude API failed or timed out; the endpoint answers 502."""


clock = time.monotonic
"""The deadline's clock (tests replace it)."""


@dataclass
class _Deadline:
    at: float

    def remaining(self) -> float:
        left = self.at - clock()
        if left <= 0:
            raise AssistantUnavailable("deadline")
        return left


def context_line(context: ChatContext) -> str:
    parts = [f"page: {context.page}"]
    if context.dataset_id is not None:
        parts.append(f"open dataset id: {context.dataset_id}")
    if context.run_id is not None:
        parts.append(f"open network id: {context.run_id}")
    elif context.page == "local":
        parts.append(
            "a local network file is open in the explorer (not uploaded: "
            "it can't be read or changed by chat)"
        )
    else:
        parts.append("no network open")
    return f"[App context, not typed by the user] {'; '.join(parts)}"


def model_messages(history: list[ChatMessage], context: ChatContext) -> list[MessageParam]:
    """The last MAX_MODEL_MESSAGES messages, starting with the user's; context on the last."""
    recent = history[-MAX_MODEL_MESSAGES:]
    while recent and recent[0].role != "user":
        recent = recent[1:]
    messages: list[MessageParam] = []
    for m in recent[:-1]:
        if m.role == "user":
            messages.append({"role": "user", "content": m.text})
        else:
            messages.append({"role": "assistant", "content": m.text})
    last = recent[-1]
    messages.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": context_line(context)},
                {"type": "text", "text": last.text},
            ],
        }
    )
    return messages


def _text(message: Message) -> str:
    return "\n\n".join(b.text for b in message.content if b.type == "text").strip()


def answer(
    client: ModelClient,
    model: str,
    history: list[ChatMessage],
    ctx: ToolContext,
    context: ChatContext,
) -> ChatOut:
    deadline = _Deadline(clock() + ANSWER_TIMEOUT_SECONDS)
    messages = model_messages(history, context)
    out = Collected()
    try:
        for round_ in range(MAX_TOOL_ROUNDS + 1):
            # Tools only read: end the transaction so no connection sits idle in it
            # while the model thinks.
            ctx.db.rollback()
            response = client.messages.create(
                model=model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM,
                tools=TOOLS,
                tool_choice={"type": "auto"},
                thinking={"type": "adaptive"},
                output_config={"effort": "low"},
                messages=messages,
                timeout=deadline.remaining(),
            )
            if response.stop_reason == "refusal":
                return ChatOut(reply=REFUSED)
            if response.stop_reason != "tool_use":
                break
            if round_ == MAX_TOOL_ROUNDS:
                return ChatOut(reply=COULD_NOT_FINISH)
            # Every tool call of this turn answered in one user message.
            results: list[ToolResultBlockParam] = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                content, is_error = run_tool(block.name, block.input, ctx, out)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": content,
                        "is_error": is_error,
                    }
                )
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        cast(Any, b.to_dict(mode="json", exclude_none=True))
                        for b in response.content
                    ],
                }
            )
            messages.append({"role": "user", "content": results})
    except anthropic.APITimeoutError:
        log.warning("Assistant: the Claude API timed out")
        raise AssistantUnavailable("timeout") from None
    except anthropic.APIConnectionError:
        log.warning("Assistant: can't reach the Claude API")
        raise AssistantUnavailable("connection") from None
    except anthropic.APIStatusError as exc:
        log.warning("Assistant: the Claude API answered %s", exc.status_code)
        raise AssistantUnavailable("status") from None
    except anthropic.AnthropicError as exc:
        log.warning("Assistant: Claude API client error (%s)", type(exc).__name__)
        raise AssistantUnavailable("client") from None

    if response.stop_reason in ("max_tokens", "model_context_window_exceeded"):
        return ChatOut(reply=COULD_NOT_FINISH)
    reply = _text(response)
    if not reply:
        reply = "Done." if out.actions or out.proposal else COULD_NOT_FINISH
    return ChatOut(reply=reply, proposal=out.proposal, actions=out.actions)
