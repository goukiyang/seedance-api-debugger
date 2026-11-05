import assert from 'node:assert/strict';

// R02 proposal arithmetic only; input facts are assumed, not authenticated.
const proposal = { points: 200, monthlyPool: 20000, monthlyAuthorCap: 2000 };
const results = [];
function scenario(id, title, run, scope = 'model_assertion') {
  results.push({ id, title, scope, result: run() ?? 'as_expected' });
}
function monthOf(acceptedAt) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date(acceptedAt));
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}
function book() { return { periods: new Map(), awards: new Map(), balances: new Map(), ledger: [] }; }
function period(b, month, options = {}) {
  const row = { ...proposal, authorized: true, open: true, reserved: 0, paid: 0, authors: new Map(), ...options };
  b.periods.set(month, row); return row;
}
function task(options = {}) {
  return { id: 'task1', acceptedAt: '2026-11-15T04:00:00Z', root: 'root1', recipient: 'author1', user: 'colleague1',
    internal: true, eligibleAtAcceptance: true, status: 'succeeded', settled: true, adopted: true,
    independentlyApproved: true, ...options };
}
function approve(b, t, { supplement = false } = {}) {
  const month = monthOf(t.acceptedAt), key = JSON.stringify([t.root, month]);
  if (!t.internal || t.user === t.recipient || ['failed', 'cancelled', 'debug'].includes(t.status)) return { state: 'ineligible' };
  if (!t.eligibleAtAcceptance) return { state: 'record_only' };
  if (t.status !== 'succeeded' || !t.settled) return { state: 'pending_evidence' };
  if (!t.adopted || !t.independentlyApproved) return { state: 'pending_review' };
  if (b.awards.has(key)) return { state: 'duplicate', award: b.awards.get(key) };
  const p = b.periods.get(month);
  if (!p?.authorized) return { state: 'record_only' };
  if (!p.open && !supplement) return { state: 'closed' };
  const authorUsed = p.authors.get(t.recipient) || 0;
  if (p.reserved + p.paid + p.points > p.monthlyPool) return { state: 'limit', dimension: 'pool' };
  if (authorUsed + p.points > p.monthlyAuthorCap) return { state: 'limit', dimension: 'author' };
  const award = { key, month, recipient: t.recipient, taskId: t.id, points: p.points, state: 'reserved' };
  p.reserved += award.points; p.authors.set(t.recipient, authorUsed + award.points); b.awards.set(key, award);
  return { state: 'reserved', award };
}
function pay(b, award, active = true) {
  if (award.state === 'paid') return 'replayed';
  if (!active) return 'on_hold';
  const p = b.periods.get(award.month);
  p.reserved -= award.points; p.paid += award.points; award.state = 'paid';
  b.balances.set(award.recipient, (b.balances.get(award.recipient) || 0) + award.points);
  b.ledger.push({ rewardKey: award.key, contributionMonth: award.month, points: award.points });
  return 'paid';
}

