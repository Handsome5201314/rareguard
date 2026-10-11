"""Exercise the complete revision sequence in a fresh disposable schema."""
import importlib.util
from pathlib import Path
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import inspect, text
from server.db import engine
from server.models import Base


def revision(name):
    path = Path(__file__).resolve().parents[1] / 'migrations' / 'versions' / name
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fresh_schema_supports_initial_and_console_session_revisions():
    schema = 'migration_test_' + uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
        initial = revision('0001_initial.py')
        console = revision('0002_console_sessions.py')
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            initial.upgrade()
            assert 'console_sessions' not in inspect(connection).get_table_names(schema=schema)
            console.upgrade()
            assert set(inspect(connection).get_table_names(schema=schema)) == set(Base.metadata.tables)
            console.downgrade()
            initial.downgrade()
            assert inspect(connection).get_table_names(schema=schema) == []
        connection.execute(text(f'DROP SCHEMA "{schema}"'))
