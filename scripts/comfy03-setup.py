"""Create a NEW isolated database only; never migrate an existing/production DB."""
from pathlib import Path
import sqlite3
import subprocess

root = Path(__file__).resolve().parents[1]
target = root / 'storage/comfy03-isolated/site.db'
target.parent.mkdir(parents=True, exist_ok=True)
if target.exists():
    raise SystemExit('Isolated database already exists; refusing to replace it.')
result = subprocess.run(['node', 'node_modules/prisma/build/index.js', 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], cwd=root, capture_output=True, check=True)
# Exclusive creation protects against concurrent setup and never overwrites an existing DB.
with target.open('xb'):
    pass
with sqlite3.connect(target) as db:
    db.executescript(result.stdout.decode('utf-8'))
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
print('Created isolated SQLite database; no production database was accessed.')
