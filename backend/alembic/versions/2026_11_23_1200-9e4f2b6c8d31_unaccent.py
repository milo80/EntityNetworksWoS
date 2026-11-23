"""unaccent extension

Revision ID: 9e4f2b6c8d31
Revises: 7b3d1e9c2a45
Create Date: 2026-11-23 12:00:00

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '9e4f2b6c8d31'
down_revision: Union[str, Sequence[str], None] = '7b3d1e9c2a45'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Record filters ignore accents (REQ-REC-3 AC7): lower(unaccent(...)) on both the
    # cell and the term. A contrib extension shipped with the postgres images, and
    # trusted since PostgreSQL 13, so the database owner can create it.
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP EXTENSION IF EXISTS unaccent")
