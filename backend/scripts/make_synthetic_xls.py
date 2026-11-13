"""Write tests/fixtures/synthetic_wos.xls: the synthetic WoS table as a real legacy .xls.

The WoS sample in data/wos/ is licensed and never committed, so CI uploads this
file instead (smoke test and Playwright). It is committed; regenerate only when
tests/fixtures/synthetic_wos.py changes:

    .venv/bin/pip install xlwt==1.3.0      # one-off, not a project dependency
    .venv/bin/python scripts/make_synthetic_xls.py

tests/test_synthetic_xls.py checks the committed file still matches the fixture.
"""

from __future__ import annotations

import sys
from pathlib import Path

import xlwt

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from pipeline.io import WOS_SHEET
from tests.fixtures.synthetic_wos import synthetic_wos_df

OUT = BACKEND / "tests" / "fixtures" / "synthetic_wos.xls"


def main() -> None:
    df = synthetic_wos_df()
    book = xlwt.Workbook(encoding="utf-8")
    sheet = book.add_sheet(WOS_SHEET)
    for col, name in enumerate(df.columns):
        sheet.write(0, col, name)
    for row, values in enumerate(df.itertuples(index=False), start=1):
        for col, value in enumerate(values):
            if value is not None:
                sheet.write(row, col, value)
    book.save(str(OUT))
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
