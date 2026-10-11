"""Local-only provisioning. Never returns credentials through a public admin API."""
import argparse
import os
import secrets
from datetime import timedelta
from .db import Session
from .models import Pairing, now, uid
from .main import digest

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--family', help='Existing family UUID for a second guardian')
    p.add_argument('--name', required=True)
    p.add_argument('--output', required=True, help='Private output file; do not print pairing codes in logs')
    a = p.parse_args()
    code = secrets.token_urlsafe(24); family = a.family or uid()
    with Session() as db:
        db.add(Pairing(code_hash=digest(code), family=family, name=a.name, expires=now()+timedelta(minutes=10)))
        db.commit()
    from pathlib import Path
    output = Path(a.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.touch(mode=0o600, exist_ok=True)
    if os.name != 'nt':
        output.chmod(0o600)
    output.write_text(f'family_id={family}\ncode={code}\nexpires_in_minutes=10\n', encoding='utf-8')
    print('Pairing code written to the requested private file; valid for 10 minutes.')
