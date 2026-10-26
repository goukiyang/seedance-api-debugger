"""Exercise the locked production script in a synthetic, explicitly mapped environment."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys
import tempfile
from unittest.mock import patch


def main():
    script = Path(sys.argv[1]).resolve()
    sql = Path('prisma/migrations/20261010040000_canvas_roles/migration.sql').resolve()
    assert hashlib.sha256(script.read_bytes()).hexdigest() == '1dd8b69a69a4986d1f485652fc9ad0ed61229cfc8ae699c17cd82a41930297d5'
    module = runpy.run_path(str(script), run_name='isolated_role_ddl_script')
    function = module['main']
    original = function.__globals__
    scratch = Path('.role-tests').resolve()
    scratch.mkdir(mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='role-ddl-script-', dir=scratch))
    db = directory / 'synthetic.db'
    with sqlite3.connect(db) as connection:
        connection.execute('CREATE TABLE SyntheticOld(id INTEGER PRIMARY KEY, value TEXT)')
        connection.execute("INSERT INTO SyntheticOld VALUES(1,'synthetic-only')")
    args = ['isolated', '--db', str(db), '--sql', str(sql), '--backup-directory', str(directory / 'backup'), '--expected-inode', str(db.stat().st_ino)]
    checks = []

    def invoke(arguments, failure=None):
        output = io.StringIO()
        with patch.object(sys, 'argv', arguments), contextlib.redirect_stdout(output):
            if failure:
                try:
                    function()
                except RuntimeError as error:
                    assert failure in str(error), str(error)
                else:
                    raise AssertionError('Expected safe rejection: ' + failure)
            else:
                function()
        return output.getvalue()

    invoke(args, 'exact human authorization')
    invoke(args + ['--approved'], 'Unexpected database')
    checks.append('Unmodified script rejects missing approval and every non-production database')

    # These are test-only environment mappings, not changes to the locked script.
    # All actual connections/backups still point to the fresh synthetic file above.
    original['EXPECTED_DB'] = str(db)
    concrete_path = type(Path())

    class MappedPath(concrete_path):
        def resolve(self, *a, **kw):
            resolved = super().resolve(*a, **kw)
            if resolved == directory / 'backup':
                return concrete_path('/data/video-api-debugger/role-maintenance/synthetic-backup')
            return resolved

    original['Path'] = MappedPath
    mount = {'filesystems': [{'source': '/dev/vdb', 'fstype': 'ext4', 'options': 'rw'}]}
    disk = os.statvfs(directory)

    def findmnt(command, **kwargs):
        assert command == ['findmnt', '-J', '/data']
        return json.dumps(mount)

    approved = args + ['--approved']
    with patch('subprocess.check_output', findmnt), patch('os.statvfs', return_value=disk):
        wrong_inode = approved.copy()
        wrong_inode[wrong_inode.index('--expected-inode') + 1] = '-1'
        invoke(wrong_inode, 'Database identity changed')
        mount['filesystems'][0]['source'] = '/dev/not-data'
        invoke(approved, 'Real writable data mount')
        mount['filesystems'][0]['source'] = '/dev/vdb'
        receipt = json.loads(invoke(approved))
    assert receipt['state'] == 'committed' and len(receipt['newTables']) == 10
    assert receipt['existingRowWrites'] == 0 and receipt['workersStopped'] is False
    assert (directory / 'backup' / 'before.db').stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(db) as connection:
        assert connection.execute('SELECT * FROM SyntheticOld').fetchall() == [(1, 'synthetic-only')]
        assert connection.execute('PRAGMA quick_check').fetchall() == [('ok',)]
    with sqlite3.connect(directory / 'backup' / 'before.db') as backup:
        assert backup.execute('SELECT * FROM SyntheticOld').fetchall() == [(1, 'synthetic-only')]
        assert backup.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE 'CanvasRole%'").fetchone()[0] == 0
    checks.append('Mapped synthetic mount/inode gate, real online backup, fixed SQL transaction and unchanged old row pass')
    evidence = {'syntheticOnly': True, 'productionWrites': 0, 'scriptHashUnchanged': True,
                'environmentMappings': ['EXPECTED_DB points to synthetic file', 'findmnt/statvfs synthetic data mount', 'backup resolve prefix only'],
                'checks': checks, 'note': 'Not a production execution or production mount proof.'}
    path = directory / 'script-receipt.json'
    path.write_text(json.dumps(evidence, indent=2))
    path.chmod(0o600)
    for check in checks:
        print('PASS ' + check)
    print('Evidence: ' + str(path))


if __name__ == '__main__':
    main()
