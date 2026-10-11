"""Local isolated runtime. Secrets are generated into ignored private files, never stdout."""
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
os.chdir(root)
from config import local_environment, write_private, runtime_config
os.environ.update(local_environment(test=sys.argv[1:] == ['test']))
if sys.argv[1:] in (['database'], ['compose']):
    if not os.environ.get('POSTGRES_PASSWORD'):
        raise SystemExit('Set RAREGUARD_LOCAL_POSTGRES_PASSWORD to use the local Docker database')
    write_private(root / 'runtime' / 'compose.env', {'POSTGRES_PASSWORD': os.environ['POSTGRES_PASSWORD']})
    write_private(root / 'runtime' / 'app.env', runtime_config(os.environ))
if sys.argv[1:] == ['database']:
    subprocess.run(['docker', 'compose', '--env-file', 'runtime/compose.env', '-p', 'rareguard-development', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'up', '-d', 'database'], check=True)
elif sys.argv[1:] == ['migrate']:
    subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
elif sys.argv[1:] == ['serve']:
    subprocess.run([sys.executable, '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '18080', '--no-access-log'], check=True)
elif sys.argv[1:] == ['compose']:
    # Hermes addresses are used exactly as configured, with no tunnel-specific rewrite.
    subprocess.run(['docker', 'compose', '--env-file', 'runtime/compose.env', '-p', 'rareguard-development', 'up', '-d', '--build'], check=True)
elif sys.argv[1:] == ['test']:
    subprocess.run([sys.executable, '-m', 'pytest', '-q'], check=True)
else:
    subprocess.run([sys.executable, *sys.argv[1:]], check=True)
