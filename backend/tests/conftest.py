from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WOS_DIR = REPO_ROOT / "data" / "wos"
GOLDEN_DIR = Path(__file__).parent / "fixtures" / "golden"


@pytest.fixture(scope="session")
def articles():
    """Prepared article-level df from the real WoS sample (skipped if data is absent)."""
    if not any(WOS_DIR.glob("*.xls")):
        pytest.skip(f"WoS sample not present in {WOS_DIR} (not committed to git)")
    from pipeline.io import read_wos_folder
    from pipeline.relations import prepare_articles
    return prepare_articles(read_wos_folder(WOS_DIR))
