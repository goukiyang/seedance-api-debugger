import { execFileSync } from 'node:child_process';
import { decodeDescriptionOutput, DescriptionContractError, validateDescriptionConstraints } from './description-contract';

try {
  const input = JSON.parse(execFileSync('python3', ['-c', `
import hashlib, json, sqlite3
request_id = 'a5c81fab-6851-4bfa-b2b9-0e0149d08190'
db = sqlite3.connect('file:/data/video-api-debugger/var-lib/dev.db?mode=ro', uri=True)
db.execute('PRAGMA query_only=ON')
rows = db.execute("SELECT key, value_json FROM PlatformSetting WHERE key LIKE 'avatar:v1:%:parse-attempt:%' AND instr(value_json, ?) > 0", (request_id,)).fetchall()
matches = [(key, json.loads(raw)) for key, raw in rows if json.loads(raw).get('requestId') == request_id]
if len(matches) != 1:
    print(json.dumps({'missing': 'unique-attempt'}))
else:
    key, attempt = matches[0]
    prefix, digest = key.rsplit(':parse-attempt:', 1)
    response = db.execute('SELECT value_json FROM PlatformSetting WHERE key = ?', (prefix + ':parse-response:' + digest + '-' + attempt.get('responseId', request_id),)).fetchone()
    def find_descriptions(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k == 'description' and isinstance(v, str): yield v.strip()
                else: yield from find_descriptions(v)
        elif isinstance(value, list):
            for v in value: yield from find_descriptions(v)
    descriptions = set()
    for (raw,) in db.execute('SELECT value_json FROM PlatformSetting WHERE key LIKE ?', (prefix + ':%',)):
        try:
            for text in find_descriptions(json.loads(raw)):
                if hashlib.sha256(('parser-1.0.0:' + text).encode()).hexdigest() == digest: descriptions.add(text)
        except (ValueError, TypeError): pass
    if response is None: print(json.dumps({'missing': 'saved-reply'}))
    elif len(descriptions) != 1: print(json.dumps({'missing': 'matching-original-description', 'state': attempt.get('state')}))
    else: print(json.dumps({'description': next(iter(descriptions)), 'content': json.loads(response[0])['content'], 'state': attempt.get('state')}))
db.close()
`], { encoding: 'utf8', maxBuffer: 1048576 }));
  if (input.missing) console.log(JSON.stringify({ passed: false, unavailable: input.missing, state: input.state, readonly: true, modelCalls: 0, writes: 0 }));
  else {
    try {
      validateDescriptionConstraints(decodeDescriptionOutput(input.content), input.description);
      console.log(JSON.stringify({ passed: true, state: input.state, readonly: true, modelCalls: 0, writes: 0 }));
    } catch (error) {
      console.log(JSON.stringify({ passed: false, failureField: error instanceof DescriptionContractError ? error.field : 'response', readonly: true, modelCalls: 0, writes: 0 }));
    }
  }
} catch {
  console.log(JSON.stringify({ passed: false, unavailable: 'readonly-inspection-error', readonly: true, modelCalls: 0, writes: 0 }));
  process.exitCode = 1;
}
