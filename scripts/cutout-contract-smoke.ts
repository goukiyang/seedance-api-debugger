import assert from 'node:assert/strict';
import { cutoutBusinessCredential, cutoutRoute, cutoutServiceBase, proxyCutout, rewriteCutoutUrls } from '../src/lib/cutout/proxy';
import { cutoutResultReference } from '../src/lib/cutout/client';

async function main() {
  let checks = 0;
  const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
  const user = { id: 'fixture-user', role: 'admin', account_type: 'internal' };
  const member = {id:'member-a',role:'user',account_type:'internal',feishu:{open_id:'fixture-open-id'}};
  const fixtureKey = 'fixture-business-key-not-a-real-credential';
  const env = { CUTOUT_BUSINESS_KEYS: JSON.stringify({ [user.id]: fixtureKey }) };
  const request = (path: string, init: RequestInit = {}) => new Request(`https://sd2.youdooart.com/api/cutout/${path}`, {
    ...init, headers: { origin: 'https://sd2.youdooart.com', host: 'sd2.youdooart.com', ...Object.fromEntries(new Headers(init.headers)) },
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reply = () => Response.json({ success: true });
  let identityReply = () => Response.json({success:true,owner_id:'legacy-api-key',kind:'legacy_api',credential_id:null,scopes:['business','legacy']});
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return String(url).endsWith('/api/v1/identity') ? identityReply() : reply(); };
  check(cutoutServiceBase({}) === 'https://cutout.youdooart.com', 'default is production cutout service');
  for (const url of ['https://user:pass@cutout.youdooart.com', 'http://external.invalid', 'https://cutout.youdooart.com/api/v1']) {
    assert.throws(() => cutoutServiceBase({ CUTOUT_SERVICE_BASE_URL: url })); checks++;
  }
  check(cutoutBusinessCredential(env, user.id) === fixtureKey, 'configured exact account');
  check(cutoutBusinessCredential(env, 'other') === null, 'no other account fallback');
  check(cutoutBusinessCredential({ CUTOUT_BUSINESS_KEYS: '{' }, user.id) === null, 'corrupt config fails closed');
  check(cutoutBusinessCredential({ CUTOUT_BUSINESS_KEYS: JSON.stringify({ [user.id]: fixtureKey, other: fixtureKey }) }, user.id) === null, 'shared identity rejected');
  check(cutoutBusinessCredential({ CUTOUT_BUSINESS_KEYS: JSON.stringify({ [user.id]: fixtureKey, other: 'fixture-key-alias-same-owner' }) }, user.id) === null, 'multiple SD2 bindings rejected even when keys differ');
  for (const path of [['v1', 'worker', 'heartbeat'], ['v1', 'admin', 'external-keys'], ['v1', 'results', 'id', '..'], ['v1', 'results', 'id', '%2fsecret'], ['v1', 'jobs', 'id/extra']]) check(cutoutRoute(path, 'POST') === null, 'nonbusiness route denied');
  for (const [path, method] of [['v1/assets', 'POST'], ['v1/jobs', 'POST'], ['v1/jobs/history', 'GET'], ['v1/jobs/job-1', 'DELETE'], ['v1/results/job-1/file.png', 'GET'], ['cutout', 'POST'], ['characters/split-cutout', 'POST']]) check(Boolean(cutoutRoute(path.split('/'), method)), 'business route allowed');
  const capability = { success: true, worker: { online: true, paused: false, models: [{ id: 'birefnet', available: true }] }, dispatch: { available: true }, limits: { max_upload_mb: 15 } };
  reply = () => Response.json(capability);
  let response = await proxyCutout(request('v1/capabilities'), ['v1', 'capabilities'], null, {}, fetcher);
  check(response.status === 401 && calls.length === 0, 'unauthenticated does not reach upstream');
  response = await proxyCutout(request('v1/capabilities'), ['v1', 'capabilities'], { ...user, account_type: 'external' }, env, fetcher);
  check(response.status === 403 && calls.length === 0, 'external account cannot enter even with an admin role');
  response = await proxyCutout(request('v1/capabilities'), ['v1', 'capabilities'], user, {}, fetcher);
  const missing = await response.json();
  check(missing.integration.configured === false && missing.integration.ready === false && missing.worker.online === true, 'online service does not mean business identity connected');
  const before = calls.length;
  response = await proxyCutout(request('v1/assets', { method: 'POST', body: 'fixture' }), ['v1', 'assets'], user, {}, fetcher);
  check(response.status === 503 && calls.length === before && (await response.json()).submission_made === false, 'missing identity stops upload and submit');
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { origin: 'https://external.invalid' }, body: '{}' }), ['v1', 'jobs'], user, env, fetcher);
  check(response.status === 403 && calls.length === before, 'cross-site mutation blocked');
  response = await proxyCutout(request('v1/capabilities'), ['v1', 'capabilities'], user, env, fetcher);
  check((await response.json()).integration.ready === true && calls.at(-2)?.url.endsWith('/api/v1/identity'), 'metadata-only identity probe before ready');
  check(new Headers(calls.at(-2)?.init?.headers).get('x-api-key') === fixtureKey, 'server bound credential used');
  const payload = { asset_id: 'asset-fixture', kind: 'characters', parameters: { settings: { hole_repair: 35 }, character_split_settings: { manual_boxes: [{ id: '1', x: 10, y: 20, w: 50, h: 60 }] } } };
  reply = () => Response.json({ job_id: 'job-fixture', status: 'queued', poll_url: '/api/v1/jobs/job-fixture' }, { status: 202 });
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-retry-key-1', cookie: 'fixture-sd2-cookie', authorization: 'fixture-browser', 'x-api-key': 'fixture-browser-key' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  const submission = await response.json(), forwarded = new Headers(calls.at(-1)?.init?.headers);
  check(response.status === 202 && submission.poll_url === '/api/cutout/v1/jobs/job-fixture', 'async job and poll rewrite');
  check(forwarded.get('idempotency-key') === 'fixture-retry-key-1', 'idempotency forwarded intact');
  check(!forwarded.has('cookie') && !forwarded.has('authorization') && forwarded.get('x-api-key') === fixtureKey, 'no browser auth forwarded');
  check(calls.at(-1)?.init?.body === JSON.stringify(payload), 'parameters and original asset unchanged');
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  check(response.status === 400, 'retry key required');
  const invalidBefore = calls.length;
  response = await proxyCutout(request('v1/jobs', { method: 'POST', body: JSON.stringify({ ...payload, kind: 'worker' }) }), ['v1', 'jobs'], user, env, fetcher);
  check(response.status === 400 && calls.slice(invalidBefore).every(call => call.url.endsWith('/identity')), 'unsupported kind rejected before upstream');
  const rewritten = rewriteCutoutUrls({ result_url: '/api/v1/results/j/a.png', filename: '/api/v1/results/j/a.png', mask_url: 'https://evil.invalid/api/v1/results/j/a.png', nested: [{ trim_url: 'https://cutout.youdooart.com/api/v1/results/j/b.png' }] }, 'https://cutout.youdooart.com') as Record<string, unknown>;
  check(rewritten.result_url === '/api/cutout/v1/results/j/a.png' && rewritten.mask_url === null && rewritten.filename === '/api/v1/results/j/a.png', 'URL rewrite confines media origin without corrupting filename');
  check(cutoutResultReference('/api/cutout/v1/results/j/a.png') === '/api/v1/results/j/a.png', 'continuation job references exact upstream result');
  assert.throws(() => cutoutResultReference('https://external.invalid/a.png')); checks++;
  reply = () => Response.json({ detail: { code: 'JOB_NOT_CANCELABLE', message: '/private/path fixture-secret' } }, { status: 409 });
  response = await proxyCutout(request('v1/jobs/j', { method: 'DELETE' }), ['v1', 'jobs', 'j'], user, env, fetcher);
  check(response.status === 409 && !(await response.text()).includes('fixture-secret'), 'running cancel conflict preserved and detail private');
  reply = () => new Response('<script>fixture-secret</script>', { status: 502, headers: { 'content-type': 'text/html' } });
  response = await proxyCutout(request('v1/jobs/j'), ['v1', 'jobs', 'j'], user, env, fetcher);
  check(response.status === 502 && !(await response.text()).includes('<script>'), 'non-json upstream error safe');
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-retry-key-1' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  check(response.status === 502 && (await response.json()).submission_made === null, 'upstream 5xx after submission cannot claim unsubmitted');
  reply = () => Response.json({ detail: { code: 'CUTOUT_MAINTENANCE', accepted: false, message: 'fixture-private-path' } }, { status: 503 });
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-retry-key-1' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  const maintenance = await response.json();
  check(response.status === 503 && maintenance.submission_made === false && response.headers.get('retry-after') === '60' && !maintenance.message.includes('fixture-private'), 'explicit maintenance rejection is safe and unsubmitted');
  reply = () => Response.json({ detail: { code: 'CUTOUT_MAINTENANCE_CONTROL_UNAVAILABLE', accepted: false } }, { status: 503 });
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-retry-key-1' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  check((await response.json()).submission_made === false, 'unsafe maintenance control also explicitly rejected before acceptance');
  reply = () => Response.json({ detail: { code: 'CUTOUT_MAINTENANCE' } }, { status: 503 });
  response = await proxyCutout(request('v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-retry-key-1' }, body: JSON.stringify(payload) }), ['v1', 'jobs'], user, env, fetcher);
  check((await response.json()).submission_made === null, 'maintenance without explicit rejection stays uncertain');
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'set-cookie': 'fixture-upstream-cookie' } });
  response = await proxyCutout(request('v1/results/j/a.png'), ['v1', 'results', 'j', 'a.png'], user, env, fetcher);
  check(response.status === 200 && response.headers.get('cache-control') === 'private, no-store' && !response.headers.has('set-cookie') && (await response.arrayBuffer()).byteLength === 3, 'download streams bytes privately and strips upstream cookies');
  const form = new FormData(); form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'fixture.png');
  reply = () => Response.json({ success: true, asset_id: 'fixture-asset' }, { status: 201 });
  response = await proxyCutout(request('v1/assets', { method: 'POST', body: form }), ['v1', 'assets'], user, env, fetcher);
  check(response.status === 201 && calls.at(-1)?.init?.body instanceof ReadableStream, 'multipart file body streamed without URL shortcut');
  reply = () => Response.json({ items: [], total: 0 });
  await proxyCutout(request('v1/jobs/history?limit=12&offset=24&owner=other'), ['v1', 'jobs', 'history'], user, env, fetcher);
  check(calls.at(-1)?.url.endsWith('?limit=12&offset=24'), 'pagination forwarded, client ownership query ignored');
  response = await proxyCutout(request('v1/jobs/j'), ['v1', 'jobs', 'j'], user, env, async (url, init) => { if(String(url).endsWith('/identity'))return identityReply(); throw Error('fixture network'); });
  check(response.status === 502 && (await response.json()).submission_made === null, 'network uncertainty never masquerades as unsubmitted');
  const bindings = {CUTOUT_BUSINESS_KEYS:JSON.stringify({[user.id]:{key:fixtureKey,expectedOwnerId:'legacy-api-key'},[member.id]:{key:'fixture-independent-member-key',expectedOwnerId:'sd2:member-a'},'member-b':{key:'fixture-independent-member-b-key',expectedOwnerId:'sd2:member-b'}})};
  check(cutoutBusinessCredential(bindings,member.id)==='fixture-independent-member-key','multi-owner exact member binding');
  for(const broken of [
    {[user.id]:{key:fixtureKey,expectedOwnerId:'same'},[member.id]:{key:fixtureKey+'b',expectedOwnerId:'same'}},
    {[user.id]:{key:fixtureKey,expectedOwnerId:'a'},[member.id]:{key:fixtureKey,expectedOwnerId:'b'}},
    {[user.id]:fixtureKey,[member.id]:{key:fixtureKey+'b',expectedOwnerId:'b'}},
    {[member.id]:{key:fixtureKey}},
  ])check(cutoutBusinessCredential({CUTOUT_BUSINESS_KEYS:JSON.stringify(broken)},member.id)===null,'ambiguous binding fails closed');
  identityReply=()=>Response.json({success:true,owner_id:'sd2:member-a',kind:'external',credential_id:'fixture-key-a',scopes:['business']});
  reply=()=>Response.json(capability);
  response=await proxyCutout(request('v1/capabilities'),['v1','capabilities'],member,bindings,fetcher);
  const readyMember=await response.json();
  check(response.ok&&readyMember.integration.ready&&!JSON.stringify(readyMember).includes('fixture-key-a'),'member gets readiness without identity secrets');
  for(const identity of [
    {success:true,owner_id:'sd2:member-b',kind:'external',credential_id:'fixture-key-b',scopes:['business']},
    {success:true,owner_id:'sd2:member-a',kind:'worker',credential_id:'fixture-key-a',scopes:['business']},
    {success:true,owner_id:'sd2:member-a',kind:'admin',credential_id:'fixture-key-a',scopes:['business']},
    {success:true,owner_id:'sd2:member-a',kind:'external',credential_id:'fixture-key-a',scopes:[]},
    {success:true,owner_id:'sd2:member-a',kind:'external',credential_id:null,scopes:['business']},
  ]){
    identityReply=()=>Response.json(identity); const count=calls.length;
    response=await proxyCutout(request('v1/assets',{method:'POST',body:'fixture'}),['v1','assets'],member,bindings,fetcher);
    check(response.status===503&&(await response.json()).submission_made===false&&calls.slice(count).every(call=>call.url.endsWith('/identity')),'wrong or nonbusiness identity cannot upload');
  }
  identityReply=()=>Response.json({detail:{code:'UNAUTHORIZED'}},{status:401});
  response=await proxyCutout(request('v1/capabilities'),['v1','capabilities'],member,bindings,fetcher);
  check(!(await response.json()).integration.ready,'revoked key is not ready');
  response=await proxyCutout(request('v1/assets',{method:'POST',body:'fixture'}),['v1','assets'],member,bindings,async()=>{throw Error('identity unavailable')});
  check(response.status===503&&(await response.json()).submission_made===false,'identity network failure proves no business forwarding');
  console.log(JSON.stringify({ checks, passed: true, scope: 'in-memory proxy contract only', realImageJobs: 0, fees: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
