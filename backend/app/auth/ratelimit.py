"""Minimal fixed-window rate limiter.

In-memory and per process: fine for the single API process this deployment
runs. Behind Caddy, run uvicorn with --proxy-headers so request.client.host is
the real client IP.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from fastapi import HTTPException, Request, status


class RateLimiter:
    def __init__(self, window_seconds: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.window = window_seconds
        self.clock = clock
        self._lock = threading.Lock()
        self._hits: dict[tuple[str, str], tuple[float, int]] = {}

    def hit(self, scope: str, key: str, limit: int) -> bool:
        """Record one request; return False if the limit for this window is exceeded."""
        now = self.clock()
        with self._lock:
            start, count = self._hits.get((scope, key), (now, 0))
            if now - start >= self.window:
                start, count = now, 0
            count += 1
            self._hits[(scope, key)] = (start, count)
            if len(self._hits) > 10_000:  # bound memory: drop expired windows
                self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
            return count <= limit

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


def rate_limit(scope: str, limit_of: Callable[[], int]):
    """FastAPI dependency factory: 429 when a client exceeds ``limit_of()`` per minute."""

    def dependency(request: Request) -> None:
        client = request.client.host if request.client else "unknown"
        if not limiter.hit(scope, client, limit_of()):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                                "Too many requests, try again in a minute",
                                headers={"Retry-After": str(int(limiter.window))})

    return dependency
