import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, (...args: any[]) => any> = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, { exports, require: (name: string) => dependencies[name] || {}, ...globals });
  return exports;
}

async function main() {
  let actor: { id: string; role: string } | null = { id: 'admin-self', role: 'admin' };
  let where: unknown;
  let databaseReads = 0;
  const route = load('src/app/api/projects/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, options?: ResponseInit) => Response.json(body, options) } },
    '@/lib/auth/session': { getSession: async () => actor },
    '@/lib/prisma': { prisma: { project: { findMany: async (query: { where: unknown }) => { databaseReads++; where = query.where; return []; } } } },
    '@/lib/access/feature-guard': { isFeatureAllowed: () => true },
  });
  const request = (query: string, header = 'admin-self') => ({ nextUrl: new URL(`https://fixture.test/api/projects?${query}`), headers: new Headers({ 'x-app-session-user': header }) });
  assert.equal((await route.GET(request('lite=true&scope=owned&include_all=true'))).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(where)), { status: 'active', type: { not: 'system' }, owner_user_id: 'admin-self' },
    'owned scope binds the authenticated actor even when an admin also requests all');
  await route.GET(request('lite=true&scope=owned&include_archived=true'));
  assert.deepEqual(JSON.parse(JSON.stringify(where)), { status: { not: 'deleted' }, type: { not: 'system' }, owner_user_id: 'admin-self' });
  await route.GET(request('lite=true&include_all=true'));
  assert.deepEqual(JSON.parse(JSON.stringify(where)), { status: 'active' }, 'the separate admin directory keeps its original scope');
  const beforeDenied = databaseReads;
  assert.equal((await route.GET(request('lite=true&scope=owned', 'other-actor'))).status, 409);
  actor = null;
  assert.equal((await route.GET(request('lite=true&scope=owned'))).status, 401);
  assert.equal(databaseReads, beforeDenied, 'stale or anonymous actors never query the project catalog');

  const calls: Array<{ url: string; actor: string }> = [];
  const selector = load('src/lib/projects/selector-client.ts', {
    '@/lib/http/json-response': { readJsonResponse: (response: Response) => response.json() },
  }, { AbortSignal, Date, CustomEvent: class { constructor(public type: string, public options: unknown) {} },
    window: { dispatchEvent() {} }, fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, actor: new Headers(options.headers).get('x-app-session-user')! });
      return Response.json({ projects: [], capabilities: {} });
    } });
  await selector.readProjectSelectorCatalog('self', 'owned');
  await selector.readProjectSelectorCatalog('self');
  await selector.readProjectSelectorCatalog('self', 'owned');
  assert.equal(calls.length, 2, 'owned and admin catalogs cache separately');
  assert.ok(calls[0].url.includes('scope=owned') && !calls[0].url.includes('include_all=true'));
  assert.ok(calls[1].url.includes('include_all=true'));
  await selector.readProjectSelectorCatalog('other', 'owned');
  assert.equal(calls.at(-1)?.actor, 'other', 'accounts cannot borrow each other\'s catalog');
  selector.publishProjectCatalogChange({ ownerId: 'self', kind: 'created', projectId: 'new' });
  await selector.readProjectSelectorCatalog('self', 'owned');
  await selector.readProjectSelectorCatalog('self');
  assert.equal(calls.length, 5, 'a real catalog change invalidates both scopes for that actor');

  console.log(JSON.stringify({ passed: true, actualRouteAndCatalogModules: true, productionWrites: 0, networkCalls: 0, browserRuns: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
