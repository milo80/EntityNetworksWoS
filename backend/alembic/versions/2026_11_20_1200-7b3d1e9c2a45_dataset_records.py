"""dataset records

Revision ID: 7b3d1e9c2a45
Revises: 5c2e9a7d4f10
Create Date: 2026-11-20 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '7b3d1e9c2a45'
down_revision: Union[str, Sequence[str], None] = '5c2e9a7d4f10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Filled by the worker: when it profiles an upload, and for older datasets
    # when it refreshes their profile (PROFILE_VERSION 5).
    op.create_table('dataset_records',
    sa.Column('dataset_id', sa.Integer(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.ForeignKeyConstraint(['dataset_id'], ['datasets.id'], name=op.f('fk_dataset_records_dataset_id_datasets'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('dataset_id', 'position', name=op.f('pk_dataset_records'))
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('dataset_records')
