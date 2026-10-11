"""Initial isolated single-family schema."""
from alembic import op
from server.models import Base
revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    # Console sessions were introduced by revision 0002. Importing the current
    # model metadata must not create that later table in the initial revision.
    tables = [table for table in Base.metadata.sorted_tables if table.name != 'console_sessions']
    Base.metadata.create_all(op.get_bind(), tables=tables)

def downgrade():
    tables = [table for table in Base.metadata.sorted_tables if table.name != 'console_sessions']
    Base.metadata.drop_all(op.get_bind(), tables=tables)
