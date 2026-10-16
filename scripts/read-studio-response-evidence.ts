import 'dotenv/config';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStudioResponseEvidence } from '../src/lib/image-studio/response-evidence';
import type { StudioReceipt } from '../src/lib/image-studio/delivery';

// Server-local maintenance read only. No HTTP route, generation, state repair or credential lookup.
async function main() {
  const [taskId, requestId] = process.argv.slice(2);
  if (process.argv.length !== 4 || !/^[a-zA-Z0-9-]{1,120}$/.test(taskId || '')
    || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId || '')) throw new Error('exact_task_and_request_required');
  const configured = process.env.DATABASE_URL;
  if (!configured?.startsWith('file:') || configured.includes('?') || configured.includes('#')) throw new Error('readonly_sqlite_configuration_required');
  const database = await fs.realpath(path.resolve(process.cwd(), configured.slice(5)));
  const storage = await fs.realpath(path.join(process.cwd(), 'storage'));
  if (process.env.NODE_ENV === 'production' && (!database.startsWith('/data/') || !storage.startsWith('/data/'))) {
    throw new Error('production_data_mount_required');
  }
  // Only the exact task and the identity-bearing JSON fields are selected; prompt and input bytes never leave SQLite.
  const query = String.raw`
import sqlite3,json,sys
db,task_id,request_id=sys.argv[1:]
c=sqlite3.connect('file:'+db+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
r=c.execute('SELECT id,owner_id,batch_id,fingerprint,model,json_extract(snapshot_json,\'$.model\') AS snapshot_model,json_extract(snapshot_json,\'$.requestId\') AS request_id,json_extract(snapshot_json,\'$.imageChannel\') AS image_channel FROM ImageStudioTask WHERE id=?',(task_id,)).fetchone()
if not r or r['request_id']!=request_id:raise RuntimeError('exact_task_request_mismatch')
t={k:r[k] for k in ['id','owner_id','batch_id','fingerprint','model']}
t['snapshot_json']=json.dumps({'requestId':r['request_id'],'model':r['snapshot_model'],'imageChannel':json.loads(r['image_channel']) if r['image_channel'] else None})
c.rollback();c.close();print(json.dumps(t))
`;
  const task = JSON.parse(execFileSync('python3', ['-c', query, database, taskId, requestId], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024,
  }));
  let receipt: StudioReceipt | undefined;
  for (const folder of ['studio-billing', 'studio-delivery']) {
    const filename = path.join(storage, folder, taskId, 'request.json');
    try {
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) throw new Error('private_request_receipt_required');
        receipt = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!receipt) throw new Error('original_request_receipt_required');
  const evidence = await readStudioResponseEvidence(task, receipt);
  process.stdout.write(JSON.stringify({ readOnly: true, taskId, requestId, evidence }, null, 2) + '\n');
}

main().catch(() => { process.stderr.write('response_evidence_read_refused\n'); process.exitCode = 1; });
