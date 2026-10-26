import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/lib/auth/password';
import { maintainAccountSessionBinding } from '../src/lib/auth/session-account-binding';
import { createSession, getSessionByToken, login, requireAdmin } from '../src/lib/auth/session';

async function main() {
  const base = { id:'session-fixture', name:'Fixture', username:'fixture',email:'fixture@example.invalid',
    role:'user',account_type:'internal',feature_profile_id:null as string|null,user_profile:'other',status:'active',expires_at:null,
    password_hash:hashPassword('offline-only'),mobile:null,avatar_url:null,feishu_user_id:null,feishu_open_id:null,
    feishu_union_id:null,feishu_tenant_key:null,feishu_employee_no:null,feishu_department_ids:null,last_feishu_sync_at:null };
  let row = { ...base };
  let resetOnUpdate = false;
  // Stub only the local Prisma methods; there is no database or network call.
  const findUnique = prisma.user.findUnique, findFirst = prisma.user.findFirst, updateMany = prisma.user.updateMany;
  Object.assign(prisma.user, {
    findUnique: async () => ({ ...row }),
    findFirst: async () => ({ ...row }),
    updateMany: async (args: {where:{password_hash:string};data:unknown}) => {
      assert.equal(args.where.password_hash,row.password_hash);
      if(resetOnUpdate) row.password_hash=maintainAccountSessionBinding(row,row,hashPassword('changed-offline-only'));
      return { count: 1 };
    },
  });
  try {
    const oldCookie = await createSession(row.id);
    assert.equal((await getSessionByToken(oldCookie))?.id,row.id);
    const before={...row};
    row.feature_profile_id='internal_email_authorized';
    row.password_hash=maintainAccountSessionBinding(before,row);
    const granted=await createSession(row.id);
    assert.equal(await getSessionByToken(oldCookie),null);
    const user=await getSessionByToken(granted);
    assert.equal(user?.feature_profile_id,'internal_email_authorized');
    assert.ok(!Object.hasOwn(user!,'password_hash'));
    assert.throws(()=>requireAdmin(user),error=>Boolean(error && typeof error==='object' && 'status' in error && error.status===403));
    assert.equal(await getSessionByToken(granted.slice(0,-1)+'x'),null);
    const next={...row,account_type:'external',feature_profile_id:'external_limited'};
    next.password_hash=maintainAccountSessionBinding(row,next);
    row=next;
    assert.equal(await getSessionByToken(oldCookie),null);
    assert.equal(await getSessionByToken(granted),null);
    assert.equal((await getSessionByToken(await createSession(row.id)))?.account_type,'external');
    const preDelete=await createSession(row.id);
    const deleted={...row,status:'deleted'};
    deleted.password_hash=maintainAccountSessionBinding(row,deleted);
    row=deleted;
    assert.equal(await getSessionByToken(preDelete),null);
    await assert.rejects(createSession(row.id));
    const restored={...row,status:'active'};
    restored.password_hash=maintainAccountSessionBinding(row,restored);
    row=restored;
    assert.equal(await getSessionByToken(oldCookie),null);
    assert.equal(await getSessionByToken(preDelete),null);
    const valid=await login(base.email,'offline-only');
    assert.ok(!('error' in valid));
    resetOnUpdate=true;
    const raced=await login(base.email,'offline-only');
    assert.ok('error' in raced && raced.status===401, 'a reset during login cannot mint a current cookie');
    resetOnUpdate=false;
    row={...base};
    assert.equal((await getSessionByToken(oldCookie))?.id,row.id,'other legacy accounts stay compatible');
    const payload=Buffer.from(row.id).toString('base64');
    const signature=crypto.createHmac('sha256',process.env.SESSION_SECRET||'dev-secret-change-in-production').update(payload).digest('base64');
    assert.equal((await getSessionByToken(payload+'.'+signature))?.id,row.id);
    console.log(JSON.stringify({actualSessionReader:true,signatureAndRoleBoundary:true,grantRevokeDeleteRestore:true,
      passwordResetRaceDenied:true,legacySessionsRetained:true,secretsNotProjected:true,noDatabaseOrNetwork:true}));
  } finally { Object.assign(prisma.user,{findUnique,findFirst,updateMany}); }
}
void main().catch(()=>{console.error('ACC1 offline session check failed');process.exitCode=1;});
