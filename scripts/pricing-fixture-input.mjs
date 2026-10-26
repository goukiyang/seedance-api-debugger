import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pricingSourceHashes, pricingSourceTreeHash } from './pricing-source.mjs';

function rootInputSnapshot(runtimeRoot, markers) {
  return Object.fromEntries(['strict', 'ordinary', 'unprotected', 'wrong-schema', 'extra-field'].map(kind => {
    const directory = kind === 'strict' ? runtimeRoot : path.join(runtimeRoot, 'g19-marker-cases', kind);
    const file = path.join(directory, 'storage/image-studio-drain');
    assert.equal(markers?.[kind], file, `Bootstrap ${kind} path differs`);
    assert.equal(fs.realpathSync(file), file);
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0
      && (stat.mode & 0o777) === 0o444 && stat.size > 0 && stat.size <= 4096, `Invalid ${kind} root input`);
    const line = execFileSync('lsattr', ['-d', '--', file], { encoding: 'utf8', timeout: 3000 }).trim();
    const fields = /^(\S+)\s+([\s\S]+)$/.exec(line);
    assert.ok(fields && fields[2] === file, `Invalid ${kind} actual filesystem attributes`);
    assert.equal(fields[1].includes('i'), !['ordinary', 'unprotected'].includes(kind), `Invalid ${kind} immutable protection`);
    return [kind, { file, uid: stat.uid, mode: stat.mode & 0o777, nlink: stat.nlink, attributes: fields[1],
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }];
  }));
}

export function assertPricingFixtureInputsUnchanged(prepared) {
  const stat = fs.lstatSync(prepared.manifest);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && !(stat.mode & 0o222));
  assert.equal(createHash('sha256').update(fs.readFileSync(prepared.manifest)).digest('hex'), prepared.manifestSha256);
  assert.deepEqual(rootInputSnapshot(prepared.fixtureRoot, prepared.markers), prepared.rootInputs, 'Root engineering inputs changed');
}

function readInputs(root) {
  assert.equal(process.platform, 'linux', 'Pricing contracts require actual Linux engineering inputs, not simulated uid/stat/proc');
  const directory = process.env.PRICING_GATE_PREPARED_ROOT;
  assert.ok(directory && path.isAbsolute(directory), 'Root must prepare PRICING_GATE_PREPARED_ROOT before the complete candidate build');
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(path.dirname(directory), path.join(root, '.role-tests'));
  const match = /^pricing-prepared-([a-f0-9-]{36})$/.exec(path.basename(directory));
  assert.ok(match, 'Prepared input directory must identify one fresh run UUID');
  const parent = fs.lstatSync(directory);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && !(parent.mode & 0o077));
  const runtimeRoot = path.join(directory, 'pricing-legacy-fixture-runtime');
  assert.equal(fs.realpathSync(runtimeRoot), runtimeRoot);
  const runtimeStat = fs.lstatSync(runtimeRoot);
  assert.ok(runtimeStat.isDirectory() && !runtimeStat.isSymbolicLink() && runtimeStat.uid === process.getuid() && !(runtimeStat.mode & 0o077));
  const file = path.join(runtimeRoot, 'g19-bootstrap.json');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && !(stat.mode & 0o222) && stat.size <= 65536);
  const marker = path.join(runtimeRoot, 'storage/image-studio-drain');
  assert.equal(fs.realpathSync(marker), marker);
  const markerStat = fs.lstatSync(marker);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1 && markerStat.uid === 0
    && (markerStat.mode & 0o777) === 0o444 && markerStat.size > 0 && markerStat.size <= 4096);
  const attributes = execFileSync('lsattr', ['-d', '--', marker], { encoding: 'utf8', timeout: 3000 }).trim();
  const fields = /^(\S+)\s+([\s\S]+)$/.exec(attributes);
  assert.ok(fields && fields[1].includes('i') && fields[2] === marker, 'Root fixture isolation marker must be immutable');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(value.schema, 'pricing-legacy-bootstrap.v1'); assert.equal(value.candidateRoot, root);
  assert.equal(value.fixtureRoot, runtimeRoot); assert.equal(value.markers?.strict, marker);
  assert.match(value.source, /^[a-f0-9]{40}$/);
  assert.equal(process.env.PRICING_SOURCE_SHA, value.source);
  assert.equal(process.env.RATE_G19_FIXTURE_SOURCE_SHA, value.source);
  assert.equal(fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim(), value.source);
  assert.equal(value.uid, process.getuid(), 'Candidate fixtures must run as the provisioned build user, not root');
  assert.equal(value.gid, process.getgid());
  assert.ok(value.uid > 0 && value.gid > 0 && Number.isFinite(Date.parse(value.installedAt)) && Date.parse(value.installedAt) <= Date.now());
  const isolation = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepEqual(Object.keys(isolation).sort(), ['guard', 'installedAt', 'protocol', 'schema']);
  assert.equal(isolation.schema, 'pricing-writer-isolation.v1'); assert.equal(isolation.protocol, 'pricing-policy-v1');
  assert.equal(isolation.guard, 'reject-legacy-image-writers'); assert.equal(isolation.installedAt, value.installedAt);
  assert.ok(!fs.existsSync(path.join(directory, '.pricing-gate-claim')), 'Root inputs have already been consumed; prepare a fresh isolated run');
  return { ...value, manifest: file, runId: match[1], directory,
    manifestSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    rootInputs: rootInputSnapshot(runtimeRoot, value.markers),
    sourceTreeSha256: pricingSourceTreeHash(pricingSourceHashes(root)),
    roots: { core: runtimeRoot, toolflow: runtimeRoot, legacy: runtimeRoot } };
}

export function readPricingFixtureInputs(root) {
  try { return readInputs(root); }
  catch (cause) {
    const error = new Error(`pricing_fixture_environment: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    error.code = 'pricing_fixture_environment';
    throw error;
  }
}
