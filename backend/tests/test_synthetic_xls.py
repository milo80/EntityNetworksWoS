"""The committed synthetic .xls (uploaded by CI's smoke and browser tests) matches the fixture."""

from pathlib import Path

import pandas as pd

from pipeline.io import read_wos_files

from .fixtures.synthetic_wos import synthetic_wos_df

XLS = Path(__file__).parent / "fixtures" / "synthetic_wos.xls"


def test_synthetic_xls_matches_fixture():
    expected = synthetic_wos_df()
    got = read_wos_files([XLS])
    assert list(got.columns) == list(expected.columns), "regenerate: scripts/make_synthetic_xls.py"
    # Empty cells read back as NaN (as in real exports), the fixture has None.
    def empties_as_none(df):
        return df.astype(object).where(df.notna(), None)
    pd.testing.assert_frame_equal(empties_as_none(got), empties_as_none(expected), check_dtype=False)
