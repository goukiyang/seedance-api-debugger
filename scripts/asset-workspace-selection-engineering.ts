import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';

const root = process.cwd(), requirePackage = createRequire(path.join(root, 'package.json'));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-workspace-selection-'));
const sourceSha256: Record<string, string> = {}, cache = new Map<string, { exports: any }>(), modules = new Map<string, unknown>();
const checks: string[] = [];
let forbiddenCalls = 0, handlerPosts = 0;
const source = (file: string) => { const bytes = fs.readFileSync(path.join(root, file));
  sourceSha256[file] = createHash('sha256').update(bytes).digest('hex'); return bytes.toString(); };
function load(file: string): any {
  const absolute = path.resolve(root, file); if (cache.has(absolute)) return cache.get(absolute)!.exports;
  const mod = { exports: {} }; cache.set(absolute, mod);
  const code = ts.transpileModule(source(file), { fileName: absolute, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const localRequire = (name: string) => {
    if (modules.has(name)) return modules.get(name);
    if (name.startsWith('@/') || name.startsWith('.')) {
      const resolved = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(absolute), name);
      const next = [resolved + '.ts', resolved + '.tsx', path.join(resolved, 'index.ts')].find(fs.existsSync);
      if (!next) throw Error(`Missing fixture source ${name}`);
      return load(path.relative(root, next));
    }
    return requirePackage(name);
  };
  Function('require', 'module', 'exports', '__filename', '__dirname', code)(localRequire, mod, mod.exports, absolute, path.dirname(absolute));
  return mod.exports;
}
function declaration(file: string, name: string, bindings: Record<string, unknown>) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name);
  const code = ts.transpileModule(ts.isFunctionDeclaration(found) ? `${found.getText(ast)}\nmodule.exports = ${name}` : `module.exports = ${found.getText(ast)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: undefined as any };
  Function(...Object.keys(bindings), 'module', 'exports', code)(...Object.values(bindings), mod, {});
  return mod.exports;
}
async function main() {
  source('scripts/asset-workspace-selection-engineering.ts');
  process.env.DATABASE_URL = `file:${path.join(folder, 'synthetic.db')}`;
  process.env.SITE_PUBLIC_BASE_URL = 'https://site.fixture.invalid';
  const push = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], {
    cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(push.status, 0, JSON.stringify({ stdout: push.stdout, stderr: push.stderr, error: push.error?.message }));
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
  const originalCwd = process.cwd(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { forbiddenCalls++; throw Error('External network prohibited'); };
  class AuthError extends Error { constructor(message: string, public status = 403) { super(message); } }
  let actor: any = { id: 'fixture-owner', name: 'Fixture Owner', username: 'fixture-owner', email: 'owner@example.invalid', role: 'user',
    account_type: 'internal', user_profile: 'other', feature_profile_id: null, status: 'active', expires_at: null };
  modules.set('server-only', {}); modules.set('@/lib/prisma', { prisma: db });
  modules.set('@/lib/auth/session', { AuthError, getSession: async () => actor });
  try {
    process.chdir(folder);
    fs.mkdirSync(path.join(folder, 'public/uploads/assets'), { recursive: true });
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=', 'base64');
    for (const id of ['image', 'shared', 'anchor']) fs.writeFileSync(path.join(folder, `public/uploads/assets/${id}.png`), tinyPng);
    const videoPath = path.join(folder, 'public/uploads/assets/video.mp4');
    const ffmpeg = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:r=10', '-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
    for (const id of ['fixture-owner', 'fixture-sharer', 'fixture-other']) await db.user.create({ data: { id, name: id, username: id, email: `${id}@example.invalid`, password_hash: 'fixture-only' } });
    for (const [id, type, owner] of [['image', 'image', actor.id], ['video', 'video', actor.id], ['anchor', 'image', actor.id], ['shared', 'image', 'fixture-sharer']] as const) {
      const ext = type === 'video' ? 'mp4' : 'png';
      await db.asset.create({ data: { id, owner_id: owner, type, original_url: `https://site.fixture.invalid/uploads/assets/${id}.${ext}`, file_name: `${id}.${ext}`,
        mime_type: type === 'video' ? 'video/mp4' : 'image/png', file_size: fs.statSync(path.join(folder, `public/uploads/assets/${id}.${ext}`)).size, status: 'active' } });
    }
    await db.asset.create({ data: { id: 'other-video', owner_id: 'fixture-other', type: 'video', original_url: 'https://site.fixture.invalid/uploads/assets/video.mp4', file_name: 'other-video.mp4', mime_type: 'video/mp4', file_size: fs.statSync(videoPath).size, status: 'active' } });
    await db.referenceAlbum.create({ data: { id: 'shared-album', owner_user_id: 'fixture-sharer', name: 'Shared Fixture', visibility: 'shared' } });
    await db.referenceImage.create({ data: { id: 'shared-reference', album_id: 'shared-album', owner_user_id: 'fixture-sharer', asset_id: 'shared', url: 'https://site.fixture.invalid/uploads/assets/shared.png' } });
    await db.albumShare.create({ data: { album_id: 'shared-album', grantee_type: 'user', grantee_id: actor.id, permissions_json: JSON.stringify({ view: true, use: true, copy: true }), created_by: 'fixture-sharer' } });
    const workspace = load('src/lib/assets/workspace.ts');
    const { id: workspaceId } = await workspace.getOrCreateWorkspace('fixture-tab', actor.id);
    const anchor = await db.workspaceAsset.create({ data: { workspace_id: workspaceId, asset_id: 'anchor', sort_order: 42, role: 'first_frame' } });
    const handler = load('src/app/api/workspace/assets/route.ts').POST;
    const sessionModule = load('src/lib/http/upload-session.ts'); sessionModule.setUploadSessionOwner(actor.id);
    const storage = new Map<string, string>(), posts: any[] = [];
    const storageApi = { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
    let loseResponse = false, changeAccount = false;
    const post = async (url: string, init: RequestInit) => {
      assert.equal(url, '/api/workspace/assets'); assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body)); posts.push(body); handlerPosts++;
      assert.equal(new Headers(init.headers).get('x-upload-owner-id'), body.ownerId);
      const { NextRequest } = requirePackage('next/server');
      const response = await handler(new NextRequest(`https://site.fixture.invalid${url}`, init));
      if (changeAccount) sessionModule.setUploadSessionOwner('fixture-other');
      if (loseResponse) { loseResponse = false; throw Error('fixture response lost after commit'); }
      return response;
    };
    const association = declaration('src/lib/hooks/useWorkspace.ts', 'postWorkspaceAssociation', {
      uploadSession: sessionModule.uploadSession, TextEncoder, crypto: webcrypto, sessionStorage: storageApi, fetch: post, AbortSignal,
      readJsonResponse: load('src/lib/http/json-response.ts').readJsonResponse, WORKSPACE_INVALID_JSON_MESSAGE: 'fixture JSON error',
    });
    const imagePredicate = declaration('src/app/assets/page.tsx', 'isReusableImageItem', {});
    const workspacePredicate = declaration('src/app/assets/page.tsx', 'isWorkspaceReusableItem', { isReusableImageItem: imagePredicate });
    const item = (id: string, source: string, kind: string, extra = {}) => ({ id, source, kind, assetId: source === 'asset' ? id : null,
      referenceImageId: source === 'reference_image' ? 'shared-reference' : null, status: 'active', previewUrl: '/fixture-original', isEnhanceTask: false, ...extra });
    const displayed = [item('image', 'asset', 'image'), item('video', 'asset', 'video'), item('ref', 'reference_image', 'image'),
      item('generated', 'video_task', 'video'), item('superres', 'asset', 'video', { isEnhanceTask: true }), item('audio', 'asset', 'audio'),
      item('missing', 'asset', 'video', { previewUrl: null }), item('deleted', 'asset', 'video', { status: 'deleted' })];
    const selectedSet = new Set(displayed.map(current => current.id));
    const eligible = declaration('src/app/assets/page.tsx', 'workspaceReusableItems', { displayItems: displayed, selectedSet, isWorkspaceReusableItem: workspacePredicate });
    assert.deepEqual(eligible.map((value: any) => value.id), ['image', 'video', 'ref']);
    assert.deepEqual(displayed.filter(imagePredicate).map(value => value.id), ['image', 'ref']);
    checks.push('actual_page_workspace_predicate_and_display_order_album_unchanged');
    const state = { error: '', message: '', cleared: 0, delivery: null as any, moving: false };
    const run = declaration('src/app/assets/page.tsx', 'handleAddImagesToWorkspace', {
      workspaceReusableItems: eligible, user: actor, uploadSession: sessionModule.uploadSession, postWorkspaceAssociation: association,
      getOrCreateWorkspaceTabId: () => 'fixture-tab', setMoving: (value: boolean) => { state.moving = value; },
      setError: (value: string) => { state.error = value; }, setMessage: (value: string) => { state.message = value; },
      setDelivery: (value: unknown) => { state.delivery = value; }, clearSelection: () => { state.cleared++; },
    });
    loseResponse = true; await run();
    assert.equal(state.cleared, 0); assert.match(state.error, /response lost/); assert.equal(storage.size, 1);
    const firstRequestId = posts[0].requestId;
    const ordered = await db.workspaceAsset.findMany({ where: { workspace_id: workspaceId }, orderBy: { sort_order: 'asc' } });
    assert.deepEqual(ordered.map(value => value.asset_id), ['anchor', 'image', 'video', 'shared']);
    assert.equal(ordered.find(value => value.id === anchor.id)!.sort_order, 42); assert.equal(ordered.find(value => value.id === anchor.id)!.role, 'first_frame');
    assert.equal(ordered.find(value => value.asset_id === 'video')!.role, 'reference_video');
    checks.push('actual_handler_mixed_selection_order_roles_and_existing_positions');
    await run();
    assert.equal(posts[1].requestId, firstRequestId); assert.equal(storage.size, 0); assert.equal(state.cleared, 1);
    assert.match(state.message, /已确认 3 项参考素材在工作区/); assert.equal(state.delivery.href, '/generate');
    assert.equal(state.delivery.label, '打开生成工作区');
    assert.deepEqual(await db.workspaceAsset.findMany({ where: { workspace_id: workspaceId }, orderBy: { sort_order: 'asc' } }), ordered);
    checks.push('unknown_response_keeps_selection_same_receipt_replay_truthful_count');
    await run();
    assert.notEqual(posts[2].requestId, firstRequestId); assert.equal(state.cleared, 2);
    assert.deepEqual(await db.workspaceAsset.findMany({ where: { workspace_id: workspaceId }, orderBy: { sort_order: 'asc' } }), ordered);
    assert.match(state.message, /已确认 3 项/); checks.push('already_mounted_items_keep_positions_and_confirmed_count');
    const beforeForbidden = await db.workspaceAsset.count();
    const denied = await post('/api/workspace/assets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tab-id': 'fixture-tab', 'x-upload-owner-id': actor.id },
      body: JSON.stringify({ ownerId: actor.id, requestId: 'denied-request', selection: [{ assetId: 'other-video' }] }) });
    assert.equal(denied.status, 403); assert.equal(await db.workspaceAsset.count(), beforeForbidden);
    checks.push('actual_handler_denies_unowned_video_asset_path_without_partial_write');
    changeAccount = true;
    await assert.rejects(() => association('fixture-tab', { selection: [{ assetId: 'video' }] }), /账号已变化/);
    assert.equal(storage.size, 1); checks.push('account_change_retains_original_receipt_without_current_account_result');
    assert.equal(forbiddenCalls, 0);
    const output = path.join(root, '.role-tests'); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const receipt = path.join(output, 'asset-workspace-selection-receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ completed: true, checks, sourceSha256, actualHandlerPosts: handlerPosts, temporaryDatabase: true,
      productionWrites: 0, providerCalls: 0, externalCalls: forbiddenCalls, browserRuns: 0 }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ completed: true, checks: checks.length, actualHandlerPosts: handlerPosts, receipt }));
  } finally { globalThis.fetch = originalFetch; process.chdir(originalCwd); await db.$disconnect(); fs.rmSync(folder, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
