import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ISSUER, CALLBACK, params, grantCode, exchange, GrantError } from '@/lib/bridge/review-oauth';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const CONSENT='__Host-sd2-review-consent';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
const html=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const bind=(nonce:string,owner:string,p:ReturnType<typeof params>)=>createHash('sha256').update(JSON.stringify([nonce,owner,p])).digest('base64url');
const reply=(v:unknown,status=200)=>NextResponse.json(v,{status,headers});
type Context={params:{action:string}};
export async function GET(req:NextRequest,{params:route}:Context){
  if(route.action!=='authorize')return reply({error:'not_found'},404);
  try{
    const p=params(req.nextUrl.searchParams);
    const user=await getSession();
    if(!user){const login=new URL('/login',ISSUER);login.searchParams.set('next',req.nextUrl.pathname+req.nextUrl.search);return NextResponse.redirect(login,302);}
    const nonce=randomBytes(24).toString('base64url');
    const body='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 SD2 验收</title><main><h1>连接 SD2 验收</h1><p>使用 '+html(user.name)+' 的 SD2 账号。ChatGPT 可将你发起的验收任务的新稿交回复验，并收到本轮结论。</p><form method="post"><input type="hidden" name="nonce" value="'+nonce+'"><button type="submit" name="choice" value="allow">允许交回新稿</button> <button name="choice" value="deny">取消</button></form></main></html>';
    const r=new NextResponse(body,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect; frame-ancestors 'none'; base-uri 'none'"}});
    r.cookies.set(CONSENT,bind(nonce,user.id,p),{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:300});return r;
  }catch(e){return reply({error:e instanceof GrantError?e.code:'invalid_request'},400);}
}
export async function POST(req:NextRequest,{params:route}:Context){
  try{
    if(!['authorize','token'].includes(route.action))return reply({error:'not_found'},404);
    if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return reply({error:'invalid_request'},415);
    const reader=req.body?.getReader();if(!reader)return reply({error:'invalid_request'},400);
    const chunks:Uint8Array[]=[];let bytes=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8192)return reply({error:'invalid_request'},413);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if(route.action==='token')return reply(await exchange(form));
    const p=params(req.nextUrl.searchParams),user=await getSession();
    if(!user||req.headers.get('origin')!==ISSUER||bind(form.get('nonce')||'',user.id,p)!==req.cookies.get(CONSENT)?.value)return reply({error:'access_denied'},403);
    const to=new URL(CALLBACK);to.searchParams.set('iss',ISSUER);to.searchParams.set('state',p.state);
    if(form.get('choice')==='allow')to.searchParams.set('code',await grantCode(user.id,p));else to.searchParams.set('error','access_denied');
    const r=NextResponse.redirect(to,{status:303,headers});r.cookies.set(CONSENT,'',{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:0});return r;
  }catch(e){return reply({error:e instanceof GrantError?e.code:'invalid_request'},e instanceof GrantError?e.status:400);}
}
