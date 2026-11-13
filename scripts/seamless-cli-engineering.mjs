import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forwardSeamless } from '../ops/sd2-release.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-cli-continuation-'));
const entry = root + '/entry.mjs';
fs.writeFileSync(entry, `import fs from 'node:fs';
const [command,file]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(file));p.calls.push(command);fs.writeFileSync(file,JSON.stringify(p));
const first=p.calls.length===1;
const pending=p.mode==='pending'&&first;
const cut=p.mode==='cut-failure'||p.mode==='handoff'&&first;
const fatal=p.mode==='fatal';
console.log(JSON.stringify({status:pending?'pending':cut||fatal?'failed':'complete',publicHealthy:pending||cut,activeStep:pending?'drainOriginal':cut?'cutToCandidate':'startCanonical'}));
process.exitCode=pending?75:cut||fatal?1:0;
`);
try {
  for (const [mode, status, calls] of [
    ['pending', 0, ['release', 'resume-release']],
    ['handoff', 0, ['release', 'resume-release']],
    ['fatal', 1, ['release']],
    ['cut-failure', 1, ['release', 'resume-release']],
  ]) {
    const plan = root + '/' + mode + '.json'; fs.writeFileSync(plan, JSON.stringify({ mode, calls: [] }));
    const result = await forwardSeamless(entry, ['release', plan]);
    assert.equal(result.status, status); assert.deepEqual(JSON.parse(fs.readFileSync(plan)).calls, calls);
  }
  process.exitCode = 0;
  console.log('Actual CLI child processes: pending resumes automatically, HUP convergence retries once, fatal/repeated cut failures stop.');
} finally { fs.rmSync(root, { recursive: true }); }
