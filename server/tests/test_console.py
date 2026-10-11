import hashlib
from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from server.main import app
from server.console import COOKIE, CSRF_COOKIE, attempts, hashed
from server.db import Session
from server.models import ConsoleSession
from test_contract import sample, batch, send

PREFIX = '/console'
ORIGIN = {'Origin': 'https://rareguard.tongyimoheai.top'}

@pytest.fixture
def console(actors, monkeypatch):
    original, actors_list, device = actors
    salt = '01' * 16
    password_hash = hashlib.pbkdf2_hmac('sha256', b'test-password', bytes.fromhex(salt), 100000).hex()
    for key, value in {'RAREGUARD_PUBLIC_BASE_URL':'https://rareguard.tongyimoheai.top/api',
            'RAREGUARD_CONSOLE_URL':'https://rareguard.tongyimoheai.top/console',
            'RAREGUARD_CONSOLE_USERNAME':'test-user', 'RAREGUARD_CONSOLE_FAMILY_ID':actors_list[0]['family'],
            'RAREGUARD_CONSOLE_PASSWORD_HASH':'pbkdf2_sha256$100000$'+salt+'$'+password_hash}.items():
        monkeypatch.setenv(key, value)
    attempts.clear()
    client = TestClient(app, base_url='https://rareguard.tongyimoheai.top')
    return client, original, actors_list, device

def login(client):
    return client.post(PREFIX+'/login',headers=ORIGIN,json={'username':'test-user','password':'test-password'})

def write_headers(client):
    return {**ORIGIN, 'X-CSRF-Token':client.cookies.get(CSRF_COOKIE)}

def test_console_auth_and_secure_cookies(console):
    c, original, a, d = console
    assert c.get(PREFIX+'/data').status_code == 401
    assert c.get(PREFIX, follow_redirects=False).headers['location'] == PREFIX+'/login'
    assert c.get(PREFIX+'/data',headers=a[0]['headers']).status_code == 401
    assert c.post(PREFIX+'/login',headers=ORIGIN,json={'username':'test-user','password':'wrong'}).status_code == 401
    r = login(c); assert r.status_code == 200
    cookies = r.headers.get_list('set-cookie')
    assert all('Secure' in v and 'SameSite=strict' in v and 'Path='+PREFIX in v for v in cookies)
    assert 'HttpOnly' in next(v for v in cookies if v.startswith(COOKIE+'='))
    assert c.get(PREFIX+'/data').status_code == 200
    page = c.get(PREFIX)
    assert page.status_code == 200 and 'script-src \'self\'' in page.headers['content-security-policy']
    assert c.get(PREFIX+'/assets/console.js').status_code == 200
    assert c.get(PREFIX+'/assets/config.py').status_code == 404

def test_console_csrf_origin_and_logout_replay(console):
    c, *_ = console
    assert c.post(PREFIX+'/login',json={'username':'test-user','password':'test-password'}).status_code == 403
    assert c.post(PREFIX+'/login',headers={'Origin':'https://tongyimoheai.top'},json={'username':'test-user','password':'test-password'}).status_code == 403
    assert login(c).status_code == 200
    token = c.cookies.get(COOKIE)
    assert c.post(PREFIX+'/pairings',headers=ORIGIN,json={'name':'test'}).status_code == 403
    assert c.post(PREFIX+'/pairings',headers={**write_headers(c),'Origin':'https://other.invalid'},json={'name':'test'}).status_code == 403
    assert c.post(PREFIX+'/logout',headers=write_headers(c),json={}).status_code == 200
    assert c.get(PREFIX+'/data',headers={'Cookie':COOKIE+'='+token}).status_code == 401

def test_console_family_isolation_and_single_use_pairing(console):
    c, original, a, d = console
    other = original.post('/v1/devices',headers=a[2]['headers'],json={'local_id':'00000000-0000-4000-8000-000000000003','model':'private-other-family','protocol_version':'efe-mr11-reviewed-1'}).json()['device_id']
    assert send(original,a[0],batch(d,[sample()])).status_code == 200
    assert send(original,a[2],batch(other,[sample()])).status_code == 200
    login(c)
    data = c.get(PREFIX+'/data').json()
    assert [r['id'] for r in data['devices']] == [d]
    assert len(data['latest_samples']) == 1
    assert all(g['name'] != 'test-2' for g in data['guardians'])
    r = c.post(PREFIX+'/pairings',headers=write_headers(c),json={'name':'same-family'}); assert r.status_code == 200
    code = r.json()['code']
    exchange = original.post('/v1/pairings/exchange',json={'code':code})
    assert exchange.status_code == 200 and exchange.json()['family_id'] == a[0]['family']
    assert original.post('/v1/pairings/exchange',json={'code':code}).status_code == 401

def test_console_expiry_and_brute_force_bound(console):
    c, *_ = console; login(c)
    with Session() as db:
        row = db.get(ConsoleSession,hashed(c.cookies.get(COOKIE)));row.expires -= timedelta(hours=7);db.commit()
    assert c.get(PREFIX+'/data').status_code == 401
    attempts.clear()
    for _ in range(10):
        assert c.post(PREFIX+'/login',headers=ORIGIN,json={'username':'test-user','password':'wrong'}).status_code == 401
    assert login(c).status_code == 429
