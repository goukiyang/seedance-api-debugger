import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';

export const ISSUER='https://sd2.youdooart.com';
export const RESOURCE=ISSUER+'/api/bridge/review-mcp';
export const DISCOVERY=ISSUER+'/.well-known/oauth-protected-resource/api/bridge/review-mcp';
export const SCOPE='reviews.submit';
export const CLIENT='sd2-review-chatgpt';
export const CALLBACK='https://chatgpt.com/connector_platform_oauth_redirect';
const PREFIX='bridge_gpt_review_auth:';
const AUTH=ISSUER+'/api/bridge/review-connect/';
const digest=(s:string)=>createHash('sha256').update(s).digest('base64url');
const random=()=>randomBytes(32).toString('base64url');
const tokenPattern=/^[\w-]{43}$/;
export class GrantError extends Error { constructor(public code:string,public status=400){super(code);} }
export const resourceMetadata={resource:RESOURCE,authorization_servers:[ISSUER],scopes_supported:[SCOPE],bearer_methods_supported:['header']};
export const issuerMetadata={issuer:ISSUER,authorization_endpoint:AUTH+'authorize',token_endpoint:AUTH+'token',
  response_types_supported:['code'],grant_types_supported:['authorization_code'],scopes_supported:[SCOPE],
  code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true};
export function params(p:URLSearchParams){
  const get=(k:string)=>p.getAll(k).length===1?p.get(k)!:'';
  if(get('client_id')!==CLIENT||get('redirect_uri')!==CALLBACK||get('resource')!==RESOURCE||get('response_type')!=='code'||
     get('code_challenge_method')!=='S256'||!tokenPattern.test(get('code_challenge'))||get('scope')!==SCOPE||
     !get('state')||get('state').length>1024)throw new GrantError('invalid_request');
  return {challenge:get('code_challenge'),state:get('state'),redirect:CALLBACK,client:CLIENT,resource:RESOURCE,scope:SCOPE};
}
async function marker(owner:string){
  const row=await prisma.user.findUnique({where:{id:owner},select:{status:true,expires_at:true,password_hash:true}});
  if(!row||row.status!=='active'||row.expires_at&&row.expires_at.getTime()<=Date.now())throw new GrantError('invalid_grant',401);
  return digest(owner+'\n'+row.password_hash);
}
type Authorization=ReturnType<typeof params>;
type Grant={user:string;binding:string;expires:number;grant:Pick<Authorization,'resource'|'scope'|'client'>&{challenge?:string}};
const k=(kind:'code'|'access',token:string)=>PREFIX+kind+':'+digest(token);
async function lookup(kind:'code'|'access',token:string){
  if(!tokenPattern.test(token))throw new GrantError('invalid_grant',401);
  const row=await prisma.userPreference.findFirst({where:{key:k(kind,token)},select:{id:true,user_id:true,value_json:true}});
  if(!row)throw new GrantError('invalid_grant',401);
  const grant=JSON.parse(row.value_json) as Grant;
  if(grant.expires<=Date.now()||grant.user!==row.user_id||grant.binding!==await marker(row.user_id)||grant.grant.resource!==RESOURCE||grant.grant.scope!==SCOPE)
    throw new GrantError('invalid_grant',401);
  return {row,grant};
}
export async function grantCode(owner:string,grant:Authorization){
  const binding=await marker(owner),code=random(),now=Date.now();
  // Only this user's expired grants are reclaimed. Never store an access token or authorization code in plaintext.
  await prisma.$executeRaw`DELETE FROM "UserPreference" WHERE user_id=${owner} AND substr(key,1,length(${PREFIX}))=${PREFIX} AND json_extract(value_json,'$.expires') <= ${now}`;
  await prisma.userPreference.create({data:{user_id:owner,key:k('code',code),value_json:JSON.stringify({user:owner,binding,grant:{client:grant.client,scope:grant.scope,resource:grant.resource,challenge:grant.challenge},expires:now+180000})}});
  return code;
}
export async function exchange(p:URLSearchParams){
  for(const name of ['grant_type','client_id','code','code_verifier','redirect_uri','resource'])if(p.getAll(name).length!==1)throw new GrantError('invalid_request');
  const verifier=p.get('code_verifier')||'';
  if(p.get('grant_type')!=='authorization_code'||p.get('client_id')!==CLIENT||p.get('redirect_uri')!==CALLBACK||p.get('resource')!==RESOURCE||
    !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier))throw new GrantError('invalid_grant');
  const {row,grant}=await lookup('code',p.get('code')!);
  if(!grant.grant.challenge||!timingSafeEqual(Buffer.from(grant.grant.challenge),Buffer.from(digest(verifier))))throw new GrantError('invalid_grant');
  const token=random(),seconds=86400;
  await prisma.$transaction(async db=>{
    const used=await db.userPreference.deleteMany({where:{id:row.id,key:k('code',p.get('code')!),value_json:row.value_json}});
    if(used.count!==1)throw new GrantError('invalid_grant');
    await db.userPreference.create({data:{user_id:grant.user,key:k('access',token),value_json:JSON.stringify({...grant,grant:{client:CLIENT,resource:RESOURCE,scope:SCOPE},expires:Date.now()+seconds*1000})}});
  });
  return {access_token:token,token_type:'Bearer',expires_in:seconds,scope:SCOPE};
}
export async function toolOwner(header:string|null){
  if(!header?.startsWith('Bearer '))throw new GrantError('invalid_token',401);
  return (await lookup('access',header.slice(7))).row.user_id;
}
