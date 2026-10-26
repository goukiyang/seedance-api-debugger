import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicHdJson, hdDirectory, hdRequestIdentity, hdSource, withHdLease, type HdJob, type HdRequestContext } from './hd-derivatives';
import { hdReadonlyDb } from './hd-readonly-db';
import { hdEncoderStrategy } from './hd-encoder';

export const HD_SCHEDULER_PROTOCOL = 'hd-user-round-robin-v1';
type OwnerEvidence = { kind: 'asset' | 'reference' | 'legacy'; id?: string; ownerId?: string; checkedAt: string };
type Interest = { requesterId: string; token: string; expiresAt: number; writtenAt: number };
type Entry = { key: string; sourceVersion: string; strategy: string; homeBucket: string; ownerEvidence: OwnerEvidence;
  firstQueuedAt: string; role: 'new' | 'historical'; interests: Interest[] };
type Claim = { id: string; turnId: number; key: string; sourceVersion: string; strategy: string; homeBucket: string;
  previousAttempts: number; executionId?: string; stage: 'reserved' | 'started'; viewing: boolean; historical: boolean };
type Scheduler = { protocol: typeof HD_SCHEDULER_PROTOCOL; revision: number; globalTurn: number;
  consecutiveViewer: number; consecutiveForeground: number; buckets: Record<string, { lastServedTurn: number }>;
  entries: Record<string, Entry>; claim?: Claim };
const filename = () => path.join(hdDirectory(), 'scheduler-v1.json');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (job: HdJob) => ({ key: job.key, sourceVersion: job.version, strategy: hdEncoderStrategy(job.encoderStrategy) });
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const bucketFor = (ownerId?: string) => ownerId ? 'user:' + hash(ownerId) : 'system:legacy';
const fresh = (): Scheduler => ({ protocol: HD_SCHEDULER_PROTOCOL, revision: 0, globalTurn: 0,
  consecutiveViewer: 0, consecutiveForeground: 0, buckets: {}, entries: {} });
