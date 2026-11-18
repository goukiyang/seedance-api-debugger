import assert from 'node:assert/strict';
import {createDirectoryFixture} from './gpt-directory-engineering.mjs';
const fixture=await createDirectoryFixture(),db=fixture.db;
const seed=async(table,row)=>{const keys=Object.keys(row);await db.$executeRawUnsafe(`INSERT INTO "${table}" (${keys.map(key=>'"'+key+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,...Object.values(row));};
const category=(report,kind)=>report.categories.find(row=>row.kind===kind);
try{
 const empty=await fixture.storage.readBridgeStorageUsage('empty');assert.equal(empty.totalBytes,0);assert.equal(empty.categories.length,6);console.log('ok a genuinely empty account reports zero confirmed plugin bytes');
 const k='bridge_gpt_directory_v1:'+'a'.repeat(64),v=JSON.stringify({name:'中文目录'});
 await db.userPreference.create({data:{user_id:'alice',key:k,value_json:v}});
 await db.userPreference.create({data:{user_id:'alice',key:k.replace(/a+$/,'b'.repeat(64)),value_json:'{}'}});
 await db.userPreference.create({data:{user_id:'bob',key:k,value_json:'x'.repeat(50000)}});
 await db.userPreference.create({data:{user_id:'alice',key:'unrelated-business',value_json:'x'.repeat(50000)}});
 await db.userPreference.create({data:{user_id:'alice',key:'bridge_devices_v1',value_json:'[]'}});
 let usage=await fixture.storage.readBridgeStorageUsage('alice');assert.equal(category(usage,'directory').bytes,Buffer.byteLength(k+v)+Buffer.byteLength(k+'{}'));assert.equal(category(usage,'directory').records,2);assert.equal(category(usage,'settings').records,1);console.log('ok UTF-8 bytes cover all of this account directory scopes and exclude other accounts and SD2 business data');
 const assets=[['a1','alice','/uploads/a1','h1',101],['a1-copy','alice','/uploads/a1-copy','h1',101],['a2','alice','https://sd2.youdooart.com/uploads/a2','h2',202],['a3','alice','https://sd2.youdoodesign.com/uploads/a3','h3',303],['a4','alice','/uploads/a4','h4',404],['a4-copy','alice','https://sd2.youdoodesign.com/uploads/a4',null,404],['a5','alice','/uploads/a5',null,505],['a5-copy','alice','https://sd2.youdoodesign.com/uploads/a5',null,505],['external-a','alice','https://storage-a.invalid/shared.png',null,607],['external-b','alice','https://storage-b.invalid/shared.png',null,708],['orphan','alice','/uploads/orphan','h4',9000],['b1','bob','/uploads/b1','h5',8000]];
 for(const[id,owner_id,original_url,hash,file_size]of assets)await seed('Asset',{id,owner_id,original_url,hash:hash?(hash.slice(1)).repeat(64):null,file_size});
 await seed('BridgeQueuePreset',{id:'mine',owner_id:'alice',name:'本人组合',items_json:JSON.stringify([{images:[{url:'/uploads/a1'},{url:'/uploads/a1-copy'},{url:'/uploads/a3'},{url:'https://sd2.youdooart.com:443/uploads/a4?preview=1#image'},{url:'/uploads/a5'},{url:'https://storage-a.invalid/shared.png'},{url:'https://storage-b.invalid/shared.png'},{url:'https://outside.invalid/uploads/orphan'},{url:'/uploads/b1'}]}]),client_id:'c',team_id:null,copied_from:null});
 await seed('BridgeQueuePreset',{id:'shared',owner_id:'bob',name:'他人的共享组合',items_json:JSON.stringify([{images:[{url:'/uploads/b1'},{url:'/uploads/orphan'}]}]),client_id:'d',team_id:null,copied_from:null});
 await seed('BridgeQueuePresetLike',{id:'like',preset_id:'shared',user_id:'alice'});
 for(const[id,operator_id,action]of[['log-a','alice','bridge_client_report'],['log-b','bob','bridge_client_report'],['business','alice','unrelated_action']])await seed('OperationLog',{id,operator_id,action,target_type:'BridgeClient',target_id:'target',detail:'私有内容'});
 for(const[id,user_id]of[['f-plugin','alice'],['f-web','alice'],['f-bob','bob']])await seed('Feedback',{id,user_id,content:'反馈',image_urls_json:JSON.stringify(['/uploads/a1','/uploads/b1']),page_url:null,pathname:null,user_agent:null,admin_note:null});
 for(const id of ['f-plugin','f-bob'])await seed('PlatformSetting',{key:'feedback-source:v1:'+id,value_json:JSON.stringify({site:'chatgpt'}),updated_by:id==='f-plugin'?'alice':'bob'});
 for(const[id,type,target_user_id,metadata]of[
  ['admin-feedback','feedback_ack_feishu_v1','admin',{feedbackId:'f-plugin',preparation:{attachments:{items:[{assetId:'a1'}]}}}],
  ['other-feedback','feedback_ack_feishu_v1','alice',{feedbackId:'f-bob',preparation:{attachments:{items:[{assetId:'orphan'}]}}}],
  ['web-feedback','feedback_ack_feishu_v1','admin',{feedbackId:'f-web'}],
  ['my-send','bridge_feishu_v1','alice',{actorId:'alice',assets:[{id:'a2'},{id:'b1'}]}],
  ['bad-send','bridge_feishu_v1','bob',{actorId:'bob',assets:[{id:'orphan'}]}]
 ])await seed('Notification',{id,type,target_user_id,title:'通知',body:null,metadata_json:JSON.stringify(metadata),error_message:null});
 for(const id of ['f-plugin','f-web'])await seed('PlatformSetting',{key:'feedback-submit:v1:alice:'+id,value_json:JSON.stringify({result:{feedback:{id}}}),updated_by:'alice'});
 usage=await fixture.storage.readBridgeStorageUsage('alice');assert.equal(category(usage,'attachments').bytes,2830);assert.equal(category(usage,'attachments').records,7);assert.equal(category(usage,'presets').records,2);assert.equal(category(usage,'reports').records,1);assert.equal(category(usage,'feedback').records,5);assert.equal(usage.totalBytes,usage.categories.reduce((sum,row)=>sum+row.bytes,0));assert.equal(JSON.stringify(usage).includes('私有内容'),false);console.log('ok owned preset URLs, plugin feedback and own Feishu originals are merged once; foreign, shared-only and orphan assets are excluded');
 assert.equal(category(usage,'feedback').records,5);console.log('ok mixed hash/no-hash records of one original merge, hashless aliases merge, and distinct external origins remain separate');
 console.log('ok relative, absolute and allowed legacy URLs identify the same original once, while foreign origins are not normalized');
 console.log('ok feedback sent to an admin is charged to its submitting account, while web feedback and other submitters are excluded');
 const fetchUsage=(session,expected=session)=>fetch(fixture.storageUrl,{headers:{...(session?{'X-Fixture-Session':session}:{}),'X-SD2-User-ID':expected||''}});
 assert.equal((await fetchUsage(null)).status,401);assert.equal((await fetchUsage('bob','alice')).status,409);
 const result=await fetchUsage('alice');assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/private, no-store/);assert.equal((await result.json()).totalBytes,usage.totalBytes);console.log('ok aggregate endpoint requires the actual account and never returns private content or cached cross-account totals');
}finally{await fixture.close();}
