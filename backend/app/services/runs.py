"""Turning a stored NetworkRun into a pipeline call."""

from __future__ import annotations

import dataclasses
from pathlib import Path

from pipeline.io import read_wos_files
from pipeline.relations import RELATIONS, prepare_articles

from ..schemas.api import PARAMS_BY_RELATION


def build_network(relation: str, params: dict, files: list[Path]) -> dict:
    """Run the pipeline for one relation. Raises on bad input (WoSReadError, KeyError...)."""
    build, params_cls = RELATIONS[relation]
    api_params = PARAMS_BY_RELATION[relation].model_validate(params)
    values = api_params.model_dump()
    max_authors = values.pop("max_authors")
    pipeline_params = dataclasses.replace(params_cls(), **values)

    articles = prepare_articles(read_wos_files(files), max_authors=max_authors)
    return build(articles, pipeline_params)
