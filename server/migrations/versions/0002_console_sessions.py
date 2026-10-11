"""Revocable private console sessions."""
from alembic import op
import sqlalchemy as sa
revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('console_sessions',
        sa.Column('token_hash', sa.String(64), primary_key=True),
        sa.Column('csrf_hash', sa.String(64), nullable=False),
        sa.Column('family', sa.String(36), nullable=False),
        sa.Column('expires', sa.DateTime(timezone=True), nullable=False))

def downgrade(): op.drop_table('console_sessions')
