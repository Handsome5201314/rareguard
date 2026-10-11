import os
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

def validate_test_database_url(value):
    if not value:
        raise pytest.UsageError('Set TEST_DATABASE_URL explicitly to a disposable local rareguard_test database')
    try:
        parsed = make_url(value)
    except (ArgumentError, ValueError, TypeError):
        raise pytest.UsageError('TEST_DATABASE_URL must be a valid PostgreSQL URL') from None
    # Query parameters can override host/dbname in the driver, so reject them.
    if (parsed.drivername != 'postgresql+psycopg' or
            parsed.host not in ('127.0.0.1', 'localhost', '::1') or
            parsed.database != 'rareguard_test' or parsed.query):
        raise pytest.UsageError('Tests only allow postgresql+psycopg on loopback, database rareguard_test, without URL query parameters')
    return value


# Never infer the test connection from an application or production DATABASE_URL.
# The dedicated database must already exist; fixture cleanup only runs here.
os.environ['DATABASE_URL'] = validate_test_database_url(os.environ.get('TEST_DATABASE_URL'))
from server.db import engine, Session
from server.models import Base, Credential, Consent, Device, uid
from server.main import app, digest
from fastapi.testclient import TestClient
assert engine.url.database == 'rareguard_test'
Base.metadata.create_all(engine)

@pytest.fixture()
def actors():
    with engine.begin() as conn:
        conn.execute(text('TRUNCATE '+','.join('"'+t.name+'"' for t in Base.metadata.sorted_tables)+' CASCADE'))
    ids=[]
    with Session() as db:
        family=uid()
        for i in range(3):
            token=uid();guardian=uid();fam=family if i<2 else uid()
            db.add(Credential(family=fam,guardian=guardian,name='test-'+str(i),token_hash=digest(token)))
            for scope in ('upload','remote_alerts','ai_analysis'):
                db.add(Consent(guardian=guardian,scope=scope,granted=True,version='demo-1'))
            ids.append({'headers':{'Authorization':'Bearer '+token},'family':fam,'guardian':guardian})
        d=Device(family=family,local_id=uid(),model='test-only',protocol='efe-mr11-reviewed-1')
        db.add(d);db.commit();device=d.id
    yield TestClient(app),ids,device
