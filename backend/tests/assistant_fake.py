"""A scripted stand-in for the Claude API (no test calls Anthropic).

FakeModel answers ``messages.create`` with the queued turns, in order, and keeps
a deep copy of every request so tests can check exactly what reached "the model".
"""

from __future__ import annotations

import copy
import itertools
import json
from collections.abc import Callable
from typing import Any

import httpx2
from anthropic.types import Message

_ids = itertools.count(1)

Turn = Message | Exception | Callable[[dict[str, Any]], Message]


def _message(content: list[dict[str, Any]], stop_reason: str) -> Message:
    return Message.model_validate(
        {
            "id": f"msg_{next(_ids)}",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-5-5",
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
    )


def text(reply: str, stop_reason: str = "end_turn") -> Message:
    return _message([{"type": "text", "text": reply}], stop_reason)


def tools(*calls: tuple[str, object]) -> Message:
    """One turn that calls these tools (in parallel), after a thinking block."""
    content: list[dict[str, Any]] = [
        {"type": "thinking", "thinking": "Let me look.", "signature": "sig"}
    ]
    content += [
        {"type": "tool_use", "id": f"toolu_{next(_ids)}", "name": name, "input": args}
        for name, args in calls
    ]
    return _message(content, "tool_use")


def refusal() -> Message:
    return _message([], "refusal")


REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


class FakeModel:
    def __init__(self, *turns: Turn, default: Turn | None = None):
        self.turns: list[Turn] = list(turns)
        self.default = default
        self.calls: list[dict[str, Any]] = []

    @property
    def messages(self) -> FakeModel:
        return self

    def create(self, **kwargs: Any) -> Message:
        self.calls.append(copy.deepcopy(kwargs))
        turn = self.turns.pop(0) if self.turns else self.default
        if turn is None:
            raise AssertionError("FakeModel: no turn left")
        if isinstance(turn, Exception):
            raise turn
        if callable(turn):
            return turn(kwargs)
        return turn

    # ---- what was sent

    def sent_messages(self) -> str:
        """Every message sent in every request, as one JSON text."""
        return json.dumps([c["messages"] for c in self.calls], ensure_ascii=False)

    def tool_results(self) -> list[dict[str, Any]]:
        """Every tool_result block sent back to the model, in order (deduplicated)."""
        seen: dict[str, dict[str, Any]] = {}
        for call in self.calls:
            for m in call["messages"]:
                if m["role"] != "user" or isinstance(m["content"], str):
                    continue
                for block in m["content"]:
                    if block.get("type") == "tool_result":
                        seen.setdefault(block["tool_use_id"], block)
        return list(seen.values())
