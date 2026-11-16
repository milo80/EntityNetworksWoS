"""PreToolUse hook: refuse file-tool edits to files that hold real secrets.

deploy/.env and infra/**/terraform.tfvars are git-ignored and hold real passwords
and keys; their *.example siblings stay editable. Reads the hook JSON on stdin.
Shell commands are not covered (a permission prompt still guards those).
"""

import json
import sys
from pathlib import PurePosixPath

PROTECTED = ("deploy/.env", "infra/**/terraform.tfvars")


def main() -> int:
    payload = json.load(sys.stdin)
    path = payload.get("tool_input", {}).get("file_path") or ""
    root = payload.get("cwd") or ""
    p = PurePosixPath(path)
    try:
        rel = p.relative_to(root) if root and p.is_absolute() else p
    except ValueError:
        return 0  # outside the project
    if any(rel.full_match(pattern) for pattern in PROTECTED):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"{rel} holds real secrets: the user edits it by hand.",
        }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