scenario('M01', 'Company month changes at Shanghai midnight, not machine timezone', () => {
  assert.equal(monthOf('2026-11-30T15:59:59Z'), '2026-11'); assert.equal(monthOf('2026-11-30T16:00:00Z'), '2026-12');
  assert.equal(monthOf('2026-12-31T16:00:00Z'), '2027-01');
});
scenario('M02', 'Same useful template can earn in two months with new real work', () => {
  const b = book(); period(b, '2026-11'); period(b, '2026-12');
  pay(b, approve(b, task()).award); pay(b, approve(b, task({ id: 'new-task', acceptedAt: '2026-12-15T04:00:00Z' })).award);
  assert.equal(b.balances.get('author1'), 400); return { months: 2, totalPoints: 400 };
});
scenario('M03', 'More projects, users and batch children do not multiply one monthly award', () => {
  const b = book(); period(b, '2026-11'); approve(b, task());
  for (let i = 0; i < 12; i++) assert.equal(approve(b, task({ id: `child-${i}`, user: `person-${i}`, project: `project-${i}` })).state, 'duplicate');
  assert.equal(b.periods.get('2026-11').reserved, 200);
});
scenario('M04', 'Late approval is charged to the original contribution month', () => {
  const b = book(); period(b, '2026-11'); period(b, '2026-12');
  const award = approve(b, task({ approvedAt: '2026-12-05T00:00:00Z' })).award; pay(b, award);
  assert.equal(award.month, '2026-11'); assert.equal(b.periods.get('2026-11').paid, 200); assert.equal(b.periods.get('2026-12').paid, 0);
});
scenario('M05', 'Resubmitting an old task next month does not change its award key', () => {
  const b = book(); period(b, '2026-11'); period(b, '2026-12'); approve(b, task());
  assert.equal(approve(b, task({ checkedAt: '2026-12-10T00:00:00Z' })).state, 'duplicate'); assert.equal(b.awards.size, 1);
});
scenario('M06', 'New version and copied IDs keep the trusted source family', () => {
  const b = book(); period(b, '2026-11'); approve(b, task());
  assert.equal(approve(b, task({ id: 'copy-task', version: 'v2', templateId: 'copied-template' })).state, 'duplicate');
});
scenario('M07', 'Self use is not qualified work by another colleague', () => {
  const b = book(); period(b, '2026-11'); assert.equal(approve(b, task({ user: 'author1' })).state, 'ineligible');
});
scenario('M08', 'Failure, cancellation and debug do not qualify', () => {
  const b = book(); period(b, '2026-11');
  for (const status of ['failed', 'cancelled', 'debug']) assert.equal(approve(b, task({ status })).state, 'ineligible');
});
scenario('M09', 'Unknown or unsettled delivery remains evidence pending without reservation', () => {
  const b = book(), p = period(b, '2026-11');
  assert.equal(approve(b, task({ status: 'unknown' })).state, 'pending_evidence');
  assert.equal(approve(b, task({ settled: false })).state, 'pending_evidence'); assert.equal(p.reserved, 0);
});
scenario('M10', 'No adoption or independent approval is not promised income', () => {
  const b = book(), p = period(b, '2026-11');
  assert.equal(approve(b, task({ adopted: false })).state, 'pending_review');
  assert.equal(approve(b, task({ independentlyApproved: false })).state, 'pending_review'); assert.equal(p.reserved, 0);
});
scenario('M11', 'No authorized recurring budget means contribution only, not auto funding', () => {
  const b = book(); assert.equal(approve(b, task()).state, 'record_only');
  period(b, '2026-11', { authorized: false }); assert.equal(approve(b, task()).state, 'record_only'); assert.equal(b.awards.size, 0);
});
scenario('M12', 'Changing the recipient does not split an existing monthly award', () => {
  const b = book(); period(b, '2026-11'); const original = approve(b, task()).award;
  const result = approve(b, task({ id: 'later-task', recipient: 'new-maintainer' }));
  assert.equal(result.state, 'duplicate'); assert.equal(result.award.recipient, original.recipient);
});
scenario('M13', 'New month pricing cannot change an old reserved amount', () => {
  const b = book(); period(b, '2026-11'); const old = approve(b, task()).award;
  period(b, '2026-12', { points: 500 });
  const next = approve(b, task({ id: 'dec-task', acceptedAt: '2026-12-10T00:00:00Z' })).award;
  pay(b, old); pay(b, next); assert.equal(old.points, 200); assert.equal(next.points, 500);
});
scenario('M14', 'Monthly pool funds 100 full awards and never a partial prize', () => {
  const b = book(), p = period(b, '2026-11'); let accepted = 0, refused = 0;
  for (let i = 0; i < 150; i++) {
    const result = approve(b, task({ id: `task-${i}`, root: `root-${i}`, recipient: `author-${Math.floor(i / 10)}` }));
    if (result.state === 'reserved') { accepted++; if (i % 2) pay(b, result.award); }
    else { assert.equal(result.dimension, 'pool'); refused++; }
  }
  assert.equal(p.reserved + p.paid, 20000); assert.equal(accepted, 100); assert.equal(refused, 50);
  return { accepted, refused, committedPoints: 20000 };
});
scenario('M15', 'Author cap resets only for new work in a new month', () => {
  const b = book(); period(b, '2026-11'); period(b, '2026-12');
  for (let i = 0; i < 11; i++) {
    const result = approve(b, task({ id: `task-${i}`, root: `root-${i}` }));
    if (i < 10) { assert.equal(result.state, 'reserved'); if (i % 2) pay(b, result.award); }
    else assert.equal(result.dimension, 'author');
  }
  assert.equal(approve(b, task({ id: 'dec-task', acceptedAt: '2026-12-10T00:00:00Z' })).state, 'reserved');
});
scenario('M16', 'Insufficient remaining budget does not reduce the promised unit', () => {
  const b = book(), p = period(b, '2026-11', { monthlyPool: 100 });
  assert.equal(approve(b, task()).state, 'limit'); assert.equal(p.reserved, 0);
});
scenario('M17', 'Unused previous budget does not authorize next month', () => {
  const b = book(); period(b, '2026-11');
  assert.equal(approve(b, task({ acceptedAt: '2026-12-10T00:00:00Z' })).state, 'record_only');
});
scenario('M18', 'Closing new approvals still honours old reserved payment', () => {
  const b = book(), p = period(b, '2026-11'), old = approve(b, task()).award; p.open = false;
  assert.equal(approve(b, task({ root: 'new-root' })).state, 'closed'); assert.equal(pay(b, old), 'paid');
});
scenario('M19', 'Unknown November result resolved later stays in November', () => {
  const b = book(), p = period(b, '2026-11');
  assert.equal(approve(b, task({ status: 'unknown' })).state, 'pending_evidence');
  const award = approve(b, task({ completedAt: '2026-12-15T00:00:00Z' })).award;
  assert.equal(award.month, '2026-11'); assert.equal(p.reserved, 200);
});
scenario('M20', 'Opening a new period does not clear spendable balance', () => {
  const b = book(); period(b, '2026-11'); const award = approve(b, task()).award;
  pay(b, award); period(b, '2026-12'); assert.equal(b.balances.get('author1'), 200);
  assert.equal(pay(b, award), 'replayed'); assert.equal(b.ledger.length, 1);
});
scenario('M21', 'Late explicit supplement consumes original month only', () => {
  const b = book(), nov = period(b, '2026-11', { open: false }); const dec = period(b, '2026-12');
  assert.equal(approve(b, task()).state, 'closed');
  assert.equal(approve(b, task(), { supplement: true }).state, 'reserved');
  assert.equal(nov.reserved, 200); assert.equal(dec.reserved, 0);
});
scenario('M22', 'Disabled recipient holds the original promise without reassignment', () => {
  const b = book(), p = period(b, '2026-11'), award = approve(b, task()).award;
  assert.equal(pay(b, award, false), 'on_hold'); assert.equal(p.reserved, 200); assert.equal(b.ledger.length, 0);
});
scenario('M23', 'Tasks admitted before eligibility do not silently become retroactive awards', () => {
  const b = book(), p = period(b, '2026-11');
  assert.equal(approve(b, task({ eligibleAtAcceptance: false })).state, 'record_only'); assert.equal(p.reserved, 0);
});
scenario('M24', 'Legitimate zero-cost work is not excluded by a spend threshold', () => {
  const b = book(); period(b, '2026-11'); assert.equal(approve(b, task({ chargedPoints: 0, projectType: 'personal' })).state, 'reserved');
});
scenario('M25', 'Recurring nominal issuance is not a supplier cost forecast', () => {
  const annualPoints = proposal.monthlyPool * 12;
  assert.equal(annualPoints, 240000); assert.equal(annualPoints / 100, 2400);
  return { hypotheticalApprovedMonths: 12, annualPoints, nominalCny: 2400, supplierCostCny: null };
});
scenario('M26', 'False adoption or false canonical lineage cannot be verified from trusted booleans', () => {
  const b = book(); period(b, '2026-11');
  const result = approve(b, task({ inRealityCollusion: true })); pay(b, result.award);
  const copy = approve(b, task({ id: 'forged-copy', root: 'claimed-new-root', inRealitySameRoot: 'root1' })); pay(b, copy.award);
  assert.equal(b.balances.get('author1'), 400);
  return { mistakenlyPaidPoints: 400, limitation: 'Business truth, real lineage, authorization and reviewer independence require evidence outside this model.' };
}, 'known_limit');

console.log(JSON.stringify({ schema: 'template-contribution-long-term-scenarios.v1', policyRevision: 'R02',
  generatedAt: new Date().toISOString(), scope: 'Synthetic sequential proposal model; no production, database, real authorization, semantic lineage, concurrency or fraud verification.',
  productionPolicyEnabled: false, productionBalancesChanged: false, databaseAccess: false, providerCalls: false,
  proposal, timezone: 'Asia/Shanghai', scenarioCount: results.length, results }, null, 2));
