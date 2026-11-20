import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createDirectoryFixture} from './gpt-directory-engineering.mjs';
const require=createRequire(import.meta.url),next=require('next/server');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fx=await createDirectoryFixture();
let browser;
try {
  await fx.db.$executeRawUnsafe('CREATE TABLE "User" (id TEXT PRIMARY KEY,status TEXT,expires_at DATETIME,password_hash TEXT)');
  for(const owner of ['review-a','review-b'])await fx.db.$executeRaw`INSERT INTO "User" (id,status,password_hash) VALUES (${owner},'active','fixture-only')`;
  const grant=fx.load('src/lib/bridge/review-oauth.ts',{'node:crypto':crypto,'@/lib/prisma':{prisma:fx.db}});
  let owner='review-a',oldPolicy=false,currentCase;
  const oauth=fx.load('src/app/api/bridge/review-connect/[action]/route.ts',{'node:crypto':crypto,'next/server':next,'@/lib/auth/session':{getSession:async()=>({id:owner,name:'隔离账号'})},'@/lib/bridge/review-oauth':grant});
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext(),results=[];
  // Intercept every URL: native browser headers/cookies enter the real handler unchanged.
  // No production session or request is used, and callback codes stay in this process.
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==grant.ISSUER||url.pathname!=='/api/bridge/review-connect/authorize')return route.abort();
    const headers=await request.allHeaders();
    const req=new next.NextRequest(url,{method:request.method(),headers,...(request.method()==='POST'?{body:request.postDataBuffer()}: {})});
    const response=await oauth[request.method()](req,{params:{action:'authorize'}});
    const responseHeaders=Object.fromEntries(response.headers);
    if(request.method()==='GET'){
      assert.equal(responseHeaders['referrer-policy'],'strict-origin');
      if(oldPolicy)responseHeaders['referrer-policy']='no-referrer';
    }else currentCase.observed={origin:headers.origin??null,referer:headers.referer??null,fetchSite:headers['sec-fetch-site']??null,fetchMode:headers['sec-fetch-mode'],choice:new URLSearchParams(request.postData()).get('choice'),status:response.status};
    if(response.status===303){
      const callback=new URL(response.headers.get('location'));
      assert.equal(callback.origin+callback.pathname,currentCase.redirect);
      currentCase.code=callback.searchParams.get('code');
      currentCase.callbackError=callback.searchParams.get('error');
      // The real handler's redirect is verified in process; never navigate to ChatGPT.
      return route.fulfill({status:200,contentType:'text/html',body:'隔离表单测试完成'});
    }
    await route.fulfill({status:response.status,headers:responseHeaders,body:await response.text()});
  });
  for(const item of [
    {name:'old-policy-control',old:true,status:403},
    {name:'registered-legacy-callback',status:303},
    {name:'registered-actual-callback',actual:true,status:303},
    {name:'nonce-mismatch',nonce:true,status:403},
    {name:'account-mismatch',account:true,status:403}
  ]){
    await context.clearCookies();owner='review-a';oldPolicy=!!item.old;currentCase={};
    const verifier=crypto.randomBytes(32).toString('base64url'),redirect=item.actual?grant.CHATGPT_CALLBACK:grant.CALLBACK;
    currentCase.redirect=redirect;
    const params=new URLSearchParams({client_id:grant.CLIENT,resource:grant.RESOURCE,redirect_uri:redirect,response_type:'code',state:'isolated-native-form',scope:grant.SCOPE,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    const page=await context.newPage();
    await page.goto(grant.ISSUER+'/api/bridge/review-connect/authorize?'+params);
    if(item.nonce)await page.locator('input[name=nonce]').evaluate(input=>{input.value='invalid-fixture-nonce';});
    if(item.account)owner='review-b';
    const posted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/bridge/review-connect/authorize');
    await page.getByRole('button',{name:'允许交回新稿',exact:true}).click();await posted;
    await page.waitForLoadState('load');
    assert.equal(currentCase.observed.status,item.status);
    assert.equal(currentCase.observed.origin,item.old?'null':grant.ISSUER);
    assert.equal(currentCase.observed.referer,item.old?null:grant.ISSUER+'/');
    if(item.status===303){
      assert.ok(currentCase.code,JSON.stringify({name:item.name,observed:currentCase.observed,callbackError:currentCase.callbackError}));
      const body=new URLSearchParams({grant_type:'authorization_code',client_id:grant.CLIENT,resource:grant.RESOURCE,code:currentCase.code,redirect_uri:redirect,code_verifier:verifier});
      const exchange=()=>oauth.POST(new next.NextRequest(grant.ISSUER+'/api/bridge/review-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()}),{params:{action:'token'}});
      assert.equal((await exchange()).status,200);assert.ok(!(await exchange()).ok);
    }else assert.equal(currentCase.code,undefined);
    results.push({name:item.name,...currentCase.observed,codeIssued:item.status===303,pkceSingleUse:item.status===303});await page.close();
  }
  const sources=['src/app/api/bridge/review-connect/[action]/route.ts','src/lib/bridge/review-oauth.ts','scripts/gpt-review-native-form.mjs','scripts/gpt-directory-engineering.mjs'];
  const proof={schema:'sd2-gpt-review-native-form.v1',passed:true,browser:'Google Chrome',browserVersion:browser.version(),sourceSha256:Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),originHeaderOverridden:false,allNetworkIntercepted:true,callbackNavigationExercised:false,redirectAdapter:'Actual handler 303 and callback validated in process; browser receives isolated completion page',productionDatabaseOpened:false,productionWrites:0,paidCalls:0,results};
  if(process.env.GPT_NATIVE_FORM_PROOF)fs.writeFileSync(process.env.GPT_NATIVE_FORM_PROOF,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(proof));
}finally{await browser?.close();await fx.close();}
