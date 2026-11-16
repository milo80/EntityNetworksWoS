"""PostToolUse hook: run the project's Prettier on a frontend file after an edit.

Uses frontend/node_modules (no global install); does nothing when it is missing
or the file is outside frontend/. Prettier's own ignore rules and
--ignore-unknown decide which files it touches. Reads the hook JSON on stdin.
"""

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    payload = json.load(sys.stdin)
    path = payload.get("tool_input", {}).get("file_path") or ""
    frontend = Path(payload.get("cwd") or ".") / "frontend"
    prettier = frontend / "node_modules" / ".bin" / "prettier"
    target = Path(path)
    if not path or not prettier.exists() or frontend.resolve() not in target.resolve().parents:
        return 0
    result = subprocess.run([str(prettier), "--write", "--ignore-unknown", str(target)],
                            cwd=frontend, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"prettier failed on {target}:\n{result.stderr}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
