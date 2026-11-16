"""PostToolUse hook: format a file after an edit with the project's own formatter.

frontend/ files: Prettier from frontend/node_modules (--ignore-unknown skips
non-code files). backend/ *.py files: ruff format from backend/.venv. Nothing is
installed globally; when a tool is missing, or the file is elsewhere, this does
nothing. CI checks the same formatting. Reads the hook JSON on stdin.
"""

import json
import subprocess
import sys
from pathlib import Path


def formatter(root: Path, target: Path) -> tuple[Path, list[str]] | None:
    """Return (working directory, command) for the file, or None."""
    frontend, backend = root / "frontend", root / "backend"
    if frontend in target.parents:
        tool = frontend / "node_modules" / ".bin" / "prettier"
        return frontend, [str(tool), "--write", "--ignore-unknown", str(target)]
    if backend in target.parents and target.suffix == ".py":
        tool = backend / ".venv" / "bin" / "ruff"
        return backend, [str(tool), "format", str(target)]
    return None


def main() -> int:
    payload = json.load(sys.stdin)
    path = payload.get("tool_input", {}).get("file_path") or ""
    if not path:
        return 0
    root = Path(payload.get("cwd") or ".").resolve()
    target = Path(path).resolve()
    found = formatter(root, target)
    if found is None or not Path(found[1][0]).exists():
        return 0
    cwd, cmd = found
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"{Path(cmd[0]).name} failed on {target}:\n{result.stderr}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
