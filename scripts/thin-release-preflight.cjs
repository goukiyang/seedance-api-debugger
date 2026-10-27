'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { verifyEquivalentCi } = require('./equivalent-ci.cjs');

const SERVICES = Object.freeze([
  'sd2-gray', 'sd2-image-studio', 'sd2-hd-derivatives', 'sd2-multiview-works',
  'sd2-template-prompts', 'sd2-role-coordinator', 'sd2-finalize-pending',
  'sd2-video-delivery', 'sd2-credit-delivery', 'sd2-credit-gateway',
  'sd2-feedback-delivery', 'sd2-periodic-credits', 'sd2-backup',
]);
function atLeast(version, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number), floor = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  }
  return true;
}
function isPie(executable) {
  const fd = fs.openSync(executable, 'r');
  try {
    const header = Buffer.alloc(18);
    if (fs.readSync(fd, header, 0, 18, 0) !== 18 || !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return false;
    return (header[5] === 1 ? header.readUInt16LE(16) : header.readUInt16BE(16)) === 3;
  } finally { fs.closeSync(fd); }
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`preflight-command-unavailable:${command}`);
  return result;
}
function sourceAt(root) {
  try {
    const source = fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim();
    return /^[a-f0-9]{40}$/.test(source) ? source : null;
  } catch { return null; }
}
function verifyServiceSources(root, source) {
  return SERVICES.map(name => {
    const result = run('systemctl', ['show', `${name}.service`, '--property=WorkingDirectory,MainPID,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp'], root);
    const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    let configured = false, processMatches = true;
    try { configured = fs.realpathSync(values.WorkingDirectory) === root && sourceAt(values.WorkingDirectory) === source; } catch {}
    if (Number(values.MainPID) > 0) {
      try { processMatches = fs.realpathSync(`/proc/${values.MainPID}/cwd`) === root
        && isPie(fs.realpathSync(`/proc/${values.MainPID}/exe`)); } catch { processMatches = false; }
    }
    const hardened = values.NoNewPrivileges === 'yes' && values.ProtectSystem === 'strict'
      && ['yes', 'true'].includes(values.ProtectHome) && values.PrivateTmp === 'yes';
    return { service: name, configured, processMatches, hardened, passed: result.status === 0 && configured && processMatches && hardened };
  });
}
function cleanAudit(report) {
  const counts = report?.metadata?.vulnerabilities;
  return Number.isInteger(counts?.high) && Number.isInteger(counts?.critical) && counts.high === 0 && counts.critical === 0;
}
function main() {
  const args = process.argv.slice(2);
  const root = fs.realpathSync(args.find(arg => arg.startsWith('--root='))?.slice(7) || process.cwd());
  const source = args.find(arg => arg.startsWith('--source='))?.slice(9);
  const equivalentCiFile = args.find(arg => arg.startsWith('--equivalent-ci='))?.slice('--equivalent-ci='.length);
  if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error('preflight-source-required');
  const load = createRequire(path.join(root, 'package.json'));
  load('@next/env').loadEnvConfig(root, false, { info() {}, error() {} });
  const next = load('next/package.json').version, sharp = load('sharp').versions.sharp;
  const checks = {
    source: sourceAt(root) === source,
    next: next.startsWith('15.') && atLeast(next, '15.5.28'),
    sharp: atLeast(sharp, '0.35.5'),
    pieNode: process.platform === 'linux' && isPie(process.execPath),
    secrets: false, audit: false, ci: false,
  };
  try { load('./src/lib/security/secrets.cjs').assertStartupSecrets(); checks.secrets = true; } catch {}
  const audit = run('npm', ['audit', '--omit=dev', '--json', '--audit-level=high'], root);
  let counts = null;
  try { const report = JSON.parse(audit.stdout); counts = report.metadata?.vulnerabilities || null; checks.audit = audit.status === 0 && cleanAudit(report); } catch {}
  let ciEvidence = 'github-actions';
  if (equivalentCiFile) {
    ciEvidence = 'server-equivalent-S49';
    checks.ci = verifyEquivalentCi(root, source, path.resolve(root, equivalentCiFile));
  } else {
    try {
      const ci = run('gh', ['api', `repos/goukiyang/seedance-api-debugger/actions/workflows/quality.yml/runs?head_sha=${source}&status=completed&per_page=10`], root);
      const runs = JSON.parse(ci.stdout).workflow_runs;
      const current = runs?.filter(item => item.head_sha === source && item.event === 'push')
        .sort((a, b) => b.id - a.id)[0];
      checks.ci = ci.status === 0 && current?.conclusion === 'success';
    } catch {}
  }
  const services = args.includes('--verify-services') ? verifyServiceSources(root, source) : null;
  const passed = Object.values(checks).every(Boolean) && (!services || services.every(service => service.passed));
  console.log(JSON.stringify({ schema: 'thin-release-preflight.v1', observedAt: new Date().toISOString(), source,
    versions: { next, sharp, node: process.version }, checks, ciEvidence,
    githubActionsVerified: ciEvidence === 'github-actions' && checks.ci,
    auditCounts: counts, services, passed }));
  if (!passed) process.exitCode = 1;
}
module.exports = { atLeast, isPie, cleanAudit, verifyServiceSources, SERVICES };
if (require.main === module) {
  try { main(); } catch { console.error('THIN_RELEASE_PREFLIGHT_UNAVAILABLE'); process.exitCode = 1; }
}
