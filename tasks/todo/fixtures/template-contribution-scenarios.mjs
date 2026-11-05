import assert from 'node:assert/strict';

// Synthetic arithmetic only. No app imports, credentials, database or network.
const proposed = { adoptionPoints: 200, pool: 20000, authorCap: 2000, rootCap: 1000, projectCap: 600 };
const results = [];
function scenario(id, title, run, scope = 'model_assertion') {
  const value = run();
  results.push({ id, title, scope, result: value ?? 'as_expected' });
}
function book(overrides = {}) {
  return { ...proposed, ...overrides, open: true, reserved: 0, grossPaid: 0,
    authors: new Map(), roots: new Map(), projects: new Map(), awards: new Map(), operations: new Map(),
    balances: new Map(), ledger: [], reversals: new Set() };
}
function fact(overrides = {}) {
  return { operation: 'op1', project: 'business1', root: 'template1', version: 'v1', recipient: 'author1',
    user: 'colleague1', task: 'task1', points: 200, policy: 'proposal-r01', status: 'succeeded',
    settled: true, frozenSource: true, enrolledProject: true, enrolledTemplate: true,
    authorized: true, internal: true, acceptedWithin: true, independentApproval: true, recipientActive: true,
    ...overrides };
}
function reserve(b, f) {
  const body = JSON.stringify(f), operation = b.operations.get(f.operation);
  if (operation) return body === operation.body ? { state: 'replayed', award: operation.award } : { state: 'conflict' };
  if (!f.authorized || !f.internal || !f.frozenSource || !f.enrolledProject || !f.enrolledTemplate
    || !f.acceptedWithin || f.user === f.recipient || ['failed', 'cancelled', 'debug'].includes(f.status)) return { state: 'ineligible' };
  if (!f.recipientActive) return { state: 'on_hold' };
  if (f.status !== 'succeeded' || !f.settled) return { state: 'pending_evidence' };
  const key = `${f.project}:${f.root}`;
  if (b.awards.has(key)) return { state: 'duplicate', award: b.awards.get(key) };
  if (!b.open) return { state: 'paused' };
  if (!f.independentApproval) return { state: 'pending_review' };
  assert.ok(Number.isSafeInteger(f.points) && f.points > 0);
  assert.equal(f.points, b.adoptionPoints);
  const author = b.authors.get(f.recipient) || 0, root = b.roots.get(f.root) || 0, project = b.projects.get(f.project) || 0;
  const constraints = [
    ['pool', b.reserved + b.grossPaid, b.pool], ['author', author, b.authorCap],
    ['root', root, b.rootCap], ['project', project, b.projectCap],
  ];
  const limit = constraints.find(([, used, cap]) => used + f.points > cap);
  if (limit) return { state: 'limit', limit: limit[0] };
  const award = { ...f, key, state: 'reserved', ledgerId: null };
  b.reserved += f.points; b.authors.set(f.recipient, author + f.points);
  b.roots.set(f.root, root + f.points); b.projects.set(f.project, project + f.points);
  b.awards.set(key, award); b.operations.set(f.operation, { body, award });
  return { state: 'reserved', award };
}
function pay(b, award, recipientActive = true) {
  if (award.state === 'paid' || award.state === 'adjusted') return { state: 'replayed', ledgerId: award.ledgerId };
  if (award.state !== 'reserved') return { state: 'not_payable' };
  if (!recipientActive) return { state: 'on_hold' };
  award.state = 'paid'; award.ledgerId = `grant:${award.key}`;
  b.reserved -= award.points; b.grossPaid += award.points;
  b.balances.set(award.recipient, (b.balances.get(award.recipient) || 0) + award.points);
  b.ledger.push({ id: award.ledgerId, amount: award.points });
  return { state: 'paid', ledgerId: award.ledgerId };
}
function cancel(b, award) {
  if (award.state === 'cancelled') return 'replayed';
  if (award.state !== 'reserved') return 'requires_adjustment';
  b.reserved -= award.points;
  for (const [map, key] of [[b.authors, award.recipient], [b.roots, award.root], [b.projects, award.project]]) map.set(key, map.get(key) - award.points);
  award.state = 'cancelled';
  return 'released';
}
function reverse(b, award) {
  if (b.reversals.has(award.key)) return 'replayed';
  if (award.state !== 'paid') return 'not_paid';
  const balance = b.balances.get(award.recipient) || 0;
  if (balance < award.points) return 'requires_manual_resolution';
  b.balances.set(award.recipient, balance - award.points); award.state = 'adjusted';
  b.ledger.push({ id: `reverse:${award.key}`, amount: -award.points, related: award.ledgerId });
  b.reversals.add(award.key);
  return 'adjusted';
}

