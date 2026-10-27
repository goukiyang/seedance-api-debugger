import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [root, revision] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Usage: node scripts/render-audit-billing-unit.mjs ABSOLUTE_RELEASE_ROOT EXACT_REVISION');
const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actual !== revision || /[\r\n%]/.test(root)) throw new Error('Release identity mismatch');
if (!fs.existsSync(path.join(root, 'src/lib/video/reconciler.ts'))) throw new Error('Release is not billing compatible');
const unit = fs.readFileSync(new URL('../ops/server/sd2/sd2-finalize-pending.service', import.meta.url), 'utf8');
process.stdout.write(unit.replace('@RELEASE_ROOT@', root));
