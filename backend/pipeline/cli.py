"""Command line: build network JSON files from a folder of WoS exports.

    python -m pipeline.cli ../data/wos -o out/            # all relations, default params
    python -m pipeline.cli ../data/wos -o out/ -r author --top-n 300
"""

from __future__ import annotations

import argparse
import dataclasses
import logging
from pathlib import Path

from .io import read_wos_folder, write_network_json
from .relations import RELATIONS, prepare_articles

OUTPUT_NAMES = {"author": "network_author.json",
                "institution_keywords": "network_institution_keywords.json"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wos_folder", type=Path, help="folder with WoS .xls exports")
    parser.add_argument("-o", "--out", type=Path, default=Path("."), help="output folder")
    parser.add_argument("-r", "--relation", choices=sorted(RELATIONS), action="append",
                        help="relation(s) to build (default: all)")
    parser.add_argument("--max-authors", type=int, default=15,
                        help="drop articles with more authors than this")
    parser.add_argument("--top-n", type=int, help="override sample size for every relation")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING if args.quiet else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")

    articles = prepare_articles(read_wos_folder(args.wos_folder), max_authors=args.max_authors)
    args.out.mkdir(parents=True, exist_ok=True)

    for name in args.relation or list(RELATIONS):
        build, params_cls = RELATIONS[name]
        params = params_cls()
        if args.top_n is not None:
            params = dataclasses.replace(params, top_n=args.top_n)
        path = args.out / OUTPUT_NAMES[name]
        write_network_json(build(articles, params), path)
        logging.getLogger(__name__).info("Wrote %s", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
