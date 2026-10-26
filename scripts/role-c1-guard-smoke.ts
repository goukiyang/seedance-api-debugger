import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = '1f1f56c82a0078dc5d3229f3860547253c866750';
const patch = '/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-08-ai-collaboration-workflow/role-implementation/release-20261010/guard-suggestion.patch';
const scratch = path.resolve('.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(path.join(scratch, 'role-guard-'));
const archive = execFileSync('git', ['archive', '--format=tar', base], { maxBuffer: 100 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
execFileSync('/usr/bin/patch', ['-p1', '-i', patch, '-d', directory], { stdio: 'pipe' });
symlinkSync(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
const original = execFileSync('git', ['show', `${base}:src/lib/canvas-documents.ts`], { encoding: 'utf8' });
const guarded = readFileSync(path.join(directory, 'src/lib/canvas-documents.ts'), 'utf8');
const guardAddition = /function requireRoleCompatibleRelease\(document: \{ schema_version: number \}\) \{[\s\S]*?\n\}\n\n/;
const recovered = guarded.replace(guardAddition, '').replaceAll('  requireRoleCompatibleRelease(document);\n', '');
assert.equal(recovered, original, 'Guard must only add schema3 denial, no rewrite of old logic');
const driver = path.join(directory, 'guard-check.ts');
writeFileSync(driver, `import assert from 'node:assert/strict';
import { canvasDetail } from './src/lib/canvas-documents';
const document: any = { id:'synthetic', owner_user_id:'synthetic', project_id:null, title:'Synthetic', active_generation_node_id:null,
 status:'active', revision:1, schema_version:2, protocol_version:2, access_scope:'private', created_at:new Date(), updated_at:new Date(), document_json:'{}' };
assert.equal(canvasDetail(document).document_json, '{}');
assert.throws(() => canvasDetail({...document,schema_version:3}), (error:any) => error.status === 426 && error.code === 'role_rollback_guard');
console.log('PASS Guard permits ordinary v2 and rejects schema3 body without changing stored content');
`, { mode: 0o600 });
execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), '--tsconfig', path.join(directory, 'tsconfig.json'), driver],
  { cwd: directory, env: { ...process.env, DATABASE_URL: `file:${path.join(directory, 'empty-not-opened.db')}` }, stdio: 'inherit' });
const receipt = { base, directory, patchSha256: createHash('sha256').update(readFileSync(patch)).digest('hex'),
  guardedSourceSha256: createHash('sha256').update(guarded).digest('hex'), sourceOnlyGuard: true,
  normalV2Detail: true, schema3BodyBlocked: true, originalBuildProtected: false, guardBuildVerified: false,
  productionWrites: 0, note: 'Full source extracted locally; guard build and original production BUILD protection still required.' };
writeFileSync(path.join(directory, 'guard-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(`Evidence: ${path.join(directory, 'guard-receipt.json')}`);
