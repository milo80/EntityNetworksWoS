"""Print the API's routes (method + path) from its OpenAPI schema.

    python scripts/list_routes.py
"""

from __future__ import annotations

from app.main import create_app


def main() -> None:
    paths = create_app().openapi()["paths"]
    for path, operations in paths.items():
        for method, op in operations.items():
            print(f"{method.upper():7} {path:32} {op.get('summary', '')}")


if __name__ == "__main__":
    main()
