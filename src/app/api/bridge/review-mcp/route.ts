import { createHash } from 'node:crypto';
import { NextRequest,NextResponse } from 'next/server';
import { pairSource, componentHTML, reviewResource } from '@/lib/bridge/review-pairing';
import { toolOwner, DISCOVERY, SCOPE, GrantError } from '@/lib/bridge/review-oauth';
import { reviewImage, type FileRef } from '@/lib/bridge/review-tool-image';
import { boundedJson } from '@/lib/bridge/review-request';
import { revisionForTool, ReviewError } from '@/lib/bridge/gpt-review';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=150;
const scopes=[{type:'oauth2',scopes:[SCOPE]}];
const files=['image','image2','image3','image4','image5','image6'];
const artifact={type:'object',properties:{file_id:{type:'string'},download_url:{type:'string'},mime_type:{type:'string'},file_name:{type:'string'}},required:['file_id','download_url']};
const tool={name:'submit_revision',title:'交回本轮改稿',description:'在用户发起验收的原对话中交回本次完整成品。若返回 revise，按具体改法在本对话修改再用新单号交回。pass 或 stop 即停止。',securitySchemes:scopes,
  inputSchema:{type:'object',properties:{delivery:{type:'string',description:'本轮验收单号'},text:{type:'string',maxLength:20000,description:'本轮实际交付的完整正文，纯图用空字符串'},...Object.fromEntries(files.map(f=>[f,artifact]))},required:['delivery','text'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true},
  _meta:{securitySchemes:scopes,'openai/fileParams':files,'openai/toolInvocation/invoking':'正在复验新稿','openai/toolInvocation/invoked':'本轮验收已返回'}};
const widgetMime='text/html;profile=mcp-app';
const bindTool={name:'link_review',title:'核对验收原对话',description:'首次交回前，请先在用户点验收的原对话调用本工具。SD2 会自动核对原对话。',inputSchema:{type:'object',properties:{delivery:{type:'string'}},required:['delivery'],additionalProperties:false},securitySchemes:scopes,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true},
  _meta:{securitySchemes:scopes,ui:{resourceUri:reviewResource},'openai/outputTemplate':reviewResource}};
const headers={'Cache-Control':'no-store',Vary:'Authorization'};
const challenge='Bearer resource_metadata="'+DISCOVERY+'", scope="'+SCOPE+'"';
const versions=['2025-11-25','2025-06-18','2025-03-26'];
const response=(id:unknown,result:unknown)=>NextResponse.json({jsonrpc:'2.0',id,result},{headers});
const failure=(id:unknown,code:number,message:string,status=200)=>NextResponse.json({jsonrpc:'2.0',id,error:{code,message}},{status,headers});
export async function POST(req:NextRequest){
  const origin=req.headers.get('origin');
  if(origin && !['https://chatgpt.com','https://sd2.youdooart.com'].includes(origin))return failure(null,-32600,'Origin not permitted',403);
  let body:Record<string,unknown>;
  try{body=await boundedJson(req,80000);}catch(e){return failure(null,-32700,'Invalid request',e instanceof ReviewError?e.status:400);}
  const {id,method}=body, p=body.params as Record<string,unknown>|undefined;
  if(body.jsonrpc!=='2.0'||typeof method!=='string')return failure(null,-32600,'Invalid Request',400);
  if(method==='notifications/initialized'&&id===undefined)return new Response(null,{status:202,headers});
  if(typeof id!=='number'&&typeof id!=='string')return failure(null,-32600,'Request ID required',400);
  if(method==='initialize')return response(id,{protocolVersion:versions.includes(String(p?.protocolVersion))?p?.protocolVersion:versions[0],capabilities:{tools:{},resources:{}},serverInfo:{name:'sd2-review',version:'1.0.0'}});
  if(method==='ping')return response(id,{});
  if(method==='tools/list')return response(id,{tools:[bindTool,tool]});
  if(method==='resources/list')return response(id,{resources:[{uri:reviewResource,name:'验收原对话确认',mimeType:widgetMime}]});
  if(method==='resources/read'&&p?.uri===reviewResource)return response(id,{contents:[{uri:reviewResource,mimeType:widgetMime,text:componentHTML,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetCSP':{connect_domains:[],resource_domains:[]}}}]});
  if(method!=='tools/call'||!p||![tool.name,bindTool.name].includes(String(p.name)))return failure(id,-32601,'Unknown method or tool');
  try{
    const owner=await toolOwner(req.headers.get('authorization')), a=p.arguments as Record<string,unknown>|undefined,meta=p._meta as Record<string,unknown>|undefined;
    const subject=meta?.['openai/subject'],session=meta?.['openai/session'];
    if(typeof subject!=='string'||!subject||typeof session!=='string'||!session)throw new ReviewError('无法核对原 ChatGPT 对话，请从原任务使用已连接的工具');
    if(!a||typeof a.delivery!=='string')throw new ReviewError('请附上验收单号与实际新稿');
    const connection=createHash('sha256').update(JSON.stringify([owner,subject,session,meta?.['openai/organization']||''])).digest('hex');
    if(p.name==='link_review'){
      const link=await pairSource(owner,a.delivery,connection);
      return response(id,{content:[{type:'text',text:link.linked?'原对话已确认，可以提交完整改稿。':'等待源页面自动确认。请完成本版并调用 submit_revision；若仍在核对，请稍后按同一单号继续。'}],_meta:link.proof?{sd2ReviewProof:link.proof}:{}});
    }
    if(typeof a.text!=='string'||a.text.length>20000)throw new ReviewError('请提供完整成品正文');
    const inputFiles=files.filter(name=>a[name]).map(name=>a[name] as FileRef);
    if(inputFiles.some(x=>!x||typeof x.file_id!=='string'||!x.file_id))throw new ReviewError('附件尚未完整收到');
    const result=await revisionForTool(owner,a.delivery,a.text,inputFiles.map(x=>x.file_id!),async()=>{
      const images:string[]=[];let bytes=0;
      for(const name of files){if(!a[name])continue;const pic=await reviewImage(a[name] as FileRef,2097152-bytes);images.push(pic.src);bytes+=pic.bytes;}
      return images;
    },connection);
    return response(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
  }catch(e){
    if(e instanceof GrantError)return NextResponse.json({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'请先连接 SD2 验收'}],_meta:{'mcp/www_authenticate':[challenge+', error="invalid_token", error_description="Connect your SD2 account"']}}},{headers:{...headers,'WWW-Authenticate':challenge}});
    return response(id,{isError:true,content:[{type:'text',text:e instanceof ReviewError?e.message:'本轮暂未确认，请在 SD2 核对后重试同一稿件。'}]});
  }
}
export const GET=()=>new Response(null,{status:405,headers:{...headers,Allow:'POST','WWW-Authenticate':challenge}});
