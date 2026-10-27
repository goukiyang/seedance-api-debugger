const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { load, mocks, deps, functions } = require('./audit-decode-upload-loader.cjs');
let calls = 0;
const fakeSharp = () => { calls++; const image = { rotate: () => image, timeout: () => image, metadata: async () => ({ width: 1, height: 1 }) }; return image; };
mocks.set('src/lib/media/sharp.ts', { default: fakeSharp, __esModule: true });
mocks.set('src/lib/assets/site-upload.ts', { uploadSiteAsset: () => { throw new Error('No persistence during decoder rejection test'); } });
let bytes;
mocks.set('src/lib/net/safe-fetch.ts', { safeFetch: async () => new Response(bytes) });
const tests = [];
const test = (name, run) => tests.push({ name, run });
test('actual reference decoder rejects disguised SVG before invoking sharp', async () => {
  bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); calls = 0;
  const { readProviderReferenceImageDimensions } = load('src/lib/provider/reference-image-safety.ts');
  await assert.rejects(readProviderReferenceImageDimensions('https://synthetic.invalid/not-svg.png'));
  assert.equal(calls, 0);
});
test('actual reference decoder rejects 50000x50000 PNG before invoking sharp', async () => {
  bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(50000,16); bytes.writeUInt32BE(50000,20); calls = 0;
  const { readProviderReferenceImageDimensions } = load('src/lib/provider/reference-image-safety.ts');
  await assert.rejects(readProviderReferenceImageDimensions('https://synthetic.invalid/huge.png'));
  assert.equal(calls, 0);
});
test('actual ordinary upload reader streams 200MiB below 50MiB RSS delta', () => {
  const result = spawnSync(process.execPath, ['--expose-gc','scripts/audit-decode-upload-memory.cjs'], { env: process.env, encoding: 'utf8', timeout: 120000 });
  console.log(result.stdout); if (result.stderr) console.error(result.stderr);
  assert.equal(result.status, 0);
});
test('shared receiver preserves bytes/hash and cleans oversize, abort and timeout', async () => {
  const { streamToTemporaryUpload } = load('src/lib/assets/streamed-upload.ts');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(),'aud-receiver-'));
  try {
    const original = Buffer.from([0,1,2,255,254,0,127]);
    const received = await streamToTemporaryUpload((async function*(){ yield original.subarray(0,2); yield original.subarray(2); })(), { directory, expectedBytes: original.length, maxBytes: 20 });
    assert.deepEqual(await fsp.readFile(received.file), original);
    assert.equal(received.hash, crypto.createHash('sha256').update(original).digest('hex'));
    assert.equal((await fsp.stat(received.file)).mode & 0o777, 0o600); await received.cleanup();
    await assert.rejects(streamToTemporaryUpload((async function*(){ yield original; })(), { directory, expectedBytes: 6, maxBytes: 6 }), error => error.code === 'UPLOAD_SIZE_MISMATCH');
    await assert.rejects(streamToTemporaryUpload((async function*(){ yield original; })(), { directory, expectedBytes: 8, maxBytes: 8 }), error => error.code === 'UPLOAD_SIZE_MISMATCH');
    await assert.rejects(streamToTemporaryUpload((async function*(){ yield original; })(), { directory, expectedBytes: 7, maxBytes: 7, expectedHash: '0'.repeat(64) }), error => error.code === 'UPLOAD_HASH_MISMATCH');
    let canceled = false; const abort = new AbortController();
    const source = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); return new Promise(resolve => setTimeout(resolve, 10)); }, cancel() { canceled = true; } });
    const timer = setTimeout(() => abort.abort(), 20);
    try { await assert.rejects(streamToTemporaryUpload(source, { directory, maxBytes: 1024*1024, signal: abort.signal }), error => error.code === 'UPLOAD_BODY_INTERRUPTED'); }
    finally { clearTimeout(timer); }
    assert.equal(canceled, true);
    await assert.rejects(streamToTemporaryUpload(new ReadableStream({ pull() { return new Promise(() => {}); } }), { directory, maxBytes: 1024, timeoutMs: 5 }), error => error.code === 'UPLOAD_BODY_TIMEOUT');
    assert.deepEqual(await fsp.readdir(directory),[]);
  } finally { await fsp.rm(directory,{recursive:true,force:true}); }
});
test('actual multipart upload reader streams file parts and rejects duplicate-file forms', async () => {
  const helper = load('src/lib/assets/streamed-upload.ts');
  class VerifiedUploadError extends Error {}
  const reader = functions('src/app/api/assets/upload/route.ts', ['decodeFileName','parseContentLength','readUploadPayload'], { ...helper,
    VerifiedUploadError, NextResponse: { json: x => x }, validateSiteUploadMetadata: () => null, MULTIPART_COMPAT_MAX_SIZE_BYTES: 8*1024*1024 });
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(),'aud-multipart-')), previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  try {
    const make = duplicate => {
      const boundary = 'synthetic-bounded-form', filename = 'fixture-\u4e2d\u6587.png'; const binary = Buffer.from([0,255,2,13,10,77]);
      const part = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`), binary, Buffer.from('\r\n')]);
      const parts = duplicate ? [part, part, Buffer.from(`--${boundary}--\r\n`)] : [part, Buffer.from(`--${boundary}--\r\n`)];
      const data = Buffer.concat(parts); let offset = 0;
      const body = new ReadableStream({ pull(controller) { if(offset===data.length) return controller.close(); const next=data.subarray(offset,Math.min(offset+5,data.length));offset+=next.length;controller.enqueue(next); } });
      return { request: new Request('https://synthetic.invalid/upload',{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(data.length)},body,duplex:'half'}), binary };
    };
    const {request,binary}=make(false), result=await reader.readUploadPayload(request);
    assert.deepEqual(await fsp.readFile(result.payload.file),binary); assert.equal(result.payload.fileName,'fixture-\u4e2d\u6587.png'); assert.equal(result.payload.mimeType,'image/png');
    await result.payload.cleanup();
    await assert.rejects(reader.readUploadPayload(make(true).request));
    assert.deepEqual(await fsp.readdir(parent),[]);
  } finally { if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;await fsp.rm(parent,{recursive:true,force:true}); }
});
test('actual publisher atomically retains exact bytes and never overwrites a conflicting original', async () => {
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'aud-publish-'));
  class VerifiedUploadError extends Error { constructor(code,message,status){super(message);Object.assign(this,{code,status});} }
  try {
    const output=path.join(directory,'public/uploads/assets'); await fsp.mkdir(output,{recursive:true});
    const api=functions('src/lib/assets/verified-upload.ts',['uploadFileVersion','uploadFileHash','publishVerifiedFile'],{
      fs:fsp, path, createHash:crypto.createHash, createReadStream:fs.createReadStream, randomUUID:crypto.randomUUID,
      privateUploadDirectory:async()=>directory, VerifiedUploadError, process:{platform:'darwin',cwd:()=>directory},
    });
    const source=path.join(directory,'temporary.upload'), original=Buffer.from('synthetic unchanged bytes');await fsp.writeFile(source,original);
    const proof={file:source,bytes:original.length,hash:crypto.createHash('sha256').update(original).digest('hex'),version:await api.uploadFileVersion(source)};
    const target=await api.publishVerifiedFile(proof,output,'original.bin'); assert.deepEqual(await fsp.readFile(target),original);
    assert.equal(await api.publishVerifiedFile(proof,output,'original.bin'),target);
    await fsp.writeFile(source,'different');const other={...proof,bytes:9,hash:crypto.createHash('sha256').update('different').digest('hex'),version:await api.uploadFileVersion(source)};
    await assert.rejects(api.publishVerifiedFile(other,output,'original.bin'),error=>error.code==='UPLOAD_STORED_FILE_INVALID');
    assert.deepEqual(await fsp.readFile(target),original);
  } finally {await fsp.rm(directory,{recursive:true,force:true});}
});
test('actual direct-upload hash wrapper shares byte checks without changing body contract', async () => {
  const { createUploadHash, UploadStreamError }=load('src/lib/assets/streamed-upload.ts');
  const { Transform, Readable }=require('node:stream');
  class VerifiedUploadError extends Error { constructor(code,message,status){super(message);Object.assign(this,{code,status});} }
  const {createHashingUploadBody}=functions('src/lib/assets/direct-upload.ts',['createHashingUploadBody'],{createUploadHash,UploadStreamError,VerifiedUploadError,Transform});
  const bytes=Buffer.from('synthetic-direct-body');const buffered=createHashingUploadBody(bytes,bytes.length);
  assert.equal(buffered.body,bytes);assert.equal(buffered.byteLength(),bytes.length);assert.equal(buffered.digest(),crypto.createHash('sha256').update(bytes).digest('hex'));
  const streamed=createHashingUploadBody(Readable.from([bytes.subarray(0,5),bytes.subarray(5)]),bytes.length);
  for await(const _ of streamed.body){} assert.equal(streamed.byteLength(),bytes.length);assert.equal(streamed.digest(),crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.throws(()=>createHashingUploadBody(bytes,1),error=>error instanceof VerifiedUploadError&&error.code==='UPLOAD_SIZE_MISMATCH');
});
test('actual upload validator confines both native video tools to local protocols and media types', async () => {
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'aud-video-inspect-'));
  class VerifiedUploadError extends Error { constructor(code,message,status){super(message);Object.assign(this,{code,status});} }
  try {
    const file=path.join(directory,'synthetic.mp4'),header=Buffer.alloc(24);header.writeUInt32BE(24,0);header.write('ftyp',4);header.write('isom',8);await fsp.writeFile(file,header);const calls=[];
    const {mediaInputFlags}=load('src/lib/media/probe-remote.ts');
    const api=functions('src/lib/assets/verified-upload.ts',['uploadKind','uploadFileVersion','inspectUpload'],{
      fs:fsp,VerifiedUploadError,limits:{image:30*1024*1024,video:200*1024*1024,audio:15*1024*1024},mediaInputFlags,
      execFileAsync:async(bin,args)=>{calls.push({bin,args});assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,pipe');assert.equal(args[args.indexOf('-format_whitelist')+1].includes('hls'),false);assert.equal(args.some(value=>/^https?:/.test(value)),false);return {stdout:bin.endsWith('ffprobe')?JSON.stringify({streams:[{codec_type:'video',width:16,height:16}],format:{format_name:'mov,mp4',duration:'1'}}):''};},
    });
    const proof=await api.inspectUpload(file,'video/mp4','synthetic-hash',24);assert.equal(proof.extension,'mp4');assert.equal(calls.length,2);
  } finally {await fsp.rm(directory,{recursive:true,force:true});}
});
test('actual POST recovers original receipt without resending and keeps writing failures unknown', async () => {
  const { NextResponse } = deps('next/server');
  class VerifiedUploadError extends Error { constructor(code,message,status=409){super(message);Object.assign(this,{code,status});} }
  const phases=new Map(), receipts=new Map();let writes=0, fault='after';
  const rawIdentity=(ownerId,input)=>({ownerId,requestId:input.requestId,hash:input.hash,fileSize:Number(input.fileSize),mimeType:input.mimeType});
  const key=x=>`${x.ownerId}:${x.requestId}`;
  mocks.set('next/server',{NextResponse}); mocks.set('src/lib/auth/session.ts',{getSession:async()=>({id:'synthetic-owner'})});
  // Authentication is covered by test-api-route; this fixture owns upload receipts.
  mocks.set('src/lib/http/route.ts',{route:(_policy,handler)=>handler});
  mocks.set('src/lib/prisma.ts',{prisma:{asset:{findFirst:async()=>null}}});
  mocks.set('src/lib/assets/verified-upload.ts',{
    VerifiedUploadError, assertUploadOwner:(expected,owner)=>{if(expected!==owner)throw new VerifiedUploadError('SESSION_CHANGED','synthetic changed owner');},
    uploadIdentity:async()=>{}, uploadRequestId:x=>x, privateUploadDirectory:async()=>{}, verifiedUploadFailure:error=>({error:error.message,code:error.code}),
  });
  mocks.set('src/lib/assets/raw-upload-state.ts',{
    rawUploadIdentity:rawIdentity, rawUploadProof:x=>x, rawUploadRecoveryToken:async()=> 'synthetic-proof', readRawUploadState:async x=>phases.get(key(x)),
    readRawUploadResult:async identity=>{const receipt=receipts.get(key(identity));if(receipt&&receipt.hash!==identity.hash)throw new VerifiedUploadError('UPLOAD_REQUEST_CONFLICT','synthetic identity conflict');return receipt;},
    transitionRawUpload:async(identity,nonce,from,to)=>{const state=phases.get(key(identity));if(state?.phase!==from||state.nonce!==nonce)throw new VerifiedUploadError('UPLOAD_RESULT_UNKNOWN','synthetic compare-and-swap rejected');const next={...state,phase:to};phases.set(key(identity),next);return next;},
    claimLegacyRawUpload:async()=>{throw new Error('Unexpected legacy claim');},
  });
  mocks.set('src/lib/assets/site-upload.ts',{
    getSiteUploadKind:mime=>mime.split('/')[0], validateSiteUploadMetadata:()=>null,
    uploadSiteAssetFile:async(file,fileName,mimeType,fileSize,hash,ownerId,requestId)=>{
      writes++;const data=await fsp.readFile(file);assert.equal(data.length,fileSize);assert.equal(crypto.createHash('sha256').update(data).digest('hex'),hash);
      if(fault==='before')throw new VerifiedUploadError('UPLOAD_IMAGE_INVALID','synthetic decode rejection',400);
      const asset={id:'synthetic-asset',assetId:'synthetic-asset',originalUrl:'/uploads/assets/synthetic.mp4',thumbnailUrl:null,fileName,fileSize,mimeType,hash,reused:false,isPubliclyReachable:true,storageProvider:'local-public'};
      receipts.set(`${ownerId}:${requestId}`,asset);if(fault==='after')throw new Error('synthetic response lost after committed receipt');return asset;
    },
  });
  mocks.set('src/lib/assets/upload-log.ts',{recordAssetUploadLog:async()=>{}});mocks.set('src/lib/media/hd-derivatives.ts',{requestHd:async()=>{}});
  const {POST}=load('src/app/api/assets/upload/route.ts');const data=Buffer.from('synthetic upload bytes'),hash=crypto.createHash('sha256').update(data).digest('hex'),nonce='a'.repeat(48);
  const identity=rawIdentity('synthetic-owner',{requestId:'original-key',hash,fileSize:data.length,mimeType:'video/mp4'});
  const invoke=(id=identity,onPull=()=>{})=>{let sent=false;const body=new ReadableStream({pull(controller){onPull();if(sent)return controller.close();sent=true;controller.enqueue(data);}}, {highWaterMark:0});return POST(new Request('https://synthetic.invalid/api/assets/upload',{method:'POST',headers:{'content-type':'video/mp4','x-file-size':String(data.length),'x-file-name':'fixture.mp4','x-upload-owner-id':'synthetic-owner','x-upload-request-id':id.requestId,'x-file-hash':id.hash,'x-raw-upload-version':'2','x-raw-upload-nonce':nonce},body,duplex:'half'}));};
  phases.set(key(identity),{...identity,nonce,phase:'prepared'});
  const unknown=await invoke();assert.equal(unknown.status,500);assert.equal((await unknown.json()).code,'UPLOAD_RESULT_UNKNOWN');assert.equal(phases.get(key(identity)).phase,'writing');
  let pulled=0;fault='none';const recovered=await invoke(identity,()=>pulled++);assert.equal(recovered.status,200);assert.equal((await recovered.json()).asset.id,'synthetic-asset');assert.equal(pulled,0);assert.equal(writes,1);
  const failed={...identity,requestId:'decode-failed'};phases.set(key(failed),{...failed,nonce,phase:'prepared'});fault='before';
  const failure=await invoke(failed);assert.equal(failure.status,400);assert.equal((await failure.json()).notAccepted,undefined);assert.equal(phases.get(key(failed)).phase,'writing');
  const repeated=await invoke(failed,()=>pulled++);assert.equal(repeated.status,409);assert.equal(writes,2);assert.equal(pulled,0);
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } }
  console.log(`${tests.length-failed}/${tests.length} decode/upload contracts passed`); process.exitCode = failed ? 1 : 0;
})();
