"""Write the API's OpenAPI document to docs/openapi.json.

    python -m app.openapi_export

The frontend generates its TypeScript API types from this file
(`npm run gen:api`), so it must be regenerated whenever the API changes - a
test fails if it is stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"


def render_openapi() -> str:
    from .main import create_app
    return json.dumps(create_app().openapi(), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    OPENAPI_PATH.write_text(render_openapi(), encoding="utf-8")
    print(f"Wrote {OPENAPI_PATH}", file=sys.stderr)
