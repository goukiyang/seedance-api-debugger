import './server-runtime.cjs';
import { createHash, randomBytes } from 'node:crypto';
import fsSync, { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/lib/prisma';
import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '../src/lib/provider/seedance-models';
import { composeMultiviewGenerationPrompt } from '../src/lib/video/multiview-generation-contract';
import { installMultiviewPrivateRecipe, MULTIVIEW_OUTPUT_REGISTRATION_ACTIVATION_KEY,
  type MultiviewPrivateRecipeInstallInput } from '../src/lib/video/multiview-preset.server';
import { MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX } from '../src/lib/video/multiview-recipe-storage.server';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '../src/types';

const PRODUCTION_ROOT = '/data/video-api-debugger/var-lib/storage/multiview-recipes';
const CURRENT_KEY = 'multiview_rotation_preset_v1:current';
const VERSION_PREFIX = 'multiview_rotation_preset_v1:version:';
const PLAN_SCHEMA = 'multiview-private-recipe-plan.v1';
const VERIFY_SCHEMA = 'multiview-private-recipe-verification.v1';
const RECEIPT_SCHEMA = 'multiview-private-recipe-apply.v1';
const ADMISSION_SCHEMA = 'multiview-private-recipe-admission.v1';
const WORKS_CONTROL_ROOT = '/data/video-api-debugger/controls/multiview-works-v1';
const WORKS_START_MODULE = `${WORKS_CONTROL_ROOT}/start.mjs`;
const WORKS_SOURCE_DROPIN = '/etc/systemd/system/sd2-multiview-works.service.d/zz-multiview-private-source.conf';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(message: string): never { throw new Error(message); }

type Phase = 'plan' | 'verify' | 'apply';
type Cli = { phase: Phase; payload: string; guide: string; proof?: string; plan?: string; verification?: string;
  admission?: string; receipt?: string; nonProduction: boolean; fixtureRoot?: string };
type Identity = { dev: number; ino: number; uid: number; gid: number; mode: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number };
type PrivateRead = { bytes: Buffer; identity: Identity; sha256: string };
type Payload = { sourceTaskId: string; expectedRevision: number; mutationId: string; fullprompt: string;
  defaults: MultiviewPrivateRecipeInstallInput['defaults']; ref2binding: MultiviewPrivateRecipeInstallInput['compositionReference'];
  expectedPromptSHA: string; guideSHA: string };
type Inspection = { revision: number; version: string; promptSha256: string; guideSha256: string; guideSize: number;
  guideWidth: number; guideHeight: number; sourceTaskMatched: true; guideMatched: true };
type Proof = { schema: typeof PLAN_SCHEMA | typeof VERIFY_SCHEMA; createdAt: string; payloadSha256: string; guideSha256: string;
  inspection: Inspection; planSha256?: string };
type EvidencePointer = { path: string; sha256: string; identity: Identity };
type Admission = { schema: typeof ADMISSION_SCHEMA; runId: string; mainSource: string; mainBuild: string;
  guardSource: string; guardBuild: string; oldWebPids: number[]; oldWebCgroup: string; oldWebCgroupPids: number[];
  additionalReaderPids: number[]; evidence: { preOpen: EvidencePointer; worksReady: EvidencePointer;
    allowed: EvidencePointer; naturalStopWeb: EvidencePointer; pricingPairPublished: EvidencePointer } };
type AdmissionEvidence = { preOpenValue: Record<string, unknown>; worksReadyValue: Record<string, unknown>;
  worksAllowedValue: Record<string, unknown>; pricingAllowedValue: Record<string, unknown>;
  stopValue: Record<string, unknown>; publishedValue: Record<string, unknown> };
type WorksStartObserver = (contract: Record<string, unknown>, context: { sourceRoot: string; appUid: number }) => unknown;
type WorksProcessObservation = { pid: number; parentPid: number; uid: number; cwd: string; cgroup: string; command: string };

function args(argv: string[]): Cli {
  const phase = argv[0];
  if (!phase || !['plan', 'verify', 'apply'].includes(phase)) fail('Usage: install-multiview-private-recipe.ts <plan|verify|apply> [private files]');
  const values = new Map<string, string>(); let nonProduction = false;
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--non-production') { nonProduction = true; continue; }
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Invalid argument: ${key}`);
    if (values.has(key)) fail(`Duplicate argument: ${key}`);
    values.set(key, argv[++i]);
  }
  const known = new Set(['--payload-file', '--guide-file', '--proof-file', '--plan-file', '--verification-file',
    '--admission-file', '--receipt-file', '--fixture-root']);
  for (const key of Array.from(values.keys())) if (!known.has(key)) fail(`Unknown argument: ${key}`);
  const payload = values.get('--payload-file'), guide = values.get('--guide-file');
  if (!payload || !guide) fail('Both --payload-file and --guide-file are required');
  if (nonProduction !== values.has('--fixture-root')) fail('--non-production and --fixture-root must be used together');
  if (nonProduction && process.env.NODE_ENV === 'production') fail('Fixture mode is forbidden with NODE_ENV=production');
  if (!nonProduction && values.has('--fixture-root')) fail('Production root cannot be overridden');
  if ((phase === 'plan' || phase === 'verify') && !values.get('--proof-file')) fail('--proof-file is required');
  if (phase === 'verify' && !values.get('--plan-file')) fail('--plan-file is required for verify');
  if (phase === 'apply' && (!values.get('--plan-file') || !values.get('--verification-file') || !values.get('--receipt-file')))
    fail('apply requires --plan-file, --verification-file and --receipt-file');
  if (phase === 'apply' && !nonProduction && !values.get('--admission-file')) fail('Production apply requires --admission-file');
  return { phase: phase as Phase, payload: path.resolve(payload), guide: path.resolve(guide), proof: values.get('--proof-file') && path.resolve(values.get('--proof-file')!),
    plan: values.get('--plan-file') && path.resolve(values.get('--plan-file')!), verification: values.get('--verification-file') && path.resolve(values.get('--verification-file')!),
    admission: values.get('--admission-file') && path.resolve(values.get('--admission-file')!), receipt: values.get('--receipt-file') && path.resolve(values.get('--receipt-file')!),
    nonProduction, fixtureRoot: values.get('--fixture-root') && path.resolve(values.get('--fixture-root')!) };
}

function identity(stat: Stats): Identity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, nlink: stat.nlink,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
const sameIdentity = (a: Identity, b: Identity) => (Object.keys(a) as Array<keyof Identity>).every(key => a[key] === b[key]);

async function readPrivate(filename: string, production: boolean, max = 30_000_000, allowProtectedGroupRead = false): Promise<PrivateRead> {
  if (!path.isAbsolute(filename)) fail('Private file path must be absolute');
  const lst = await fs.lstat(filename);
  if (!lst.isFile() || lst.isSymbolicLink() || lst.nlink !== 1 || lst.size < 1 || lst.size > max) fail(`Unsafe private file: ${filename}`);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = identity(await handle.stat());
    if (production && (before.uid !== 0 || before.mode !== 0o600)) fail(`Production private file must be root-owned 0600: ${filename}`);
    if (!production && before.mode & (allowProtectedGroupRead ? 0o037 : 0o077)) fail(`Private file permissions are too broad: ${filename}`);
    const bytes = await handle.readFile(); const after = identity(await handle.stat());
    if (!sameIdentity(before, after) || bytes.length !== before.size) fail(`Private file changed while reading: ${filename}`);
    return { bytes, identity: before, sha256: hash(bytes) };
  } finally { await handle.close(); }
}

function json(bytes: Buffer, label: string) { try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return fail(`${label} is not valid JSON`); } }
function validDefaults(defaults: Record<string, unknown>) {
  return exact(defaults, ['provider', 'generationMode', 'model', 'ratio', 'duration', 'resolution', 'seed', 'generateAudio', 'returnLastFrame', 'watermark'])
    && defaults.seed === -1 && defaults.provider === 'seedance' && defaults.generationMode === 'all_in_one_reference'
    && typeof defaults.model === 'string' && isSeedanceVideoModelId(defaults.model)
    && RATIO_OPTIONS.includes(defaults.ratio as never) && isSeedanceVideoDuration(defaults.duration, defaults.model)
    && RESOLUTION_OPTIONS.includes(defaults.resolution as never) && typeof defaults.generateAudio === 'boolean'
    && typeof defaults.returnLastFrame === 'boolean' && typeof defaults.watermark === 'boolean';
}
function validBinding(binding: Record<string, unknown>, expectedSha?: string) {
  return exact(binding, ['assetId', 'referenceImageId', 'ownerId', 'sha256']) && id(binding.assetId) && id(binding.referenceImageId)
    && id(binding.ownerId) && sha(binding.sha256) && (expectedSha === undefined || binding.sha256 === expectedSha);
}
function payload(value: unknown): Payload {
  if (!object(value) || !exact(value, ['sourceTaskId', 'expectedRevision', 'mutationId', 'fullprompt', 'defaults', 'ref2binding', 'expectedPromptSHA', 'guideSHA'])
    || !id(value.sourceTaskId) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || !id(value.mutationId)
    || typeof value.fullprompt !== 'string' || !value.fullprompt.trim() || !sha(value.expectedPromptSHA) || !sha(value.guideSHA)
    || hash(value.fullprompt) !== value.expectedPromptSHA || !object(value.defaults) || !object(value.ref2binding)) fail('Private payload contract mismatch');
  const defaults = value.defaults;
  if (!validDefaults(defaults)) fail('Private payload defaults are invalid');
  const binding = value.ref2binding;
  if (!validBinding(binding, value.guideSHA)) fail('Private payload reference binding is invalid');
  const revision = Number(value.expectedRevision) + 1;
  if (!Number.isSafeInteger(revision) || !composeMultiviewGenerationPrompt('', `1.0.${revision}`, {
    id: 'multiview-360', version: `1.0.${revision}`, prompt: value.fullprompt,
    defaults: defaults as unknown as Payload['defaults'], compositionReference: binding as unknown as Payload['ref2binding'],
  }).valid) fail('Private payload recipe is invalid');
  return value as unknown as Payload;
}

function png(bytes: Buffer, expectedSha: string) {
  if (bytes.length < 24 || bytes.length >= 30_000_000 || hash(bytes) !== expectedSha
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') fail('Private guide PNG is invalid');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 40_000_000) fail('Private guide PNG dimensions are invalid');
  return { width, height };
}

async function inspect(input: Payload, guide: PrivateRead, allowInstalled = false): Promise<Inspection> {
  const dimensions = png(guide.bytes, input.guideSHA);
  const [actor, task, asset, reference, current] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.ref2binding.ownerId }, select: { role: true, account_type: true, status: true } }),
    prisma.videoTask.findUnique({ where: { id: input.sourceTaskId }, select: {
      id: true, prompt: true, final_prompt_snapshot: true, owner_user_id: true, user_id: true,
    } }),
    prisma.asset.findUnique({ where: { id: input.ref2binding.assetId }, select: { owner_id: true, status: true, type: true, mime_type: true, hash: true, file_size: true, width: true, height: true } }),
    prisma.referenceImage.findUnique({ where: { id: input.ref2binding.referenceImageId }, select: { owner_user_id: true, asset_id: true, status: true } }),
    prisma.platformSetting.findUnique({ where: { key: CURRENT_KEY }, select: { value_json: true } }),
  ]);
  if (!actor || actor.role !== 'admin' || actor.account_type !== 'internal' || actor.status !== 'active') fail('Recipe owner is not an active internal administrator');
  if (!task || (task.owner_user_id || task.user_id) !== input.ref2binding.ownerId
    || task.prompt !== input.fullprompt || task.final_prompt_snapshot !== input.fullprompt
    || hash(task.prompt) !== input.expectedPromptSHA || hash(task.final_prompt_snapshot) !== input.expectedPromptSHA) fail('Source task prompt proof mismatch');
  if (!asset || asset.owner_id !== input.ref2binding.ownerId || asset.status !== 'active' || asset.type !== 'image' || asset.mime_type !== 'image/png'
    || asset.hash !== input.guideSHA || asset.file_size !== guide.bytes.length || asset.width !== dimensions.width || asset.height !== dimensions.height
    || !reference || reference.owner_user_id !== input.ref2binding.ownerId || reference.asset_id !== input.ref2binding.assetId || reference.status !== 'active')
    fail('Reference image proof mismatch');
  let revision = 0; let currentPreset: Record<string, unknown> | null = null;
  if (current) {
    const value = json(Buffer.from(current.value_json), 'Current recipe');
    if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !object(value.preset)
      || value.preset.id !== 'multiview-360' || value.preset.version !== `1.0.${value.revision}`
      || typeof value.preset.prompt !== 'string' || !value.preset.prompt.trim()) fail('Current recipe is unreadable');
    const legacy = exact(value.preset, ['id', 'version', 'prompt']);
    const complete = exact(value.preset, ['id', 'version', 'prompt', 'defaults', 'compositionReference'])
      && object(value.preset.defaults) && object(value.preset.compositionReference)
      && validDefaults(value.preset.defaults) && validBinding(value.preset.compositionReference)
      && composeMultiviewGenerationPrompt('', String(value.preset.version), value.preset as unknown as Parameters<typeof composeMultiviewGenerationPrompt>[2]).valid;
    if (!legacy && !complete) fail('Current recipe is unreadable');
    revision = Number(value.revision); currentPreset = value.preset;
  }
  const nextRevision = input.expectedRevision + 1, nextVersion = `1.0.${nextRevision}`;
  if (revision !== input.expectedRevision && !(allowInstalled && revision === nextRevision && currentPreset
    && currentPreset.version === nextVersion && currentPreset.prompt === input.fullprompt
    && JSON.stringify(currentPreset.defaults) === JSON.stringify(input.defaults)
    && JSON.stringify(currentPreset.compositionReference) === JSON.stringify(input.ref2binding))) fail('Expected recipe revision is stale');
  return { revision: nextRevision, version: nextVersion, promptSha256: input.expectedPromptSHA,
    guideSha256: guide.sha256, guideSize: guide.bytes.length, guideWidth: dimensions.width, guideHeight: dimensions.height,
    sourceTaskMatched: true, guideMatched: true };
}

async function privateParent(filename: string, production: boolean) {
  const parent = path.dirname(filename), stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(parent) !== parent || stat.mode & 0o077) fail(`Unsafe private output directory: ${parent}`);
  if (production && stat.uid !== 0) fail(`Production output directory must be root-owned: ${parent}`);
}

async function createPrivate(filename: string, data: unknown, production: boolean) {
  await privateParent(filename, production);
  const raw = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(raw); await handle.sync(); await handle.chmod(0o600); } finally { await handle.close(); }
  try { await fs.link(temporary, filename); } catch (error) {
    if (!object(error) || error.code !== 'EEXIST') throw error;
    const existing = await readPrivate(filename, production, raw.length + 1);
    if (!existing.bytes.equals(raw)) fail(`Existing private proof differs: ${filename}`);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
  const directory = await fs.open(path.dirname(filename), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  return hash(raw);
}

function proof(value: unknown, schema: typeof PLAN_SCHEMA | typeof VERIFY_SCHEMA): Proof {
  const keys = schema === PLAN_SCHEMA ? ['schema', 'createdAt', 'payloadSha256', 'guideSha256', 'inspection']
    : ['schema', 'createdAt', 'payloadSha256', 'guideSha256', 'inspection', 'planSha256'];
  if (!object(value) || !exact(value, keys) || value.schema !== schema || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt)) || !sha(value.payloadSha256) || !sha(value.guideSha256) || !object(value.inspection)
    || schema === VERIFY_SCHEMA && !sha(value.planSha256)) fail(`Invalid ${schema} proof`);
  return value as unknown as Proof;
}

function evidencePointer(value: unknown): EvidencePointer {
  if (!object(value) || !exact(value, ['path', 'sha256', 'identity']) || typeof value.path !== 'string' || !path.isAbsolute(value.path)
    || !sha(value.sha256) || !object(value.identity) || !exact(value.identity, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'])
    || Object.values(value.identity).some(item => typeof item !== 'number' || !Number.isFinite(item))) fail('Invalid admission evidence pointer');
  return value as unknown as EvidencePointer;
}

function admission(value: unknown): Admission {
  if (!object(value) || !exact(value, ['schema', 'runId', 'mainSource', 'mainBuild', 'guardSource', 'guardBuild', 'oldWebPids', 'oldWebCgroup', 'oldWebCgroupPids', 'additionalReaderPids', 'evidence'])
    || value.schema !== ADMISSION_SCHEMA || !id(value.runId) || !/^[a-f0-9]{40}$/.test(String(value.mainSource)) || !id(value.mainBuild)
    || !/^[a-f0-9]{40}$/.test(String(value.guardSource)) || !id(value.guardBuild) || value.guardSource === value.mainSource
    || typeof value.oldWebCgroup !== 'string' || !/^\/[A-Za-z0-9_.@/-]+$/.test(value.oldWebCgroup)
    || value.oldWebCgroup.includes('..') || path.posix.normalize(value.oldWebCgroup) !== value.oldWebCgroup || !Array.isArray(value.oldWebPids)
    || !Array.isArray(value.oldWebCgroupPids) || !Array.isArray(value.additionalReaderPids) || value.additionalReaderPids.length
    || !object(value.evidence)) fail('Invalid production admission contract');
  for (const list of [value.oldWebPids, value.oldWebCgroupPids]) if (!list.length || list.some(item => !Number.isSafeInteger(item) || Number(item) <= 1)) fail('Invalid old reader PID proof');
  const ev = value.evidence;
  if (!exact(ev, ['preOpen', 'worksReady', 'allowed', 'naturalStopWeb', 'pricingPairPublished'])) fail('Incomplete production evidence set');
  return { ...(value as unknown as Omit<Admission, 'evidence'>), evidence: { preOpen: evidencePointer(ev.preOpen),
    worksReady: evidencePointer(ev.worksReady), allowed: evidencePointer(ev.allowed),
    naturalStopWeb: evidencePointer(ev.naturalStopWeb), pricingPairPublished: evidencePointer(ev.pricingPairPublished) } };
}

type PinnedReadOptions = { fixtureRoot?: string; allowedPrefixes: string[]; requiredUid?: number; publicReadonly?: boolean };
async function readPinned(pointer: EvidencePointer, options: PinnedReadOptions): Promise<PrivateRead> {
  const canonical = await fs.realpath(pointer.path);
  if (options.fixtureRoot) {
    if (process.env.NODE_ENV !== 'test') fail('Fixture evidence is allowed only in NODE_ENV=test');
    const root = await fs.realpath(options.fixtureRoot);
    if (canonical !== pointer.path || !canonical.startsWith(root + path.sep)) fail(`Fixture evidence path is not canonical: ${pointer.path}`);
  } else if (canonical !== pointer.path || !options.allowedPrefixes.some(prefix => pointer.path.startsWith(prefix))) {
    fail(`Protected evidence path is not canonical: ${pointer.path}`);
  }
  const lst = await fs.lstat(pointer.path);
  if (!lst.isFile() || lst.isSymbolicLink() || lst.nlink !== 1 || lst.size < 1 || lst.size > 10_000_000)
    fail(`Unsafe protected evidence: ${pointer.path}`);
  const handle = await fs.open(pointer.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = identity(await handle.stat());
    if (options.requiredUid !== undefined && before.uid !== options.requiredUid) fail(`Unexpected protected evidence owner: ${pointer.path}`);
    if (!(before.mode & 0o400) || (options.publicReadonly ? Boolean(before.mode & 0o022) : Boolean(before.mode & 0o037)))
      fail(`Unsafe protected evidence permissions: ${pointer.path}`);
    const bytes = await handle.readFile(), after = identity(await handle.stat());
    if (!sameIdentity(before, after) || bytes.length !== before.size || hash(bytes) !== pointer.sha256
      || !sameIdentity(before, pointer.identity)) fail(`Protected evidence identity mismatch: ${pointer.path}`);
    return { bytes, identity: before, sha256: pointer.sha256 };
  } finally { await handle.close(); }
}
async function readEvidence(pointer: EvidencePointer, options: PinnedReadOptions) {
  return json((await readPinned(pointer, options)).bytes, path.basename(pointer.path));
}
function snapshotPointer(value: unknown, label: string): EvidencePointer {
  if (!object(value) || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !sha(value.sha256)) fail(`Invalid ${label} snapshot`);
  const identityValue = Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
    .map(key => [key, value[key]])) as unknown as Identity;
  if (Object.values(identityValue).some(item => typeof item !== 'number' || !Number.isFinite(item))) fail(`Invalid ${label} identity`);
  return { path: value.path, sha256: value.sha256, identity: identityValue };
}
function samePointer(a: EvidencePointer, b: EvidencePointer) {
  return a.path === b.path && a.sha256 === b.sha256 && sameIdentity(a.identity, b.identity);
}
function strictIso(value: unknown, now: number, maximumAge: number, label: string) {
  if (typeof value !== 'string') fail(`${label} timestamp is missing`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time > now || now - time > maximumAge)
    fail(`${label} timestamp is stale or invalid`);
  return time;
}
function safeCgroup(value: unknown): value is string {
  return typeof value === 'string' && /^\/[A-Za-z0-9_.@/-]+$/.test(value)
    && !value.includes('..') && path.posix.normalize(value) === value;
}
function worksStartupPointers(value: Record<string, unknown>) {
  if (!object(value.startup) || !exact(value.startup, ['allowed', 'module', 'sourceDropin'])) fail('Works startup proof is incomplete');
  return { allowed: evidencePointer(value.startup.allowed), module: evidencePointer(value.startup.module),
    sourceDropin: evidencePointer(value.startup.sourceDropin) };
}
function worksSourceDropinBytes(releaseRoot: string) {
  return Buffer.from(`[Service]\nWorkingDirectory=${releaseRoot}\nExecStart=\n`
    + `ExecStart=/usr/bin/node --import tsx scripts/process-multiview-works.ts\n`
    + `ExecStartPre=/usr/bin/node ${WORKS_START_MODULE}\n`);
}
function pricingInstalledSnapshot(value: Record<string, unknown>) {
  if (!object(value.published) || !object(value.published.installed)) fail('Pricing publication has no installed allowlist');
  const installed = value.published.installed;
  if (!exact(installed, ['path', 'dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs',
    'attributes', 'sha256', 'bytesBase64']) || typeof installed.attributes !== 'string'
    || !/^[A-Za-z-]{22}$/.test(installed.attributes) || typeof installed.bytesBase64 !== 'string'
    || installed.bytesBase64.length < 4 || installed.bytesBase64.length > 14_000_000) fail('Pricing publication installed snapshot mismatch');
  const pointer = snapshotPointer(installed, 'pricing allowlist');
  const bytes = Buffer.from(installed.bytesBase64, 'base64');
  if (bytes.toString('base64') !== installed.bytesBase64 || bytes.length !== pointer.identity.size || hash(bytes) !== pointer.sha256)
    fail('Pricing publication embedded allowlist mismatch');
  return { pointer, bytes };
}
async function loadAdmissionEvidence(input: Admission, fixtureRoot?: string) {
  const privateEvidence = { fixtureRoot, allowedPrefixes: ['/data/video-api-debugger/'], requiredUid: fixtureRoot ? undefined : 0 };
  const publicEvidence = { ...privateEvidence, publicReadonly: true };
  const [preOpenValue, worksReadyValue, worksAllowedValue, stopValue, publishedValue] = await Promise.all([
    readEvidence(input.evidence.preOpen, privateEvidence), readEvidence(input.evidence.worksReady, privateEvidence),
    readEvidence(input.evidence.allowed, publicEvidence), readEvidence(input.evidence.naturalStopWeb, privateEvidence),
    readEvidence(input.evidence.pricingPairPublished, privateEvidence),
  ]);
  if (!object(preOpenValue) || !object(worksReadyValue) || !object(worksAllowedValue)
    || !object(stopValue) || !object(publishedValue))
    fail('Admission evidence is not structured JSON');
  const startup = worksStartupPointers(worksReadyValue);
  if (!samePointer(startup.allowed, input.evidence.allowed)) fail('Works startup allowlist pointer differs from admission');
  const pricingSnapshot = pricingInstalledSnapshot(publishedValue);
  if (!fixtureRoot && pricingSnapshot.pointer.path !== '/data/video-api-debugger/controls/pricing-writer-v1/allowed.json')
    fail('Pricing publication does not identify the fixed installed allowlist');
  const [pricingFile, startupModuleFile, sourceDropinFile] = await Promise.all([
    readPinned(pricingSnapshot.pointer, { fixtureRoot, allowedPrefixes: ['/data/video-api-debugger/controls/pricing-writer-v1/'],
      requiredUid: fixtureRoot ? undefined : 0, publicReadonly: true }),
    readPinned(startup.module, { fixtureRoot, allowedPrefixes: ['/data/video-api-debugger/controls/multiview-works-v1/'],
      requiredUid: fixtureRoot ? undefined : 0, publicReadonly: true }),
    readPinned(startup.sourceDropin, { fixtureRoot, allowedPrefixes: ['/etc/systemd/system/sd2-multiview-works.service.d/'],
      requiredUid: fixtureRoot ? undefined : 0, publicReadonly: true }),
  ]);
  if (!pricingFile.bytes.equals(pricingSnapshot.bytes)) fail('Published pricing allowlist bytes differ from the installed file');
  if (!sourceDropinFile.bytes.equals(worksSourceDropinBytes(`/data/video-api-debugger/managed-releases/${input.mainSource}`)))
    fail('Works source drop-in does not bind the admitted main release and fixed start verifier');
  const pricingAllowedValue = json(pricingFile.bytes, path.basename(pricingSnapshot.pointer.path));
  if (!object(pricingAllowedValue)) fail('Pricing allowlist is not structured JSON');
  return { values: { preOpenValue, worksReadyValue, worksAllowedValue, pricingAllowedValue,
    stopValue, publishedValue }, startup, startupModuleFile, sourceDropinFile, pricingPointer: pricingSnapshot.pointer };
}

function validateAdmissionEvidence(input: Admission, values: AdmissionEvidence, now: number, observeWorksStart: WorksStartObserver) {
  const { preOpenValue, worksReadyValue, worksAllowedValue, pricingAllowedValue, stopValue, publishedValue } = values;
  if (!exact(preOpenValue, ['schema', 'mode', 'kind', 'stage', 'runId', 'manifestSha256', 'healthy', 'web', 'maintenance', 'at'])
    || preOpenValue.schema !== 'multiview-private-preopen.v1' || preOpenValue.mode !== 'switch'
    || preOpenValue.kind !== 'main' || preOpenValue.stage !== 'private-preopen' || preOpenValue.runId !== input.runId
    || !sha(preOpenValue.manifestSha256) || !object(preOpenValue.healthy) || preOpenValue.healthy.kind !== 'main'
    || preOpenValue.healthy.actualHealthy !== true || preOpenValue.healthy.source !== input.mainSource
    || preOpenValue.healthy.build !== input.mainBuild || !object(preOpenValue.web)) fail('Private pre-open evidence mismatch');
  const manifest = preOpenValue.manifestSha256, preOpenAt = strictIso(preOpenValue.at, now, 90_000, 'Private pre-open');
  if (!Array.isArray(preOpenValue.maintenance) || preOpenValue.maintenance.length !== 2) fail('Both ingress targets must be in maintenance');
  const expectedHosts = new Set(['sd2.youdooart.com', 'sd2-server.youdoodesign.com']);
  for (const row of preOpenValue.maintenance) {
    if (!object(row) || !exact(row, ['host', 'status', 'checkedAt', 'responseSha256']) || !expectedHosts.delete(String(row.host))
      || row.status !== 503 || !Number.isSafeInteger(row.checkedAt) || Number(row.checkedAt) > preOpenAt
      || now - Number(row.checkedAt) > 90_000 || !sha(row.responseSha256)) fail('Ingress maintenance observation mismatch');
  }
  const web = preOpenValue.web, releaseRoot = `/data/video-api-debugger/managed-releases/${input.mainSource}`;
  if (web.source !== input.mainSource || web.build !== input.mainBuild || web.root !== releaseRoot
    || !Number.isSafeInteger(web.pid) || Number(web.pid) <= 1 || !object(web.state) || !safeCgroup(web.state.ControlGroup))
    fail('Active web identity does not match the admitted main release');
  if (stopValue.runId !== input.runId || stopValue.manifestSha256 !== manifest || stopValue.forcedKill !== false
    || stopValue.originalCgroup !== input.oldWebCgroup || !object(stopValue.after) || stopValue.after.Result !== 'success'
    || stopValue.after.ActiveState !== 'inactive' || Number(stopValue.after.MainPID) !== 0 || Number(stopValue.after.ControlPID) !== 0)
    fail('Natural old-web stop evidence mismatch');
  if (!object(stopValue.before) || stopValue.before.ControlGroup !== input.oldWebCgroup) fail('Natural old-web start evidence is missing');
  const oldMainPid = Number(stopValue.before.MainPID), oldControlPid = Number(stopValue.before.ControlPID);
  const recordedOld = new Set([...input.oldWebPids, ...input.oldWebCgroupPids]);
  if (oldMainPid <= 1 || !recordedOld.has(oldMainPid) || oldControlPid > 1 && !recordedOld.has(oldControlPid)
    || typeof stopValue.before.WorkingDirectory !== 'string') fail('Old reader PID evidence is incomplete');
  const oldRootMatch = stopValue.before.WorkingDirectory.match(/^\/data\/video-api-debugger\/(?:managed-releases|releases)\/([a-f0-9]{40})$/);
  if (!oldRootMatch || oldRootMatch[1] === input.mainSource || oldRootMatch[1] === input.guardSource)
    fail('Old source is still admitted as main or guard');
  if (publishedValue.runId !== input.runId || publishedValue.manifestSha256 !== manifest || !object(publishedValue.published)
    || publishedValue.published.schema !== 'pricing-start-pair-published.v1' || publishedValue.published.runId !== input.runId
    || publishedValue.published.manifestSha256 !== manifest || publishedValue.published.actualExecStartPreVerified !== false
    || !object(publishedValue.published.stoppedWriters) || !object(publishedValue.published.installed))
    fail('Pricing-pair publication evidence mismatch');
  const pricingPointer = pricingInstalledSnapshot(publishedValue).pointer;
  const stopped = publishedValue.published.stoppedWriters;
  if (!exact(stopped, ['sd2-gray.service', 'sd2-image-studio.service'])) fail('Pricing writer stop evidence is incomplete');
  for (const service of Object.values(stopped)) if (!object(service) || Number(service.MainPID) !== 0 || Number(service.ControlPID) !== 0
    || !['inactive', 'failed'].includes(String(service.ActiveState))) fail('Pricing writer was not durably stopped before publication');
  if (pricingAllowedValue.schema !== 'pricing-writer-start-allowlist.v1' || pricingAllowedValue.project !== 'video-api-debugger'
    || pricingAllowedValue.runId !== input.runId || typeof pricingAllowedValue.marker !== 'string'
    || !pricingAllowedValue.marker.startsWith('/data/video-api-debugger/') || !Array.isArray(pricingAllowedValue.releases)
    || pricingAllowedValue.releases.length !== 2 || !Number.isSafeInteger(pricingAllowedValue.serviceUid))
    fail('Pricing writer allowlist evidence mismatch');
  const pricingReleases = pricingAllowedValue.releases as Array<Record<string, unknown>>;
  const pricingRelease = (source: string, build: string) => pricingReleases.find(item => item.source === source && item.build === build
    && item.root === `/data/video-api-debugger/managed-releases/${source}` && object(item.sourceFiles) && object(item.buildFiles));
  if (!pricingRelease(input.mainSource, input.mainBuild) || !pricingRelease(input.guardSource, input.guardBuild)
    || pricingReleases.some(item => item.source !== input.mainSource && item.source !== input.guardSource))
    fail('Pricing writer allowlist is not exactly main plus secret guard');
  if (worksAllowedValue.schema !== 'sd2-multiview-works-start.v1' || worksAllowedValue.runId !== input.runId
    || worksAllowedValue.manifestSha256 !== manifest || !Number.isSafeInteger(worksAllowedValue.appUid)
    || !Array.isArray(worksAllowedValue.releases) || worksAllowedValue.releases.length !== 2) fail('Works start allowlist mismatch');
  const worksReleases = worksAllowedValue.releases as Array<Record<string, unknown>>;
  const worksRelease = (source: string, build: string) => worksReleases.find(item => item.source === source && item.build === build
    && item.root === `/data/video-api-debugger/managed-releases/${source}` && object(item.sourceSha256));
  const mainRelease = worksRelease(input.mainSource, input.mainBuild), guardRelease = worksRelease(input.guardSource, input.guardBuild);
  if (!mainRelease || !guardRelease || worksReleases.some(item => item.source !== input.mainSource && item.source !== input.guardSource)
    || !object(mainRelease.sourceSha256) || !sha(mainRelease.sourceSha256['ops/sd2-multiview-works-start.mjs']))
    fail('Works start allowlist is not exactly main plus secret guard');
  if (!exact(worksReadyValue, ['schema', 'runId', 'manifestSha256', 'kind', 'source', 'version', 'build', 'unit', 'current',
    'oldPids', 'oldCgroup', 'naturalExit', 'runtime', 'startup', 'at']) || worksReadyValue.schema !== 'multiview-works-ready.v1'
    || worksReadyValue.runId !== input.runId || worksReadyValue.manifestSha256 !== manifest || worksReadyValue.kind !== 'main'
    || worksReadyValue.source !== input.mainSource || worksReadyValue.build !== input.mainBuild
    || worksReadyValue.version !== mainRelease.version || worksReadyValue.unit !== 'sd2-multiview-works.service'
    || worksReadyValue.naturalExit !== true || !object(worksReadyValue.current) || !object(worksReadyValue.runtime)
    || !Array.isArray(worksReadyValue.oldPids) || !safeCgroup(worksReadyValue.oldCgroup)) fail('Works-ready evidence mismatch');
  const worksAt = strictIso(worksReadyValue.at, now, 90_000, 'Works ready');
  const current = worksReadyValue.current;
  if (!exact(current, ['MainPID', 'ControlPID', 'ControlGroup', 'InvocationID', 'WorkingDirectory', 'ActiveState', 'SubState'])
    || Number(current.MainPID) <= 1 || !Number.isSafeInteger(Number(current.MainPID)) || Number(current.ControlPID) !== 0
    || !safeCgroup(current.ControlGroup) || current.WorkingDirectory !== releaseRoot || current.ActiveState !== 'active'
    || current.SubState !== 'running' || typeof current.InvocationID !== 'string' || !/^[a-f0-9]{32}$/.test(current.InvocationID))
    fail('Current works service evidence mismatch');
  if (worksReadyValue.oldPids.some(item => !Number.isSafeInteger(item) || Number(item) <= 1)
    || new Set(worksReadyValue.oldPids).size !== worksReadyValue.oldPids.length) fail('Old works PID evidence mismatch');
  const runtime = worksReadyValue.runtime;
  if (!exact(runtime, ['schema', 'protocol', 'state', 'pid', 'parentPid', 'sourceRoot', 'source', 'version', 'build', 'startedAt', 'heartbeatAt', 'loadedModuleSha'])
    || runtime.schema !== 'multiview.works.v1' || runtime.protocol !== runtime.schema
    || runtime.state !== 'active' || !Number.isSafeInteger(runtime.pid)
    || Number(runtime.pid) <= 1 || Number(runtime.pid) === Number(current.MainPID) || !Number.isSafeInteger(runtime.parentPid)
    || Number(runtime.parentPid) !== Number(current.MainPID) || worksReadyValue.oldPids.includes(Number(current.MainPID))
    || worksReadyValue.oldPids.includes(Number(runtime.pid))
    || runtime.sourceRoot !== releaseRoot || runtime.source !== input.mainSource || runtime.version !== mainRelease.version
    || runtime.build !== input.mainBuild || !object(runtime.loadedModuleSha)) fail('Works runtime identity mismatch');
  const started = strictIso(runtime.startedAt, now, Number.MAX_SAFE_INTEGER, 'Works runtime start');
  const heartbeat = strictIso(runtime.heartbeatAt, now, 45_000, 'Works runtime heartbeat');
  if (started > heartbeat || heartbeat > worksAt) fail('Works runtime timestamps are out of order');
  const startup = worksStartupPointers(worksReadyValue);
  if (!samePointer(startup.allowed, input.evidence.allowed)) fail('Works startup allowlist pointer differs from admission');
  for (const [file, digest] of Object.entries(runtime.loadedModuleSha)) {
    if (!file || path.posix.isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..') || !sha(digest)
      || mainRelease.sourceSha256[file] !== digest) fail('Works runtime loaded-module proof mismatch');
  }
  for (const file of ['ops/sd2-multiview-works-start.mjs', 'scripts/process-multiview-works.ts',
    'src/lib/video/multiview-works-runtime.ts']) if (!sha(runtime.loadedModuleSha[file])) fail('Works runtime required-module proof is missing');
  if (startup.module.sha256 !== runtime.loadedModuleSha['ops/sd2-multiview-works-start.mjs'])
    fail('Works startup module differs from the running module proof');
  const observed = observeWorksStart(worksAllowedValue, { sourceRoot: releaseRoot, appUid: Number(worksAllowedValue.appUid) });
  if (!object(observed) || observed.source !== input.mainSource || observed.build !== input.mainBuild
    || observed.actualUid !== worksAllowedValue.appUid || observed.verified !== true) fail('Works start observer rejected the admitted main release');
  return { manifest, web, releaseRoot, pricingServiceUid: Number(pricingAllowedValue.serviceUid),
    worksAppUid: Number(worksAllowedValue.appUid), worksReadyValue, pricingPointer };
}

export async function validateMultiviewPrivateRecipeAdmissionFixture(
  value: unknown, fixtureRoot: string, observeWorksStart: WorksStartObserver, now = Date.now(),
) {
  if (process.env.NODE_ENV !== 'test') fail('Admission fixture validation is allowed only in NODE_ENV=test');
  const input = admission(value), loaded = await loadAdmissionEvidence(input, fixtureRoot);
  const result = validateAdmissionEvidence(input, loaded.values, now, observeWorksStart);
  return { runId: input.runId, mainSource: input.mainSource, mainBuild: input.mainBuild,
    webPid: Number(result.web.pid), webCgroup: String((result.web.state as Record<string, unknown>).ControlGroup),
    worksPid: Number((result.worksReadyValue.runtime as Record<string, unknown>).pid) };
}

function procStatus(pid: number) {
  return fs.readFile(`/proc/${pid}/status`, 'utf8').then(raw => {
    const uid = Number(raw.match(/^Uid:\s+(\d+)/m)?.[1]), gid = Number(raw.match(/^Gid:\s+(\d+)/m)?.[1]);
    const parentPid = Number(raw.match(/^PPid:\s+(\d+)/m)?.[1]);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || !Number.isSafeInteger(parentPid))
      fail(`Cannot establish process identity: ${pid}`);
    return { uid, gid, parentPid };
  });
}
async function procCgroup(pid: number) {
  const raw = await fs.readFile(`/proc/${pid}/cgroup`, 'utf8');
  const group = raw.split('\n').map(line => line.split(':')[2]).find(Boolean);
  if (!group?.startsWith('/')) fail(`Cannot establish process cgroup: ${pid}`);
  return group;
}
function worksCommandArgv(command: string) {
  if (!command || command.length > 32_768 || /[\r\n]/.test(command)) fail('Unsafe works process command line');
  const argv = command.split('\0');
  if (argv.at(-1) === '') argv.pop();
  if (!argv.length || argv.some(argument => !argument || argument.length > 8_192)) fail('Unsafe works process command line');
  return argv;
}
function coreWorksCommand(command: string, releaseRoot: string, locked: boolean) {
  const argv = worksCommandArgv(command);
  const script = argv[3], allowedScripts = ['scripts/process-multiview-works.ts',
    path.posix.join(releaseRoot, 'scripts/process-multiview-works.ts')];
  const expected = [argv[0], '--import', 'tsx', script, ...(locked ? ['--multiview-worker-lock-held'] : [])];
  return argv[0] === '/usr/bin/node'
    && allowedScripts.includes(script) && argv.length === expected.length
    && argv.every((argument, index) => argument === expected[index]);
}
function worksHelperCommand(command: string, releaseRoot: string) {
  const argv = worksCommandArgv(command), executable = argv[0];
  const inReleaseModules = path.posix.isAbsolute(executable)
    && executable.startsWith(`${releaseRoot}/node_modules/`) && path.posix.normalize(executable) === executable;
  return inReleaseModules && path.posix.basename(executable) === 'esbuild'
    && argv.length === 3 && argv.slice(1).some(argument => /^--service=\d+\.\d+\.\d+$/.test(argument))
    && argv.slice(1).includes('--ping');
}
function validateWorksProcessTree(observations: WorksProcessObservation[], mainPid: number, runtimePid: number,
  appUid: number, releaseRoot: string, worksGroup: string) {
  if (!observations.length || new Set(observations.map(item => item.pid)).size !== observations.length)
    fail('Works process observation set is incomplete');
  const byPid = new Map(observations.map(item => [item.pid, item]));
  const main = byPid.get(mainPid), runtime = byPid.get(runtimePid);
  if (!main || !runtime || main.parentPid !== 1 || runtime.parentPid !== mainPid
    || !coreWorksCommand(main.command, releaseRoot, false)
    || !coreWorksCommand(runtime.command, releaseRoot, true)) fail('Works parent/runtime process shape mismatch');
  for (const item of observations) {
    if (!Number.isSafeInteger(item.pid) || item.pid <= 1 || !Number.isSafeInteger(item.parentPid) || item.parentPid < 0
      || item.uid !== appUid || item.cwd !== releaseRoot
      || item.cgroup !== worksGroup && !item.cgroup.startsWith(`${worksGroup}/`)) fail('Works process identity mismatch');
    if (item.pid === mainPid || item.pid === runtimePid) continue;
    if (!worksHelperCommand(item.command, releaseRoot)) fail('Unapproved works helper process exists');
    const seen = new Set<number>([item.pid]); let parent = item.parentPid;
    while (parent !== mainPid && parent !== runtimePid) {
      if (seen.has(parent)) fail('Works helper process ancestry is cyclic');
      seen.add(parent); const ancestor = byPid.get(parent);
      if (!ancestor) fail('Works helper process is not descended from the new service');
      parent = ancestor.parentPid;
    }
  }
}
export function validateMultiviewPrivateWorksProcessFixture(value: unknown, input: {
  mainPid: number; runtimePid: number; appUid: number; releaseRoot: string; worksGroup: string;
}) {
  if (process.env.NODE_ENV !== 'test' || !Array.isArray(value) || !object(input))
    fail('Works process fixture validation is allowed only in NODE_ENV=test');
  const observations = value.map(item => {
    if (!object(item) || !exact(item, ['pid', 'parentPid', 'uid', 'cwd', 'cgroup', 'command'])
      || typeof item.cwd !== 'string' || typeof item.cgroup !== 'string' || typeof item.command !== 'string')
      fail('Invalid works process fixture observation');
    return item as unknown as WorksProcessObservation;
  });
  validateWorksProcessTree(observations, input.mainPid, input.runtimePid, input.appUid, input.releaseRoot, input.worksGroup);
  return { pids: observations.map(item => item.pid).sort((a, b) => a - b) };
}
async function cgroupPids(group: string) {
  const root = path.join('/sys/fs/cgroup', group);
  const pending = [root], found = new Set<number>();
  while (pending.length) {
    const directory = pending.pop()!;
    const raw = await fs.readFile(path.join(directory, 'cgroup.procs'), 'utf8');
    raw.trim().split(/\s+/).filter(Boolean).forEach(value => found.add(Number(value)));
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
  }
  return found;
}
async function listenerInodes(port: number) {
  const found = new Set<string>();
  for (const filename of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const raw = await fs.readFile(filename, 'utf8');
    for (const line of raw.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/); const local = fields[1]?.split(':');
      if (parseInt(local?.[1] || '', 16) === port && fields[3] === '0A' && fields[9]) found.add(fields[9]);
    }
  }
  return found;
}
async function ownersOfSockets(inodes: Set<string>) {
  const owners = new Set<number>();
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name); let fds: string[];
    try { fds = await fs.readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) try {
      const target = await fs.readlink(`/proc/${pid}/fd/${fd}`); const match = target.match(/^socket:\[(\d+)\]$/);
      if (match && inodes.has(match[1])) owners.add(pid);
    } catch { /* process/fd exited during the scan */ }
  }
  return owners;
}

function systemdWorksState() {
  const fields = ['MainPID', 'ControlPID', 'ControlGroup', 'InvocationID', 'WorkingDirectory', 'ActiveState', 'SubState'];
  const output = execFileSync('/usr/bin/systemctl', ['show', 'sd2-multiview-works.service',
    ...fields.flatMap(field => ['-p', field])], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
  const result = Object.fromEntries(output.trim().split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('=');
    if (index <= 0) fail('Malformed works systemd observation');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!exact(result, fields)) fail('Incomplete works systemd observation');
  return result;
}
function systemdWorksExecStartPre() {
  const output = execFileSync('/usr/bin/systemctl', ['show', 'sd2-multiview-works.service', '-p', 'ExecStartPre', '--value'],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 }).trim();
  if (output.includes('\n') || !output.startsWith('{ ') || !output.endsWith(' }') || output.slice(2, -2).includes(' } { '))
    fail('Works ExecStartPre observation is not one fixed command');
  const fields = new Map<string, string>();
  for (const entry of output.slice(2, -2).split(' ; ')) {
    const at = entry.indexOf('=');
    if (at <= 0 || fields.has(entry.slice(0, at))) fail('Malformed works ExecStartPre observation');
    fields.set(entry.slice(0, at), entry.slice(at + 1));
  }
  if (fields.get('path') !== '/usr/bin/node' || fields.get('argv[]') !== `/usr/bin/node ${WORKS_START_MODULE}`
    || fields.get('ignore_errors') !== 'no') fail('Works ExecStartPre is not bound to the fixed start verifier');
  return output;
}

function worksObservationAdapter(context: { sourceRoot: string; appUid: number }) {
  const shape = (stat: Stats) => ({ type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory'
    : stat.isSymbolicLink() ? 'symlink' : 'other', nlink: stat.nlink, uid: stat.uid, mode: stat.mode, dev: stat.dev,
    ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  return { platform: process.platform, nodeVersion: process.versions.node, uid: () => context.appUid, cwd: () => context.sourceRoot,
    realpath: (file: string) => fsSync.realpathSync(file), lstat: (file: string) => shape(fsSync.lstatSync(file)),
    stat: (file: string) => shape(fsSync.statSync(file)), readlink: (file: string) => fsSync.readlinkSync(file),
    readStableFile: (file: string) => {
      const descriptor = fsSync.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = shape(fsSync.fstatSync(descriptor)), bytes = fsSync.readFileSync(descriptor);
        const after = shape(fsSync.fstatSync(descriptor));
        return { bytes, before, after };
      } finally { fsSync.closeSync(descriptor); }
    },
    accessReadable: (file: string) => { const stat = fsSync.statSync(file);
      return Boolean(stat.mode & 0o004 || stat.uid === context.appUid && stat.mode & 0o400); } };
}

async function productionAdmission(filename: string, input: Admission) {
  const loaded = await loadAdmissionEvidence(input);
  const expectedSourceModule = path.join(`/data/video-api-debugger/managed-releases/${input.mainSource}`, 'ops/sd2-multiview-works-start.mjs');
  if (input.evidence.allowed.path !== `${WORKS_CONTROL_ROOT}/allowed.json`
    || loaded.startup.module.path !== WORKS_START_MODULE || loaded.startup.sourceDropin.path !== WORKS_SOURCE_DROPIN)
    fail('Works startup files are outside their fixed locations');
  const localModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ops/sd2-multiview-works-start.mjs');
  if (localModule !== expectedSourceModule) fail('Installer is not running from the admitted main release');
  const sourceModuleBytes = await fs.readFile(localModule);
  if (hash(sourceModuleBytes) !== loaded.startup.module.sha256 || !sourceModuleBytes.equals(loaded.startupModuleFile.bytes))
    fail('Root works start control is not the admitted main release verifier');
  const worksStart = await import('../ops/sd2-multiview-works-start.mjs');
  if (worksStart.MULTIVIEW_WORKS_START_FILE !== input.evidence.allowed.path
    || typeof worksStart.observeMultiviewWorksStart !== 'function') fail('Works start verifier contract mismatch');
  const validated = validateAdmissionEvidence(input, loaded.values, Date.now(), (contract, context) =>
    worksStart.observeMultiviewWorksStart(contract, worksObservationAdapter(context)));
  const { web, releaseRoot } = validated;
  const pid = Number(web.pid);
  const [status, cwd, group, deployed, build] = await Promise.all([procStatus(pid), fs.realpath(`/proc/${pid}/cwd`), procCgroup(pid),
    fs.readFile(path.join(releaseRoot, '.deployed-commit'), 'utf8'), fs.readFile(path.join(releaseRoot, '.next-prod/BUILD_ID'), 'utf8')]);
  if (status.uid !== validated.pricingServiceUid || cwd !== releaseRoot || deployed.trim() !== input.mainSource || build.trim() !== input.mainBuild)
    fail('Fresh web process/source/build proof mismatch');
  const stopValue = loaded.values.stopValue;
  if (!object(web.state) || web.state.ControlGroup !== group || !object(stopValue.before)
    || stopValue.before.ControlGroup !== input.oldWebCgroup) fail('Web cgroup evidence mismatch');
  const activeGroup = await cgroupPids(group);
  if (!activeGroup.has(pid)) fail('Fresh web process is outside its live cgroup');
  const oldGroup = await cgroupPids(input.oldWebCgroup).catch(error => object(error) && error.code === 'ENOENT' ? new Set<number>() : Promise.reject(error));
  if (input.oldWebCgroup !== group && oldGroup.size) fail('Old web cgroup is not empty');
  if (input.oldWebCgroup === group && Array.from(oldGroup).some(member => !activeGroup.has(member))) fail('Reused web cgroup contains an unadmitted reader');
  for (const oldPid of Array.from(new Set([...input.oldWebPids, ...input.oldWebCgroupPids])))
    if (await fs.stat(`/proc/${oldPid}`).then(() => true, () => false)) fail(`Old reader still exists: ${oldPid}`);
  const listenerOwners = await ownersOfSockets(await listenerInodes(3302));
  if (!listenerOwners.size || Array.from(listenerOwners).some(owner => !activeGroup.has(owner))) fail('Port 3302 is not owned exclusively by the fresh web cgroup');
  const releasePrefixes = ['/data/video-api-debugger/managed-releases/', '/data/video-api-debugger/releases/'];
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue; const candidate = Number(name);
    let command = '', processCwd = '';
    try { [command, processCwd] = await Promise.all([fs.readFile(`/proc/${candidate}/cmdline`, 'utf8'), fs.realpath(`/proc/${candidate}/cwd`)]); } catch { continue; }
    if (releasePrefixes.some(prefix => processCwd.startsWith(prefix)) && /(next-server|next[\0 ]+start|\.next)/.test(command)
      && (!activeGroup.has(candidate) || processCwd !== releaseRoot)) fail(`Unadmitted Next reader exists: ${candidate}`);
  }
  const worksReady = validated.worksReadyValue, current = worksReady.current as Record<string, unknown>;
  const runtime = worksReady.runtime as Record<string, unknown>, mainPid = Number(current.MainPID), runtimePid = Number(runtime.pid);
  const observedState = systemdWorksState();
  const observedExecStartPre = systemdWorksExecStartPre();
  for (const key of Object.keys(observedState)) if (String(current[key]) !== observedState[key]) fail('Works systemd state changed after readiness proof');
  const worksGroup = String(current.ControlGroup);
  const worksMembers = await cgroupPids(worksGroup), memberPids = Array.from(worksMembers).sort((a, b) => a - b);
  const observations = await Promise.all(memberPids.map(async member => {
    const [memberStatus, memberCwd, memberGroup, command] = await Promise.all([
      procStatus(member), fs.realpath(`/proc/${member}/cwd`), procCgroup(member), fs.readFile(`/proc/${member}/cmdline`, 'utf8'),
    ]);
    return { pid: member, parentPid: memberStatus.parentPid, uid: memberStatus.uid,
      cwd: memberCwd, cgroup: memberGroup, command };
  }));
  const worksMembersAfter = await cgroupPids(worksGroup);
  if (memberPids.length !== worksMembersAfter.size || memberPids.some(member => !worksMembersAfter.has(member)))
    fail('Works process group changed during admission');
  validateWorksProcessTree(observations, mainPid, runtimePid, validated.worksAppUid, releaseRoot, worksGroup);
  const admittedCorePids = new Set([mainPid, runtimePid]);
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const candidate = Number(name); let command = '', processCwd = '';
    try { [command, processCwd] = await Promise.all([
      fs.readFile(`/proc/${candidate}/cmdline`, 'utf8'), fs.realpath(`/proc/${candidate}/cwd`),
    ]); } catch { continue; }
    if (command.includes('scripts/process-multiview-works.ts')
      && releasePrefixes.some(prefix => processCwd.startsWith(prefix))
      && (!admittedCorePids.has(candidate) || processCwd !== releaseRoot))
      fail(`Unadmitted multiview works process exists: ${candidate}`);
  }
  for (const oldPid of worksReady.oldPids as number[]) if (await fs.stat(`/proc/${oldPid}`).then(() => true, () => false))
    fail(`Old works process still exists: ${oldPid}`);
  const oldWorksGroup = String(worksReady.oldCgroup);
  const oldWorksMembers = await cgroupPids(oldWorksGroup).catch(error => object(error) && error.code === 'ENOENT'
    ? new Set<number>() : Promise.reject(error));
  if (oldWorksGroup !== worksGroup && oldWorksMembers.size) fail('Old works cgroup is not empty');
  if (oldWorksGroup === worksGroup && Array.from(oldWorksMembers).some(member => !worksMembersAfter.has(member)))
    fail('Reused works cgroup contains a process outside the validated new process tree');
  await readPinned(input.evidence.allowed, { allowedPrefixes: ['/data/video-api-debugger/controls/multiview-works-v1/'],
    requiredUid: 0, publicReadonly: true });
  const freshStartModule = await readPinned(loaded.startup.module,
    { allowedPrefixes: ['/data/video-api-debugger/controls/multiview-works-v1/'], requiredUid: 0, publicReadonly: true });
  const freshSourceModule = await fs.readFile(localModule);
  if (!freshStartModule.bytes.equals(freshSourceModule) || !freshSourceModule.equals(sourceModuleBytes))
    fail('Works start verifier changed during admission');
  const freshSourceDropin = await readPinned(loaded.startup.sourceDropin,
    { allowedPrefixes: ['/etc/systemd/system/sd2-multiview-works.service.d/'], requiredUid: 0, publicReadonly: true });
  if (!freshSourceDropin.bytes.equals(worksSourceDropinBytes(releaseRoot))
    || systemdWorksExecStartPre() !== observedExecStartPre) fail('Works startup binding changed during admission');
  return { uid: status.uid, gid: status.gid, releaseRoot, webPid: pid, worksPid: runtimePid, admissionFile: filename };
}

async function storageRoot(cli: Cli, owner?: { uid: number; gid: number }) {
  const root = cli.nonProduction ? cli.fixtureRoot! : PRODUCTION_ROOT;
  if (!path.isAbsolute(root)) fail('Storage root must be absolute');
  if (!cli.nonProduction) {
    const [data, system] = await Promise.all([fs.lstat('/data'), fs.stat('/')]);
    if (!data.isDirectory() || data.isSymbolicLink() || data.dev === system.dev || await fs.realpath('/data') !== '/data') fail('/data is not a distinct real mount');
  }
  const parent = path.dirname(root), parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) fail('Storage parent is unsafe');
  let created = false;
  try { await fs.mkdir(root, { mode: 0o700 }); created = true; } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root || (stat.mode & 0o777) !== 0o700) fail('Storage root is unsafe');
  if (created && owner) await fs.chown(root, owner.uid, owner.gid);
  else if (owner && (stat.uid !== owner.uid || stat.gid !== owner.gid)) fail('Existing storage root has an unexpected owner');
  return root;
}

async function installGuide(root: string, guide: PrivateRead, owner: { uid: number; gid: number }) {
  const target = path.join(root, `${guide.sha256}.png`);
  const verify = async () => {
    const file = await readPrivate(target, false);
    if (file.sha256 !== guide.sha256 || !file.bytes.equals(guide.bytes) || file.identity.mode !== 0o600
      || file.identity.uid !== owner.uid || file.identity.gid !== owner.gid) fail('Existing installed guide differs');
  };
  if (await fs.stat(target).then(() => true, () => false)) { await verify(); return { target, created: false }; }
  const temporary = path.join(root, `.${guide.sha256}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(guide.bytes); await handle.sync(); await handle.chmod(0o600); await handle.chown(owner.uid, owner.gid); } finally { await handle.close(); }
  try { await fs.link(temporary, target); } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error; }
  finally { await fs.unlink(temporary).catch(() => undefined); }
  const directory = await fs.open(root, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  await verify(); return { target, created: true };
}

