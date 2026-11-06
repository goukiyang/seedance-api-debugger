import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {}, checks = [];
let viewer;
const source = ts.transpileModule(fs.readFileSync('src/app/template-studio/page.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const imports = {
  'next/navigation': { redirect(url) { throw Object.assign(new Error('redirect'), { url }); } },
  '@/lib/image-studio/access': { canUseCompanyTemplates: user => user.canImage === true },
  '@/lib/access/external-role': { isExternalUser: user => user.external === true, externalFallbackPath: () => '/fallback' },
  '@/lib/auth/session': { getSession: async () => viewer },
  '@/components/template-studio/TemplateStudioShell': { default: 'workbench' },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
};
vm.runInNewContext(source, { exports, URLSearchParams, require(name) { assert.ok(name in imports, name); return imports[name]; } });
const page = exports.default;
viewer = null;
await assert.rejects(() => page({ searchParams: { type: 'image', moduleId: 'default-owner' } }),
  error => new URL(error.url, 'https://fixture.invalid').searchParams.get('next') === '/template-studio?type=image&moduleId=default-owner');
checks.push('login_preserves_explicit_template_destination');
viewer = { id: 'owner', role: 'admin', account_type: 'internal', canImage: true };
await assert.rejects(() => page({}), error => error.url === '/template-studio?type=image&view=covers');
checks.push('bare_workbench_opens_all_covers');
assert.equal((await page({ searchParams: { type: 'image', view: 'covers' } })).props.initialType, 'image');
checks.push('explicit_cover_entry_has_no_extra_redirect');
assert.equal((await page({ searchParams: { type: 'image', moduleId: 'default-owner' } })).props.initialType, 'image');
checks.push('named_image_template_is_preserved');
assert.equal((await page({ searchParams: { type: 'video', view: 'results', runId: 'original-run' } })).props.initialType, 'video');
checks.push('explicit_video_result_is_preserved');
viewer = { id: 'video-only', role: 'user', account_type: 'internal', canImage: false };
assert.equal((await page({})).props.initialType, 'video');
checks.push('video_only_account_is_not_sent_to_images');
viewer = { id: 'external', role: 'user', account_type: 'external', external: true, canImage: false };
await assert.rejects(() => page({}), error => error.url === '/fallback');
checks.push('existing_access_denial_is_preserved');
console.log(JSON.stringify({ passed: checks.length, checks, productionWrites: 0, browserRuns: 0, networkCalls: 0 }));
