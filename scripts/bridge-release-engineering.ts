import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

async function main() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env.SD2B_RULES_PUBKEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const { parseBridgeRelease, BRIDGE_RELEASE_BASE } = await import('../src/lib/bridge/releases');
  const version = '0.6.100';
  const artifact = (suffix: string) => ({ url: `${BRIDGE_RELEASE_BASE}${version}/${suffix}.zip`, sha256: 'a'.repeat(64), size: 1024 });
  const release = { schema: 1, version, publishedAt: new Date().toISOString(), notes: 'fixture',
    extensions: [{ ...artifact('transition'), key: '' }, { ...artifact('stable'), key: 'existing-fixed-key' }],
    desktop: [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']].map(([platform, arch]) => ({ ...artifact(`${platform}-${arch}`), platform, arch })) };
  const envelope = (value: unknown) => { const payload = JSON.stringify(value); return { payload,
    sig: sign(null, Buffer.from(`sd2b-release\n${payload}`), privateKey).toString('base64') }; };
  const parsed = parseBridgeRelease(envelope(release));
  assert.equal(parsed.version, version);
  assert.equal(parsed.extension.url, release.extensions[1].url);
  assert.deepEqual(parsed.desktop.map(a => a.url), release.desktop.map(a => a.url));
  const signed = envelope(release);
  assert.throws(() => parseBridgeRelease({ ...signed, payload: signed.payload.replace('fixture', 'tampered') }));
  assert.throws(() => parseBridgeRelease(envelope({ ...release, desktop: release.desktop.slice(1) })));
  assert.throws(() => parseBridgeRelease(envelope({ ...release, desktop: [...release.desktop, release.desktop[0]] })));
  for (const url of ['https://example.invalid/evil.zip', `${BRIDGE_RELEASE_BASE}${version}/../evil.zip`, `${release.extensions[1].url}?redirect=1`]) {
    assert.throws(() => parseBridgeRelease(envelope({ ...release, extensions: [{ ...release.extensions[1], url }] })));
  }
  console.log(JSON.stringify({ passed: 8, checks: ['five_artifact_manifest_selects_fixed_id_extension_and_each_desktop_arch',
    'version_and_urls_follow_manifest', 'tampering_rejected', 'missing_platform_rejected', 'duplicate_platform_rejected',
    'foreign_origin_rejected', 'path_traversal_rejected', 'query_redirect_rejected'], networkCalls: 0, generatedTasks: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
