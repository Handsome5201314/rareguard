"""Load project-local or explicitly selected configuration; never search for secrets."""
import json
import os
from pathlib import Path

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / '.env'
RUNTIME_KEYS = ('HERMES_BASE_URL', 'HERMES_API_KEY', 'HERMES_MODEL', 'HERMES_PROFILE',
                'HERMES_WEB_URL', 'HERMES_RESTRICTED_CONTEXT_CONFIRMED',
                'RAREGUARD_CONSOLE_USERNAME', 'RAREGUARD_CONSOLE_PASSWORD_HASH',
                'RAREGUARD_CONSOLE_FAMILY_ID', 'RAREGUARD_CONSOLE_URL', 'RAREGUARD_PUBLIC_BASE_URL')
CONFIG_KEYS = (*RUNTIME_KEYS, 'DATABASE_URL', 'TEST_DATABASE_URL', 'RAREGUARD_LOCAL_POSTGRES_PASSWORD')

def runtime_config(values):
    return {k: values[k] for k in RUNTIME_KEYS if k in values}

def read_config(path=None):
    selected = path or os.environ.get('RAREGUARD_CONFIG_FILE')
    path = Path(selected or DEFAULT_CONFIG)
    values = {}
    if selected or path.exists():
        lines = path.read_text(encoding='utf-8-sig').splitlines()
    else:
        lines = []
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise ValueError(f'Configuration line {number} must use KEY=value')
        key, value = line.split('=', 1)
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        values[key.strip()] = value
    # Process environment takes precedence; CI can run without creating .env.
    values.update({key: os.environ[key] for key in CONFIG_KEYS if key in os.environ})
    return values

def write_private(path, values):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(f'{key}={json.dumps(str(value), ensure_ascii=False)}\n' for key, value in values.items()), encoding='utf-8')
    if os.name != 'nt':
        path.chmod(0o600)

def local_environment(*, test=False):
    from urllib.parse import quote
    values = read_config()
    env = os.environ.copy()
    env.update(runtime_config(values))
    if test:
        if not values.get('TEST_DATABASE_URL'):
            raise ValueError('Set TEST_DATABASE_URL explicitly; application DATABASE_URL is never used for tests')
        env['TEST_DATABASE_URL'] = values['TEST_DATABASE_URL']
        env['DATABASE_URL'] = values['TEST_DATABASE_URL']
        return env
    password = values.get('RAREGUARD_LOCAL_POSTGRES_PASSWORD')
    if password:
        env['POSTGRES_PASSWORD'] = password
    if values.get('DATABASE_URL'):
        env['DATABASE_URL'] = values['DATABASE_URL']
    elif password:
        env['DATABASE_URL'] = 'postgresql+psycopg://rareguard:' + quote(password, safe='') + '@127.0.0.1:15438/rareguard'
    else:
        raise ValueError('Set DATABASE_URL or RAREGUARD_LOCAL_POSTGRES_PASSWORD')
    return env
