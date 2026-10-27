const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
process.env.SESSION_SECRET = 'synthetic-master-for-purpose-contract-0123456789';
require('tsx/cjs');
const { signPurpose, verifyPurpose } = require('../src/lib/security/signatures.ts');
const body = 'synthetic-unchanged-frozen-receipt';
const signed = signPurpose('upload', body);
assert.match(signed, /^v2:[A-Za-z0-9_-]{43}$/);
assert.equal(verifyPurpose('upload', body, signed), true);
assert.equal(verifyPurpose('pricing', body, signed), false);
assert.equal(verifyPurpose('upload', body + 'changed', signed), false);
assert.equal(verifyPurpose('upload', body, signed.replace('v2:', '')), false);
const old = createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
assert.equal(verifyPurpose('upload', body, old), false);
assert.equal(verifyPurpose('upload', body, old, { legacy: true }), true);
assert.equal(verifyPurpose('upload', body, 'v3:' + old, { legacy: true }), false);
assert.equal(verifyPurpose('upload', body, signed + '.', { legacy: true }), false);
const hex = signPurpose('media', body, 'hex');
assert.equal(verifyPurpose('media', body, hex, { encoding: 'hex' }), true);
process.env.UPLOAD_TICKET_SECRET = 'independent-upload-key-for-contract-0123456789';
assert.equal(verifyPurpose('upload', body, signed), false);
assert.equal(verifyPurpose('upload', body, old, { legacy: true }), true);
console.log('PASS purpose separation, version binding, legacy opt-in, unchanged old receipt');

// Execute the real upload token functions without loading network/storage clients.
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require.resolve('../src/lib/assets/direct-upload.ts'), 'utf8');
const ast = ts.createSourceFile('direct-upload.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['signToken', 'verifyToken', 'userUploadOwnerHash', 'userUploadPrefix']);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size);
const executable = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const upload = new Function('crypto', 'signPurpose', 'verifyPurpose', 'VerifiedUploadError',
  `const DIRECT_UPLOAD_PREFIX='seedance-direct-uploads',DIRECT_UPLOAD_TOKEN_VERSION=1;\n${executable}\nreturn {signToken,verifyToken,userUploadPrefix,userUploadOwnerHash};`)(
    require('node:crypto'), signPurpose, verifyPurpose, class extends Error {});
const owner = 'synthetic-owner';
const payload = { version: 1, key: upload.userUploadPrefix(owner) + '/synthetic.png',
  ownerHash: upload.userUploadOwnerHash(owner), expiresAt: Date.now() + 1000,
  fileSize: 16, hash: 'a'.repeat(64), mimeType: 'image/png' };
const fresh = upload.signToken(payload);
const oldBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
const oldToken = oldBody + '.' + createHmac('sha256', process.env.SESSION_SECRET).update(oldBody).digest('base64url');
assert.deepEqual(upload.verifyToken(fresh, owner), payload);
assert.deepEqual(upload.verifyToken(oldToken, owner), payload);
assert.throws(() => upload.verifyToken(fresh, 'other-owner'));
assert.throws(() => upload.verifyToken(fresh + '.extra', owner));
assert.throws(() => upload.verifyToken(oldBody + '.' + signPurpose('pricing', oldBody), owner));
const expired = upload.signToken({ ...payload, expiresAt: Date.now() - 1000 });
assert.throws(() => upload.verifyToken(expired, owner));
assert.equal(upload.verifyToken(expired, owner, true).key, payload.key);
console.log('PASS real upload token new/old/owner/tamper/expired-read-only contracts');
