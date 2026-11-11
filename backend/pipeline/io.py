"""Reading WoS exports and writing network JSON."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path

import pandas as pd

log = logging.getLogger(__name__)

WOS_SHEET = "savedrecs"


class WoSReadError(RuntimeError):
    """A WoS export could not be read."""


def read_wos_files(paths: Iterable[str | Path], sheet_name: str = WOS_SHEET) -> pd.DataFrame:
    """Read WoS .xls exports and concatenate them into one article-level df.

    Files are read in sorted path order so the result (and every network built
    from it) is reproducible regardless of filesystem listing order.
    """
    paths = sorted(Path(p) for p in paths)
    if not paths:
        raise WoSReadError("No WoS files given")

    dfs = []
    for path in paths:
        try:
            df = pd.read_excel(path, sheet_name=sheet_name, engine="calamine")
        except Exception as exc:  # the reader raises a variety of types
            raise WoSReadError(f"Could not read {path.name}: {exc}") from exc
        log.info("Read %s - %d rows", path.name, len(df))
        dfs.append(df)

    combined = pd.concat(dfs, ignore_index=True)
    log.info("Combined dataframe: %d total rows", len(combined))
    return combined


def read_wos_folder(folder: str | Path, pattern: str = "*.xls") -> pd.DataFrame:
    """Read every WoS export in ``folder`` matching ``pattern``."""
    return read_wos_files(Path(folder).glob(pattern))


def write_network_json(network: dict, path: str | Path) -> None:
    """Write a network dict in the same format the legacy script produced."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(network, f, indent=2, ensure_ascii=False)