export async function readHdScheduler(): Promise<Scheduler> {
  try {
    const stat = await fs.stat(filename());
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('invalid_hd_scheduler');
    const state = JSON.parse(await fs.readFile(filename(), 'utf8')) as Scheduler;
    if (state.protocol !== HD_SCHEDULER_PROTOCOL || !integer(state.revision) || !integer(state.globalTurn)
      || !integer(state.consecutiveViewer) || state.consecutiveViewer > 2 || !integer(state.consecutiveForeground) || state.consecutiveForeground > 4
      || !state.buckets || Array.isArray(state.buckets) || !state.entries || Array.isArray(state.entries)) throw new Error('invalid_hd_scheduler');
    for (const [bucket, value] of Object.entries(state.buckets)) if (!/^(?:system:legacy|user:[a-f0-9]{64})$/.test(bucket)
      || !value || !integer(value.lastServedTurn) || value.lastServedTurn > state.globalTurn) throw new Error('invalid_hd_scheduler');
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!/^[a-f0-9]{64}$/.test(key) || entry.key !== key || !validId(entry.sourceVersion)
        || !state.buckets[entry.homeBucket] || !Number.isFinite(Date.parse(entry.firstQueuedAt))
        || !['new', 'historical'].includes(entry.role) || !entry.ownerEvidence || !['asset', 'reference', 'legacy'].includes(entry.ownerEvidence.kind)
        || !Number.isFinite(Date.parse(entry.ownerEvidence.checkedAt)) || !Array.isArray(entry.interests) || entry.interests.length > 256
        || entry.homeBucket !== bucketFor(entry.ownerEvidence.ownerId)
        || entry.ownerEvidence.kind !== 'legacy' && (!validId(entry.ownerEvidence.id) || !validId(entry.ownerEvidence.ownerId))) throw new Error('invalid_hd_scheduler');
      hdEncoderStrategy(entry.strategy);
      for (const interest of entry.interests) if (!validId(interest.requesterId) || !/^[a-f0-9-]{36}$/.test(interest.token)
        || !integer(interest.expiresAt) || !integer(interest.writtenAt) || interest.expiresAt - interest.writtenAt !== 45000) throw new Error('invalid_hd_scheduler');
    }
    if (state.claim) {
      const claim = state.claim, entry = state.entries[claim.key];
      if (!entry || !/^[a-f0-9-]{36}$/.test(claim.id) || !integer(claim.turnId) || claim.turnId < 1
        || !integer(claim.previousAttempts) || claim.sourceVersion !== entry.sourceVersion || claim.strategy !== entry.strategy
        || claim.homeBucket !== entry.homeBucket || !['reserved', 'started'].includes(claim.stage)
        || claim.stage === 'started' && (!/^[a-f0-9-]{36}$/.test(claim.executionId || '') || claim.turnId > state.globalTurn)
        || claim.stage === 'reserved' && claim.turnId !== state.globalTurn + 1) throw new Error('invalid_hd_scheduler_claim');
    }
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh(); throw error; }
}
async function mutate<T>(action: (state: Scheduler) => Promise<T> | T): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await withHdLease('scheduler', async () => {
      const state = await readHdScheduler(), value = await action(state);
      state.revision++; await atomicHdJson(filename(), state); return { value };
    });
    if (result) return result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('hd_scheduler_contention');
}
async function resolveOwner(job: HdJob): Promise<OwnerEvidence> {
  const source = await hdSource(job.source);
  if (!source || source.version !== job.version) throw new Error('hd_scheduler_source_changed');
  const assets = await hdReadonlyDb.asset.findMany({ where: { status: 'active', type: 'image' },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: { id: true, owner_id: true, original_url: true } })
    .catch(() => { throw new Error('hd_scheduler_owner_unavailable'); });
  const matches = async (url: string) => {
    try { const value = await hdSource(url); return value?.file === source.file && value.version === source.version; }
    catch (error) { if (['source_missing', 'source_unreadable'].includes((error as Error).message)) return false; throw error; }
  };
  const checkedAt = new Date().toISOString();
  for (const asset of assets) if (await matches(asset.original_url)) return { kind: 'asset', id: asset.id, ownerId: asset.owner_id, checkedAt };
  const references = await hdReadonlyDb.referenceImage.findMany({ where: { status: 'active', asset_id: null, album: { status: 'active' } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: { id: true, owner_user_id: true, url: true } })
    .catch(() => { throw new Error('hd_scheduler_owner_unavailable'); });
  for (const reference of references) if (await matches(reference.url)) return { kind: 'reference', id: reference.id, ownerId: reference.owner_user_id, checkedAt };
  return { kind: 'legacy', checkedAt };
}
function queuedAt(job: HdJob) {
  const values = [job.attemptHistory?.[0]?.startedAt, job.updatedAt].filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)));
  return values.sort()[0] || new Date().toISOString();
}
function pruneInterests(state: Scheduler, clock: number) {
  for (const entry of Object.values(state.entries)) entry.interests = entry.interests.filter(value => value.expiresAt > clock);
}
export async function registerHdScheduling(job: HdJob, context?: HdRequestContext) {
  if (!['queued', 'running'].includes(job.status) && !job.publicationPending) return;
  const snapshot = await readHdScheduler(), prior = snapshot.entries[job.key];
  const currentInterest = prior?.interests.find(value => value.requesterId === context?.requesterId && value.token === context?.viewToken);
  if (prior && prior.ownerEvidence.kind !== 'legacy' && (!context?.viewToken
    || currentInterest && Date.now() - currentInterest.writtenAt < 10000)) return;
  // No database operation is permitted inside the short scheduler lease. A
  // successful complete lookup alone can establish/upgrade a legacy bucket.
  const evidence = !prior || prior.ownerEvidence.kind === 'legacy' && Date.now() - Date.parse(prior.ownerEvidence.checkedAt) >= 60000
    ? await resolveOwner(job) : prior.ownerEvidence;
  await mutate(state => {
    const expected = identity(job), existing = state.entries[job.key];
    if (existing && (existing.sourceVersion !== expected.sourceVersion || existing.strategy !== expected.strategy)) throw new Error('invalid_hd_scheduler_identity');
    const frozen = existing?.ownerEvidence.kind !== 'legacy' ? existing?.ownerEvidence : state.claim?.key === job.key ? existing?.ownerEvidence : evidence;
    const ownerEvidence = frozen || evidence, homeBucket = bucketFor(ownerEvidence.ownerId);
    state.buckets[homeBucket] ||= { lastServedTurn: 0 };
    const entry: Entry = existing ? { ...existing, homeBucket, ownerEvidence } : { ...expected, homeBucket, ownerEvidence,
      firstQueuedAt: queuedAt(job), role: job.batch || job.queueRole === 'historical' || job.priority > 1 ? 'historical' : 'new', interests: [] };
    state.entries[job.key] = entry;
    const clock = Date.now(); pruneInterests(state, clock);
    if (!validId(context?.requesterId) || !/^[a-f0-9-]{36}$/.test(context?.viewToken || '')) return;
    const account = context!.requesterId!, token = context!.viewToken!;
    const current = entry.interests.find(value => value.requesterId === account && value.token === token);
    if (current && clock - current.writtenAt < 10000) return;
    const keys = Object.values(state.entries).filter(value => value.interests.some(interest => interest.requesterId === account));
    if (!keys.some(value => value.key === job.key) && keys.length >= 2) return;
    if (!current && entry.interests.length >= 256) return;
    if (current) Object.assign(current, { writtenAt: clock, expiresAt: clock + 45000 });
    else entry.interests.push({ requesterId: account, token, writtenAt: clock, expiresAt: clock + 45000 });
  });
}
export async function removeHdViewingInterest(requesterId: string, source: string) {
  if (!validId(requesterId)) return;
  // This is invoked only after an authenticated object read was denied. Never
  // turn the browser's source into an owner or a new queue registration.
  const identities = await Promise.all([false, true].flatMap(preserveText =>
    (['hd-legacy-e6-v1', 'hd-avif-e4-v1'] as const).map(strategy => hdRequestIdentity(source, preserveText, strategy))));
  const keys = new Set(identities.flatMap(value => value ? [value.key] : []));
  if (!keys.size) return;
  await mutate(state => { for (const entry of Object.values(state.entries)) if (keys.has(entry.key))
    entry.interests = entry.interests.filter(value => value.requesterId !== requesterId); });
}
export async function removeHdViewingToken(requesterId: string, token: string) {
  if (!validId(requesterId) || !/^[a-f0-9-]{36}$/.test(token)) return;
  const snapshot = await readHdScheduler();
  if (!Object.values(snapshot.entries).some(entry => entry.interests.some(value => value.requesterId === requesterId && value.token === token))) return;
  await mutate(state => {
    for (const entry of Object.values(state.entries)) entry.interests = entry.interests.filter(value => value.requesterId !== requesterId || value.token !== token);
  });
}
export async function synchronizeHdScheduler(jobs: HdJob[]) {
  for (const job of jobs) if (['queued', 'running'].includes(job.status) || job.publicationPending) {
    const state = await readHdScheduler();
    if (!state.entries[job.key] || state.entries[job.key].ownerEvidence.kind === 'legacy'
      && Date.now() - Date.parse(state.entries[job.key].ownerEvidence.checkedAt) >= 60000) await registerHdScheduling(job);
  }
  await mutate(state => {
    pruneInterests(state, Date.now());
    const active = new Set(jobs.filter(job => ['queued', 'running'].includes(job.status) || job.publicationPending).map(job => job.key));
    for (const [key, entry] of Object.entries(state.entries)) if (!active.has(key) && state.claim?.key !== key && !entry.interests.length) delete state.entries[key];
    if (state.claim && !jobs.some(job => job.key === state.claim!.key && job.version === state.claim!.sourceVersion
      && hdEncoderStrategy(job.encoderStrategy) === state.claim!.strategy)) throw new Error('invalid_hd_scheduler_claim');
  });
}
export async function claimHdScheduledJob(jobs: HdJob[], excluded = new Set<string>(), clock = Date.now()): Promise<HdJob | null> {
  await synchronizeHdScheduler(jobs);
  return mutate(state => {
    if (state.claim) {
      const job = jobs.find(value => value.key === state.claim!.key)!;
      if (excluded.has(job.key)) return null;
      return job;
    }
    const pending = jobs.filter(job => !excluded.has(job.key) && (job.publicationPending
      || ['queued', 'running'].includes(job.status) && (!job.retryAt || Date.parse(job.retryAt) <= clock)));
    // Recover publication and already-started executions before choosing new
    // work. Their original PID/group and receipt rules remain in processHdJob.
    const recovery = pending.find(job => job.publicationPending) || pending.find(job => job.status === 'running');
    let candidates = pending;
    const viewedByBucket = new Map<string, HdJob[]>();
    for (const job of pending) {
      const entry = state.entries[job.key];
      if (!entry.interests.some(value => value.expiresAt > clock)) continue;
      const viewed = viewedByBucket.get(entry.homeBucket) || [];
      viewed.push(job); viewedByBucket.set(entry.homeBucket, viewed);
    }
    const viewKeys = new Set(Array.from(viewedByBucket.values()).flatMap(viewed => viewed.sort((left, right) =>
      state.entries[left.key].firstQueuedAt.localeCompare(state.entries[right.key].firstQueuedAt) || left.key.localeCompare(right.key)).slice(0, 2).map(job => job.key)));
    const viewing = (job: HdJob) => viewKeys.has(job.key);
    const historical = (job: HdJob) => state.entries[job.key]?.role === 'historical'
      || !viewing(job) && clock - Date.parse(state.entries[job.key].firstQueuedAt) >= 600000;
    if (!recovery && state.consecutiveViewer >= 2 && candidates.some(job => !viewing(job))) candidates = candidates.filter(job => !viewing(job));
    if (!recovery && state.consecutiveForeground >= 4 && candidates.some(historical)) candidates = candidates.filter(historical);
    candidates.sort((left, right) => {
      const a = state.entries[left.key], b = state.entries[right.key];
      return state.buckets[a.homeBucket].lastServedTurn - state.buckets[b.homeBucket].lastServedTurn
        || a.homeBucket.localeCompare(b.homeBucket)
        || Number(viewing(right)) - Number(viewing(left))
        || a.firstQueuedAt.localeCompare(b.firstQueuedAt) || left.key.localeCompare(right.key);
    });
    const job = recovery || candidates[0];
    if (!job) return null;
    const entry = state.entries[job.key];
    state.claim = { id: randomUUID(), turnId: state.globalTurn + 1, ...identity(job), homeBucket: entry.homeBucket,
      previousAttempts: job.attempts, stage: 'reserved', viewing: viewing(job), historical: historical(job) };
    return job;
  });
}
export async function markHdScheduledAttempt(job: HdJob) {
  if (!(await readHdScheduler()).claim) return;
  await mutate(state => {
    const claim = state.claim;
    if (!claim || claim.key !== job.key) return;
    if (claim.sourceVersion !== job.version || claim.strategy !== hdEncoderStrategy(job.encoderStrategy)
      || !job.executionId || job.attempts <= claim.previousAttempts) throw new Error('invalid_hd_scheduler_claim');
    if (claim.stage === 'started') {
      if (claim.executionId === job.executionId) return;
      throw new Error('invalid_hd_scheduler_claim');
    }
    state.globalTurn++; state.buckets[claim.homeBucket].lastServedTurn = state.globalTurn;
    claim.turnId = state.globalTurn; claim.stage = 'started'; claim.executionId = job.executionId;
    state.consecutiveViewer = claim.viewing ? Math.min(2, state.consecutiveViewer + 1) : 0;
    state.consecutiveForeground = claim.historical ? 0 : Math.min(4, state.consecutiveForeground + 1);
  });
}
export async function seedHdSchedulerFairness(fairness: { consecutiveViewer: number; consecutiveForeground: number }) {
  try { await fs.stat(filename()); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mutate(state => {
    if (state.globalTurn || state.revision || Object.keys(state.entries).length) return;
    state.consecutiveViewer = fairness.consecutiveViewer; state.consecutiveForeground = fairness.consecutiveForeground;
  });
}
export async function finishHdScheduledClaim(job: HdJob | null, expectedKey: string) {
  await mutate(state => {
    const claim = state.claim;
    if (!claim || claim.key !== expectedKey) return;
    if (!job || job.version !== claim.sourceVersion || hdEncoderStrategy(job.encoderStrategy) !== claim.strategy) throw new Error('invalid_hd_scheduler_claim');
    // A crash after the attempt write but before the scheduler write consumes
    // the one actual opportunity on recovery, without inventing an execution.
    if (claim.stage === 'reserved' && job.attempts > claim.previousAttempts) {
      const attempt = job.attemptHistory?.find(value => value.attempt === claim.previousAttempts + 1 && value.sourceVersion === claim.sourceVersion);
      if (!attempt?.executionId) throw new Error('invalid_hd_scheduler_claim');
      state.globalTurn++; state.buckets[claim.homeBucket].lastServedTurn = state.globalTurn;
      state.consecutiveViewer = claim.viewing ? Math.min(2, state.consecutiveViewer + 1) : 0;
      state.consecutiveForeground = claim.historical ? 0 : Math.min(4, state.consecutiveForeground + 1);
    }
    delete state.claim;
  });
}
