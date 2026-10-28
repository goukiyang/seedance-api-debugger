const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loader, ts, root } = require('./audit-task-pagination-loader.cjs');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class PublicApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
class PricingChargeError extends Error { constructor(message = 'changed') { super(message); this.status = 409; } }
const sources = ['src/server/video-tasks/standard-create.ts', 'src/lib/tasks/seedance-draft-upgrade.ts'];
exports.sources = sources;
function statements(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'prisma.$transaction' && node.arguments[0]?.getText(tree).includes('const freshPricingContext')
      || ts.isCallExpression(node) && node.expression.getText(tree) === 'prisma.$transaction' && node.arguments[0]?.getText(tree).includes('const freshContext')) callback = node.arguments[0];
    ts.forEachChild(node, visit);
  }; visit(tree); assert.ok(callback, file);
  const parts = [];
  for (const statement of callback.body.statements) { if (statement.getText(tree).includes('await createVideoTaskRecord(')) break; parts.push(statement.getText(tree)); }
  assert.ok(parts.join('\n').includes('resolveVideoPricingContext'));
  return parts.join('\n');
}
exports.runCreatePrefix = async (file, bindings, tx) => {
  const source = '(async (tx) => {\n' + statements(file) + '\nreturn "checked-before-any-write"; })';
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), 'return ' + js)(...Object.values(bindings))(tx);
};
const recipe = { instruction: '', fields: [], assetSlots: [{ key: 'video', label: 'video', role: 'reference', types: ['video'], required: true, maxItems: 1 }], defaultParameters: {} };
exports.harness = function (options = {}) {
  const user = { id: 'actor', role: 'user', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: 'internal_email_authorized' };
  const owner = { userId: user.id, username: 'synthetic', displayName: 'Synthetic', avatarUrl: null, accountType: 'internal' };
  const inputs = [{ assetId: 'video', role: 'reference', type: 'video', slotKey: 'video' }];
  const snapshot = { owner, input: { name: 'Synthetic', groupName: '', values: {}, draftPrompt: 'synthetic input' },
    prompt: 'synthetic input', recipe, parameters: {}, assets: inputs,
    templateVersion: { templateId: 'template', templateSource: 'studio', versionId: 'version', sourceRevision: 'studio:1' } };
  const project = { id: 'project', name: 'Project', type: 'team', status: 'active', owner_user_id: 'project-owner', members: [{ user_id: user.id, status: 'active', role: 'editor' }] };
  const card = { id: 'card', project_id: 'project', status: 'active', project };
  const template = { id: 'template', owner_user_id: user.id, status: 'published', visibility: 'shared', revision: 1, recipe_json: JSON.stringify(recipe), name: 'Synthetic',
    owner: { id: user.id, name: 'Synthetic', username: 'synthetic', avatar_url: null }, versions: [], published_version: null,
    created_at: new Date(0), updated_at: new Date(0) };
  const asset = { id: 'video', owner_id: 'source-owner', type: 'video', status: 'active', original_url: 'https://synthetic.invalid/video.mp4', created_at: new Date(0), hash: 'synthetic-hash', file_size: 12 };
  const album = { id: 'album', owner_user_id: 'source-owner', status: 'active', project_id: null, album_type: 'private', visibility: 'private',
    shares: [{ grantee_type: 'project', grantee_id: 'project', permissions_json: JSON.stringify({ view: true, use: true }) }] };
  const reference = { id: 'reference', album_id: 'album', album, asset, asset_id: asset.id, owner_user_id: 'source-owner', status: 'active', url: asset.original_url,
    source_image_id: null, source_type: 'upload', rights_ceiling: null };
  const draft = { id: 'draft', provider: 'seedance', model: 'synthetic', project_id: project.id, video_card_id: card.id, ratio: '16:9', resolution: '480p',
    duration: 5, retention_status: 'active', reference_video_urls: '[]' };
  const studioDraft = { id: 'studio-draft', owner_user_id: user.id, source_template_id: 'template', template_source: 'studio', template_snapshot_json: null };
  const rows = { project, card, template, asset, album, reference, draft, studioDraft };
  const calls = [], io = []; let inTransaction = false, globalCalls = 0, writes = 0;
  const delegate = (scope, model) => new Proxy({}, { get(_target, method) {
    return async args => {
      if (scope === 'global' && inTransaction) { globalCalls++; throw Error('global_connection_reentered:' + model + '.' + String(method)); }
      calls.push({ scope, model, method, args });
      if (!['findUnique', 'findFirst', 'findMany'].includes(method)) { writes++; throw Error('write_forbidden'); }
      if (model === 'project') return args.where.id === project.id ? project : null;
      if (model === 'videoCard') return args.where.id === card.id ? card : null;
      if (model === 'videoStudioRun') return args.where.owner_user_id === user.id ? { id: 'run', owner_user_id: user.id, status: 'succeeded', mode: 'direct', draft_id: 'draft',
        prompt: 'synthetic input', snapshot_json: JSON.stringify(snapshot) } : null;
      if (model === 'videoStudioTemplate') return template;
      if (model === 'videoStudioDraft') return studioDraft;
      if (model === 'videoStudioTemplateVersion') return { id: 'version', template_id: template.id, recipe_json: JSON.stringify(recipe) };
      if (model === 'generationTemplate') return { id: 'legacy', name: 'Legacy', updated_at: new Date(0), created_at: new Date(0) };
      if (model === 'asset') return method === 'findMany' ? asset.status === 'active' ? [asset] : [] : asset;
      if (model === 'referenceImage') return method === 'findMany' ? [reference] : reference;
      if (model === 'platformSetting') return method === 'findMany' ? [] : null;
      if (model === 'userSession') return { user_id: user.id };
      if (model === 'videoTask') return draft;
      throw Error('unexpected SQL model:' + model);
    };
  } });
  const client = scope => new Proxy({}, { get(_target, model) { return delegate(scope, model); } });
  const global = client('global'), tx = client('tx');
  const noop = () => {};
  const catalogSource = fs.readFileSync(path.join(root, 'src/lib/pricing/catalog.ts'), 'utf8');
  const catalogTree = ts.createSourceFile('catalog.ts', catalogSource, ts.ScriptTarget.Latest, true);
  const functions = catalogTree.statements.filter(node => ts.isFunctionDeclaration(node) && ['pricingCanonical', 'pricingFingerprint'].includes(node.name.text)).map(node => node.getText(catalogTree)).join('\n');
  const js = ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('exports', 'node_crypto_1', 'createHash', js)(module.exports, { createHash }, createHash);
  const load = loader({
    '@/types': loader()('src/types/index.ts'),
    '@/lib/prisma': { prisma: global }, '@/lib/auth/session': { AuthError }, '@/lib/http/public-error': { PublicApiError },
    '@/lib/pricing/frozen-charge': { PricingChargeError }, './frozen-charge': { PricingChargeError }, './catalog': module.exports,
    '@prisma/client': { Prisma: { PrismaClientKnownRequestError: class extends Error {} } },
    '@/lib/projects/budget': { shouldBillProjectBudget: row => row.type === 'public' },
    '@/lib/access/feature-guard': { assertFeatureAllowed: noop, assertInternalOnly: noop, isFeatureAllowed: () => true },
    'next/server': { NextResponse: { json: Response.json } },
    '@/lib/http/api-error': { apiErrorResponse: error => { throw error; } },
    '@/lib/tasks/retention': { isTaskHiddenFromRegularUsers: row => row.retention_status !== 'active', USER_VISIBLE_TASK_RETENTION_STATUSES: ['active'] },
    '@/lib/security/secrets': { requireSecret: () => Buffer.alloc(32, 3), requireLegacySessionSecret: () => 'synthetic-key' },
    './secrets': { requireSecret: () => Buffer.alloc(32, 3), requireLegacySessionSecret: () => 'synthetic-key' },
    '@/lib/security/private-prompt-request.server': {
      privatePromptRequestCapabilities: async (_id, _origins, db = global) => { await db.userSession.findUnique({ where: { id: 'synthetic-cookie-boundary' } }); return { canReadPrivatePrompt: false, canEditPrivatePrompt: false, requiresIdentityVerification: false }; },
      requirePrivatePromptRequest: async (_id, _origins, db = global) => {
        await db.userSession.findUnique({ where: { id: 'synthetic-cookie-boundary' } });
        if (!options.privateAllowed) throw new AuthError('private denied');
      },
    },
    './private-storage.server': { readPrivateVideoRecipe: raw => JSON.parse(raw), transformPrivateVideoRun: value => value,
      videoTemplateOrigins: (id, ownerId) => options.privateAllowed ? [{ kind: 'video-template', id, ownerId }] : [], writePrivateVideoRecipe: JSON.stringify },
    '@/lib/security/private-prompt-fields.server': { privateFieldBinding: () => null, privateFieldOrigins: () => [], transferPrivateOrigins: noop,
      readPrivateFields: value => value, writePrivateFields: value => value },
    '@/lib/security/private-prompts.server': { isPrivatePromptError: () => false, PrivatePromptError: class extends Error {},
      privateOrigin: (kind, id, ownerId) => ({ kind, id, ownerId }) },
    '@/lib/security/private-prompt-identity.server': { PrivatePromptAccessError: class extends Error {} },
    '@/lib/security/private-prompt-drafts.server': { PrivateDraftConflict: class extends Error {} },
    '@/lib/templates/workbench': { serializeGenerationTemplate: value => value, TEMPLATE_INCLUDE: {} },
    './common': { requireStudioUser: actor => { if (actor.status !== 'active') throw new AuthError('disabled'); }, encodeCursor: noop, parseCursor: noop },
    '@/lib/image-studio/protected-assets': { studioHiddenAssetUrls: async (_user, db = global) => { await db.platformSetting.findMany({ where: {} }); return []; } },
    '@/lib/image-studio/access': {}, '@/lib/image-studio/preset-lifecycle': {}, '@/lib/image-studio/reference-policy': {},
    '@/lib/image-studio/fixed-references': {}, '@/lib/content-reactions/home-templates': {}, '@/lib/image-studio/dimension-mismatch': {},
    '@/lib/video/multiview-recipe-storage.server': {}, '@/lib/video/multiview-output-access.server': {},
    '@/lib/media/preview-response': {}, '@/lib/video/multiview-task-privacy': {},
    '@/lib/media/public-url': { isPrivateNetworkHost: () => false },
    '@/lib/net/safe-fetch': { safeFetch: async () => { io.push(inTransaction ? 'tx-network' : 'outside-network'); if (inTransaction) throw Error('io_in_transaction'); return { ok: true }; } },
  });
  const pricing = load('src/lib/pricing/video-context.ts');
  const body = { project_id: project.id, video_card_id: card.id, provider: 'seedance', model: 'synthetic', duration: 5, resolution: '480p',
    ratio: '16:9', template_studio_run_id: 'run', template_studio_assets: inputs };
  const run = async work => { inTransaction = true; try { return await work(tx); } finally { inTransaction = false; } };
  return { user, body, rows, snapshot, load, pricing, tx, global, calls, io, run,
    get writes() { return writes; }, get globalCalls() { return globalCalls; },
    bindings(context, token, draftUpgrade = false) {
      return { user, input: { user, pricingQuoteToken: token, pricingRevision: null }, body: { ...body, pricing_quote_token: token },
        creationBody: {}, requestClaim: null, idempotencyKey: 'original-unknown-request', project, videoCardId: card.id, draft,
        priceQuote: { revision: null, pricing: { estimatedCost: 5 } }, requestedProvider: 'seedance', H3_VIDEO_PROVIDER: 'h3', selectedModel: 'synthetic',
        resolution: '480p', duration: 5, draftRequested: false, requireScopeCredential: true, needsPricingCredential: true,
        multiviewGeneration: null, multiviewRecipe: null, multiviewSystemReference: null, canvasAdmission: null, videoBranch: null, estimatedCost: 5,
        resolveVideoPricingContext: pricing.resolveVideoPricingContext, savedVideoPricingContextInput: pricing.savedVideoPricingContextInput,
        verifyVideoPricingCredential: pricing.verifyVideoPricingCredential,
        assertProjectActiveInTransaction: load('src/lib/projects/permissions.ts').assertProjectActiveInTransaction,
        assertMultiviewRequestFence: async db => db.platformSetting.findUnique({ where: { key: 'original-request-fence' } }),
        assertLegacyCreationSourceLocks: async () => {}, assertCanvasVideoAdmission: async () => {},
        assertVideoPricingAcceptance: async (_quote, _revision, db) => db.platformSetting.findUnique({ where: { key: 'pricing-fence' } }),
      };
    } };
};