async function verifyInstalled(input: Payload, inspection: Inspection, target: string) {
  const [current, immutable, activation, protection] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { key: CURRENT_KEY } }),
    prisma.platformSetting.findUnique({ where: { key: VERSION_PREFIX + inspection.version } }),
    prisma.platformSetting.findUnique({ where: { key: MULTIVIEW_OUTPUT_REGISTRATION_ACTIVATION_KEY } }),
    prisma.platformSetting.findUnique({ where: { key: MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + input.guideSHA } }),
  ]);
  if (!current || !immutable || current.value_json !== immutable.value_json || !activation || !protection) fail('Installed recipe transaction is incomplete');
  const state = json(Buffer.from(current.value_json), 'Installed current recipe');
  if (!object(state) || state.revision !== inspection.revision || !object(state.preset) || state.preset.version !== inspection.version
    || hash(String(state.preset.prompt)) !== input.expectedPromptSHA) fail('Installed recipe state mismatch');
  const file = await readPrivate(target, false); if (file.sha256 !== input.guideSHA) fail('Installed guide hash mismatch');
  return { currentSha256: hash(current.value_json), activationSha256: hash(activation.value_json),
    protectionSha256: hash(protection.value_json), targetIdentity: file.identity };
}

async function main() {
  const cli = args(process.argv.slice(2)), production = !cli.nonProduction;
  if (production && process.getuid?.() !== 0) fail('Production private recipe installation requires root');
  const [payloadFile, guide] = await Promise.all([readPrivate(cli.payload, production, 1_000_000), readPrivate(cli.guide, production)]);
  const input = payload(json(payloadFile.bytes, 'Private payload'));
  const inspection = await inspect(input, guide, cli.phase === 'apply');
  const base: Omit<Proof, 'schema'> = { createdAt: new Date().toISOString(), payloadSha256: payloadFile.sha256, guideSha256: guide.sha256, inspection };
  if (cli.phase === 'plan') {
    await createPrivate(cli.proof!, { schema: PLAN_SCHEMA, ...base }, production);
    console.log(JSON.stringify({ phase: 'plan', revision: inspection.revision, version: inspection.version, applied: false,
      sourceTaskMatched: true, guideMatched: true })); return;
  }
  const planFile = await readPrivate(cli.plan!, production, 1_000_000), plan = proof(json(planFile.bytes, 'Plan proof'), PLAN_SCHEMA);
  if (plan.payloadSha256 !== payloadFile.sha256 || plan.guideSha256 !== guide.sha256 || JSON.stringify(plan.inspection) !== JSON.stringify(inspection)) fail('Plan proof no longer matches current inputs/state');
  if (cli.phase === 'verify') {
    await createPrivate(cli.proof!, { schema: VERIFY_SCHEMA, ...base, planSha256: planFile.sha256 }, production);
    console.log(JSON.stringify({ phase: 'verify', revision: inspection.revision, version: inspection.version, applied: false,
      sourceTaskMatched: true, guideMatched: true })); return;
  }
  const verificationFile = await readPrivate(cli.verification!, production, 1_000_000);
  const verification = proof(json(verificationFile.bytes, 'Verification proof'), VERIFY_SCHEMA);
  if (verification.planSha256 !== planFile.sha256 || verification.payloadSha256 !== payloadFile.sha256 || verification.guideSha256 !== guide.sha256
    || JSON.stringify(verification.inspection) !== JSON.stringify(inspection)) fail('Verification proof no longer matches current inputs/state');
  let owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }; let admitted: Awaited<ReturnType<typeof productionAdmission>> | null = null;
  let admittedInput: Admission | null = null, admissionSha256: string | null = null;
  if (production) {
    const admissionFile = await readPrivate(cli.admission!, true, 1_000_000);
    admissionSha256 = admissionFile.sha256;
    admittedInput = admission(json(admissionFile.bytes, 'Production admission'));
    admitted = await productionAdmission(cli.admission!, admittedInput);
    owner = { uid: admitted.uid, gid: admitted.gid };
  }
  const root = await storageRoot(cli, owner); const installed = await installGuide(root, guide, owner);
  if (production && admittedInput) {
    const fresh = await productionAdmission(cli.admission!, admittedInput);
    if (fresh.uid !== owner.uid || fresh.gid !== owner.gid || fresh.releaseRoot !== admitted?.releaseRoot
      || fresh.webPid !== admitted?.webPid || fresh.worksPid !== admitted?.worksPid)
      fail('Production admission changed before the configuration transaction');
  }
  const receipt = await installMultiviewPrivateRecipe({ sourceTaskId: input.sourceTaskId, expectedRevision: input.expectedRevision,
    mutationId: input.mutationId, prompt: input.fullprompt, expectedPromptSha256: input.expectedPromptSHA, defaults: input.defaults,
    compositionReference: input.ref2binding, guide: { sha256: guide.sha256, size: guide.bytes.length,
      width: inspection.guideWidth, height: inspection.guideHeight } });
  const installedProof = await verifyInstalled(input, inspection, installed.target);
  await createPrivate(cli.receipt!, { schema: RECEIPT_SCHEMA, payloadSha256: payloadFile.sha256,
    guideSha256: guide.sha256, planSha256: planFile.sha256, verificationSha256: verificationFile.sha256,
    revision: receipt.revision, version: receipt.version, requestHash: receipt.requestHash,
    activatedAt: receipt.activatedAt, activationCreated: receipt.activationCreated, installedProof,
    target: installed.target, production, admission: admittedInput ? { sha256: admissionSha256, runId: admittedInput.runId,
      mainSource: admittedInput.mainSource, mainBuild: admittedInput.mainBuild } : null }, production);
  console.log(JSON.stringify({ phase: 'apply', revision: receipt.revision, version: receipt.version, applied: true,
    sourceTaskMatched: receipt.sourceTaskMatched, guideMatched: receipt.guideMatched, target: installed.target }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Private recipe installer failed'); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