scenario('S01', 'Automatic 20-point rewards can exceed a 5-point use', () => {
  const reward = 20 * 2, stationCreditsConsumed = 5 * 2;
  assert.equal(reward - stationCreditsConsumed, 30);
  return { reward, stationCreditsConsumed, netPointsCreated: 30, supplierCostCny: null };
}, 'identified_risk');
scenario('S02', 'Reducing reward to 2 does not remove the free-use incentive', () => {
  assert.equal(2 * 2 - 0, 4); return { netPointsCreated: 4, supplierCostCny: null };
}, 'identified_risk');
scenario('S03', 'Recommended reuse-only contribution has no automatic cashable grant', () => {
  const uses = 1000, automaticReusePoints = 0;
  assert.equal(uses * automaticReusePoints, 0); return { uses, automaticGrantPoints: 0 };
});
scenario('S04', 'Previous five-user plus project example is a comparison, not enabled', () => {
  assert.equal(5 * 20 + 200, 300); return { previousProposalPoints: 300, recommendedAdoptionPoints: 200 };
});
for (const [id, override] of [
  ['S05', { user: 'author1' }], ['S06', { status: 'failed' }], ['S07', { status: 'cancelled' }],
  ['S08', { status: 'debug' }], ['S09', { internal: false }], ['S10', { authorized: false }],
  ['S11', { frozenSource: false }], ['S12', { enrolledProject: false }],
  ['S13', { enrolledTemplate: false }], ['S14', { acceptedWithin: false }],
]) scenario(id, `Reject ${Object.keys(override)[0]} mismatch`, () => assert.equal(reserve(book(), fact(override)).state, 'ineligible'));
scenario('S15', 'Unknown task retains a pending evidence outcome, not failure or payment', () => {
  const b = book(); assert.equal(reserve(b, fact({ status: 'unknown' })).state, 'pending_evidence'); assert.equal(b.reserved, 0);
});
scenario('S16', 'Success without clear station settlement is not paid', () => assert.equal(reserve(book(), fact({ settled: false })).state, 'pending_evidence'));
scenario('S17', 'Invoice still unknown is not invented as zero or required to duplicate a fixed settlement', () => {
  const b = book(); assert.equal(reserve(b, fact({ supplierCostCny: null })).state, 'reserved'); return { supplierCostCny: null };
});
scenario('S18', 'Unapproved adoption does not create a promised amount', () => {
  const b = book(); assert.equal(reserve(b, fact({ independentApproval: false })).state, 'pending_review'); assert.equal(b.reserved, 0);
});
scenario('S19', 'Same operation reservation replays once', () => {
  const b = book(), f = fact(); reserve(b, f);
  assert.equal(reserve(b, f).state, 'replayed'); assert.equal(b.reserved, 200); assert.equal(b.awards.size, 1);
});
scenario('S20', 'Changed recipient under an original operation is refused', () => {
  const b = book(); reserve(b, fact()); assert.equal(reserve(b, fact({ recipient: 'new-owner' })).state, 'conflict'); assert.equal(b.reserved, 200);
});
scenario('S21', 'New task and new version do not re-award the same project and source', () => {
  const b = book(); const first = reserve(b, fact()).award;
  const next = reserve(b, fact({ operation: 'op2', version: 'v2', task: 'task2', recipient: 'new-owner' }));
  assert.equal(next.state, 'duplicate'); assert.equal(next.award.recipient, first.recipient); assert.equal(b.reserved, 200);
});
scenario('S22', 'Copied template with retained source has the same award key', () => {
  const b = book(); reserve(b, fact()); assert.equal(reserve(b, fact({ operation: 'copy1', copyId: 'different-copy' })).state, 'duplicate');
});
scenario('S23', 'One batch and more users do not multiply a project award', () => {
  const b = book(); reserve(b, fact());
  for (let i = 0; i < 12; i++) assert.equal(reserve(b, fact({ operation: `batch-${i}`, user: `person-${i}`, task: `child-${i}` })).state, 'duplicate');
  assert.equal(b.reserved, 200);
});
scenario('S24', 'Different genuine projects can qualify separately', () => {
  const b = book(); reserve(b, fact()); assert.equal(reserve(b, fact({ operation: 'op2', project: 'business2' })).state, 'reserved'); assert.equal(b.reserved, 400);
});
for (const [id, dimension, expected] of [['S25', 'author', 10], ['S26', 'root', 5], ['S27', 'project', 3]]) {
  scenario(id, `Reserved and paid amounts both consume ${dimension} cap`, () => {
    const b = book(); let accepted = 0;
    for (let i = 0; i <= expected; i++) {
      const f = fact({ operation: `op-${i}`, root: dimension === 'root' ? 'template1' : `root-${i}`,
        project: dimension === 'project' ? 'business1' : `business-${i}` });
      const result = reserve(b, f);
      if (result.state === 'reserved') { accepted++; if (i % 2 === 0) pay(b, result.award); }
      else { assert.equal(result.state, 'limit'); assert.equal(result.limit, dimension); }
    }
    assert.equal(accepted, expected); assert.equal(b.reserved + b.grossPaid, expected * 200);
    return { accepted, committedPoints: b.reserved + b.grossPaid };
  });
}
scenario('S28', 'Global 20000-point budget funds at most 100 full awards', () => {
  const b = book(); let accepted = 0, refused = 0;
  for (let i = 0; i < 150; i++) {
    const result = reserve(b, fact({ operation: `op-${i}`, project: `business-${i}`, root: `root-${i}`, recipient: `author-${Math.floor(i / 10)}` }));
    if (result.state === 'reserved') { accepted++; pay(b, result.award); } else { assert.equal(result.limit, 'pool'); refused++; }
  }
  assert.equal(accepted, 100); assert.equal(refused, 50); assert.equal(b.grossPaid, 20000);
  return { accepted, refused, grossPaidPoints: b.grossPaid, nominalQuotaCny: 200, supplierCostCny: null };
});
scenario('S29', 'An insufficient remainder is not silently used as a smaller prize', () => {
  const b = book({ pool: 100 }); assert.equal(reserve(b, fact()).state, 'limit'); assert.equal(b.reserved, 0);
});
scenario('S30', 'Exactly one remaining full award can be reserved', () => {
  const b = book({ pool: 200 }); assert.equal(reserve(b, fact()).state, 'reserved');
  assert.equal(reserve(b, fact({ operation: 'op2', root: 'root2', project: 'business2' })).limit, 'pool');
});
scenario('S31', 'Lost payout acknowledgement does not append another ledger grant', () => {
  const b = book(), award = reserve(b, fact()).award;
  const first = pay(b, award), replay = pay(b, award);
  assert.equal(replay.ledgerId, first.ledgerId); assert.equal(b.ledger.length, 1); assert.equal(b.balances.get('author1'), 200);
});
scenario('S32', 'Paused campaign stops new promises but honours reserved ones', () => {
  const b = book(), award = reserve(b, fact()).award; b.open = false;
  assert.equal(reserve(b, fact({ operation: 'op2', project: 'business2' })).state, 'paused'); assert.equal(pay(b, award).state, 'paid');
});
scenario('S33', 'Inactive recipient preserves reservation without crediting another account', () => {
  const b = book(), award = reserve(b, fact()).award;
  assert.equal(pay(b, award, false).state, 'on_hold'); assert.equal(b.reserved, 200); assert.equal(b.ledger.length, 0);
});
scenario('S34', 'Cancelling an unpaid promise releases limits but retains original receipt', () => {
  const b = book(), f = fact(), award = reserve(b, f).award;
  assert.equal(cancel(b, award), 'released'); assert.equal(cancel(b, award), 'replayed'); assert.equal(b.reserved, 0);
  assert.equal(reserve(b, fact({ operation: 'new-op' })).state, 'duplicate'); assert.equal(pay(b, award).state, 'not_payable');
});
scenario('S35', 'Paid correction appends history once and does not reopen reward eligibility', () => {
  const b = book(), award = reserve(b, fact()).award; pay(b, award);
  assert.equal(reverse(b, award), 'adjusted'); assert.equal(reverse(b, award), 'replayed');
  assert.equal(b.ledger.length, 2); assert.equal(b.ledger[0].amount, 200); assert.equal(b.ledger[1].amount, -200);
  assert.equal(b.balances.get('author1'), 0); assert.equal(b.grossPaid, 200);
});
scenario('S36', 'Spent erroneous rewards are not automatically made into negative balance', () => {
  const b = book(), award = reserve(b, fact()).award; pay(b, award); b.balances.set('author1', 0);
  assert.equal(reverse(b, award), 'requires_manual_resolution'); assert.equal(b.ledger.length, 1); assert.equal(b.balances.get('author1'), 0);
});
scenario('S37', 'A later prize-setting edit cannot rewrite the original receipt', () => {
  const b = book(), f = fact(), original = reserve(b, f).award; b.adoptionPoints = 500;
  const replay = reserve(b, f); assert.equal(replay.state, 'replayed'); assert.equal(replay.award.points, 200); assert.equal(pay(b, original).state, 'paid');
});
scenario('S38', 'A wrong independent approval still causes a wrong award', () => {
  const b = book(), result = reserve(b, fact({ independentApproval: true, inRealityCollusion: true }));
  assert.equal(result.state, 'reserved'); pay(b, result.award);
  return { mistakenlyPaidPoints: 200, limitation: 'The model cannot establish whether a claimed business adoption is true.' };
}, 'known_limit');
scenario('S39', 'Old 30-author five-peer proposal exceeds the proposed global budget', () => {
  const requested = 30 * 10 * 5 * 20;
  assert.equal(requested, 30000); assert.equal(requested - proposed.pool, 10000);
  return { hypotheticalAuthors: 30, templatesPerAuthor: 10, peersPerTemplate: 5, requestedPoints: requested, budgetShortfall: 10000 };
});
scenario('S40', 'Full-budget adoption review still has nonzero staffing cost', () => {
  const awards = proposed.pool / proposed.adoptionPoints, assumedMinutesPerReview = 1;
  assert.equal(awards * assumedMinutesPerReview, 100);
  return { awards, assumedMinutesPerReview, hypotheticalReviewMinutes: 100, observedStaffingTime: null };
}, 'operating_assumption');

console.log(JSON.stringify({ schema: 'template-contribution-rule-scenarios.v1', generatedAt: new Date().toISOString(),
  scope: 'Synthetic in-memory proposal model; not production authorization, fraud detection, SQLite concurrency or integration verification.',
  productionPolicyEnabled: false, productionBalancesChanged: false, databaseAccess: false, providerCalls: false,
  proposal: proposed, recommendedAutomaticReusePoints: 0, scenarioCount: results.length,
  identifiedRisks: results.filter(row => row.scope === 'identified_risk').map(row => row.id),
  knownLimits: results.filter(row => row.scope === 'known_limit').map(row => row.id), results }, null, 2));
