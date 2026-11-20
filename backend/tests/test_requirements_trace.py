"""Every acceptance criterion in docs/requirements.md points to tests that exist."""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REQUIREMENTS = REPO / "docs" / "requirements.md"

AC_LINE = re.compile(r"^- AC\d+:")
REF = re.compile(r"`([\w./-]+\.(?:py|tsx?))::([^`]+)`")


def _criteria() -> list[str]:
    return [line for line in REQUIREMENTS.read_text().splitlines() if AC_LINE.match(line)]


def _exists(path: str, name: str) -> bool:
    file = REPO / path
    if not file.is_file():
        return False
    text = file.read_text()
    if path.endswith(".py"):
        return re.search(rf"^(async )?def {re.escape(name)}\(", text, re.MULTILINE) is not None
    return f'"{name}"' in text


def test_requirements_have_criteria() -> None:
    assert len(_criteria()) > 20


def test_every_criterion_names_a_test() -> None:
    missing = [line for line in _criteria() if not REF.search(line)]
    assert not missing, f"acceptance criteria without tests: {missing}"


def test_every_named_test_exists() -> None:
    gone = [
        f"{path}::{name}"
        for line in _criteria()
        for path, name in REF.findall(line)
        if not _exists(path, name)
    ]
    assert not gone, f"docs/requirements.md names tests that don't exist: {gone}"
