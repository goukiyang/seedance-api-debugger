import assert from 'node:assert/strict';
import { assertProtection } from './common.mjs';

import { cwdBytes, assertNaturalExitEvidence, hdLockOwnerRows } from './switch.mjs';

// Pure integration of the actual release assertion: no FS/DB/services/providers.
const before = { hdStorage: {schema:'hd-storage-protection-v1',bindings:{canonical:'fixed',fork:'preserved',workerLock:'same'},readyByKey:{old:{contractSha256:'same',output:{bytes:123,ino:'same'}}}}, databaseIdentity: ['disk', 'db'], files: { config: 'same' }, marker: 'permanent-i',
  otherServices: { works: 'same' }, settingsSha256: 'same', protectedTasks: { protected: 'same-ledger-original-hidden' },
  imageContracts: { visible: 'nineteen-frozen-fields', hidden: 'frozen-hidden' }, videoContracts: { video: 'same' },
  imageVisibility: { observedFrom: 1000, observedUntil: 1100, tasks: { visible: null, hidden: 500 } },
  uploadUnknown: { unknown: 'same' }, uploadReceipts: { receipt: 'same' },
  multiviewSettings: { setting: 'same' }, multiviewSettingsReceipts: { save: 'same' },
  workIdentities: { work: 'same' }, workMutationReceipts: { mutation: 'same' },
  usageAttribution: { '["image","old"]': 'same-current-row' },
  privateRecipeSettings: { current: 'exact-current', immutable: 'exact-history' },
  storage: { leaf: { real: '/data/same', identity: ['disk', 'leaf'] } } };
before.hdStorage.historicalByKey = { preserved: { manifestSha256: 'original-raw', currentSource: 'fresh-original-identity', output: 'old-ready-identity', currentReusable: false } };
const fresh = () => { const value = structuredClone(before); value.imageVisibility.observedFrom = 1200;
  value.imageVisibility.observedUntil = 1400; return value; };
const cases = [];
function check(name, mutate, accepted) {
  const after = fresh(); mutate(after);
  if (accepted) assert.doesNotThrow(() => assertProtection(before, after), name);
  else assert.throws(() => assertProtection(before, after), undefined, name);
  cases.push({ name, accepted });
}
check('unchanged_real_snapshot_shape', () => {}, true);
check('private_current_cannot_change_outside_authorized_projection', a => { a.privateRecipeSettings.current = 'changed'; }, false);
check('private_immutable_history_cannot_change', a => { a.privateRecipeSettings.immutable = 'changed'; }, false);
check('private_inventory_cannot_disappear', a => { delete a.privateRecipeSettings; }, false);
check('existing_usage_attribution_cannot_change', a => { a.usageAttribution['["image","old"]'] = 'changed'; }, false);
check('existing_usage_attribution_cannot_disappear', a => { delete a.usageAttribution['["image","old"]']; }, false);
check('new_legitimate_usage_attribution_allowed', a => { a.usageAttribution['["image","new"]'] = 'new'; }, true);
check('owner_new_hide_in_read_interval', a => { a.imageVisibility.tasks.visible = 1300; }, true);
check('new_hide_at_start_boundary', a => { a.imageVisibility.tasks.visible = 1000; }, true);
check('new_append_keeps_old_contracts_visibility_and_receipts', a => {
  a.imageContracts.new = 'new'; a.imageVisibility.tasks.new = null; a.videoContracts.new = 'new';
  for (const key of ['uploadUnknown', 'uploadReceipts', 'multiviewSettings', 'multiviewSettingsReceipts', 'workIdentities', 'workMutationReceipts']) a[key].new = 'new';
}, true);
for (const [name, value] of [['string', '1300'], ['zero', 0], ['negative', -1], ['boolean', true], ['fraction', 1300.5],
  ['nan', NaN], ['infinite', Infinity], ['future', 1401], ['backdated', 999]]) {
  check('new_hide_reject_' + name, a => { a.imageVisibility.tasks.visible = value; }, false);
}
check('old_hidden_cannot_resurrect', a => { a.imageVisibility.tasks.hidden = null; }, false);
check('old_hidden_time_cannot_change', a => { a.imageVisibility.tasks.hidden = 600; }, false);
check('old_visible_row_cannot_disappear', a => { delete a.imageContracts.visible; delete a.imageVisibility.tasks.visible; }, false);
check('old_hidden_row_cannot_disappear', a => { delete a.imageContracts.hidden; delete a.imageVisibility.tasks.hidden; }, false);
check('visibility_row_cannot_disappear', a => { delete a.imageVisibility.tasks.visible; }, false);
check('unpaired_visibility_row_rejected', a => { a.imageVisibility.tasks.extra = null; }, false);
check('visibility_unknown_field_rejected', a => { a.imageVisibility.unknown = true; }, false);
check('visibility_read_order_rejected', a => { a.imageVisibility.observedFrom = 999; }, false);
check('invalid_read_interval_rejected', a => { a.imageVisibility.observedUntil = 1199; }, false);
check('nineteen_frozen_fields_cannot_change_even_with_legitimate_hide', a => {
  a.imageVisibility.tasks.visible = 1300; a.imageContracts.visible = 'changed-cost-or-input';
}, false);
check('protected_old_original_ledger_or_hidden_cannot_change', a => { a.protectedTasks.protected = 'changed'; }, false);
for (const key of ['uploadUnknown', 'uploadReceipts', 'multiviewSettings', 'multiviewSettingsReceipts', 'workIdentities', 'workMutationReceipts']) {
  check(key + '_old_change_rejected', a => { a[key][Object.keys(before[key])[0]] = 'changed'; }, false);
  check(key + '_old_delete_rejected', a => { delete a[key][Object.keys(before[key])[0]]; }, false);
}
for (const key of ['databaseIdentity', 'files', 'marker', 'otherServices', 'settingsSha256', 'storage']) {
  check(key + '_drift_rejected', a => { a[key] = 'changed'; }, false);
}

check('existing_hd_ready_cannot_disappear', a => { delete a.hdStorage.readyByKey.old; }, false);
check('existing_hd_ready_cannot_change', a => { a.hdStorage.readyByKey.old.output.bytes++; }, false);
check('fixed_hd_binding_cannot_drift', a => { a.hdStorage.bindings.canonical='fork'; }, false);
check('natural_new_hd_ready_allowed', a => { a.hdStorage.readyByKey.new={contractSha256:'new',output:{bytes:456,ino:'new'}}; }, true);
check('old_hd_manifest_cannot_change', a => { a.hdStorage.historicalByKey.preserved.manifestSha256 = 'changed'; }, false);
check('old_hd_current_original_cannot_change_again', a => { a.hdStorage.historicalByKey.preserved.currentSource = 'changed'; }, false);
check('old_hd_output_cannot_change', a => { a.hdStorage.historicalByKey.preserved.output = 'changed'; }, false);
check('old_hd_object_cannot_disappear', a => { delete a.hdStorage.historicalByKey.preserved; }, false);
check('unknown_old_hd_object_cannot_be_added', a => { a.hdStorage.historicalByKey.extra = {}; }, false);
check('old_hd_preservation_cannot_claim_current_reuse', a => { a.hdStorage.historicalByKey.preserved.currentReusable = true; }, false);
const manifest={runId:'00000000-0000-4000-8000-000000000001',hdRoot:'/data/video-api-debugger/var-lib/storage/hd-derivatives',
  main:{root:'/data/main'},guard:{root:'/data/guard'},
  live:{web:{root:'/data/old-web'},image:{root:'/data/old-image'},hd:{root:'/data/old-hd'}}};
const files={web:'/etc/systemd/system/sd2-gray.service.d/default01-web.conf',
  image:'/etc/systemd/system/sd2-image-studio.service.d/imgapi-cwd.conf',
  hd:'/etc/systemd/system/sd2-hd-derivatives.service.d/hd-source.conf'};
const captured={policies:Object.fromEntries(Object.entries(files).map(([role,file])=>[role,{dropins:[{file,
  bytesBase64:Buffer.from('[Service]\nWorkingDirectory='+manifest.live[role].root+'\nSendSIGKILL=no\n'
    +'Environment=HD_DERIVATIVES_ROOT='+manifest.hdRoot+'\n'
    +(role==='hd'?'ExecStart=\nExecStart=/usr/bin/flock --no-fork -n /srv/video-api-debugger/app/storage/hd-worker.lock /usr/bin/node --import tsx scripts/process-hd-derivatives.ts worker\n':''))
    .toString('base64')}]}]))};
function add(name,action,accepted=true){action();cases.push({name,accepted,passed:true});}
for(const role of ['web','image','hd']){
 add(role+'_original_dropin_restored_byte_exact',()=>assert.equal(cwdBytes(manifest,captured,role,manifest.live[role].root).toString(),
   Buffer.from(captured.policies[role].dropins[0].bytesBase64,'base64').toString()));
 for(const kind of ['main','guard'])add(role+'_'+kind+'_canonical_and_source_bound',()=>{
  const text=cwdBytes(manifest,captured,role,manifest[kind].root).toString();
  assert.ok(text.includes('WorkingDirectory='+manifest[kind].root+'\n'));
  assert.equal((text.match(/Environment=HD_DERIVATIVES_ROOT=/g)||[]).length,1);
  assert.ok(text.includes('Environment=HD_DERIVATIVES_ROOT='+manifest.hdRoot+'\n'));
  if(role==='hd')assert.ok(text.includes('ExecStart=\nExecStart=/usr/bin/flock --no-fork -n /srv/video-api-debugger/app/storage/hd-worker.lock '));
  else assert.ok(!text.includes('ExecStart='));
 });
 add(role+'_unknown_cwd_refused',()=>assert.throws(()=>cwdBytes(manifest,captured,role,'/data/unknown')),false);
 add(role+'_prior_hd_override_refused',()=>{
  const changed=structuredClone(captured), d=changed.policies[role].dropins[0];
  d.bytesBase64=Buffer.from(Buffer.from(d.bytesBase64,'base64').toString()+'Environment=HD_DERIVATIVES_ROOT=/data/wrong\n').toString('base64');
  assert.throws(()=>cwdBytes(manifest,changed,role,manifest.main.root));
 },false);
 const canonical=structuredClone(captured), d=canonical.policies[role].dropins[0];
 d.bytesBase64=cwdBytes(manifest,captured,role,manifest.main.root).toString('base64');
 d.bytesBase64=Buffer.from(Buffer.from(d.bytesBase64,'base64').toString().replace('WorkingDirectory='+manifest.main.root,
   'WorkingDirectory='+manifest.live[role].root)).toString('base64');
 for(const kind of ['main','guard'])add(role+'_'+kind+'_existing_canonical_only_cwd_changes',()=>{
  const expected=Buffer.from(d.bytesBase64,'base64').toString().replace('WorkingDirectory='+manifest.live[role].root,
    'WorkingDirectory='+manifest[kind].root);
  assert.equal(cwdBytes(manifest,canonical,role,manifest[kind].root).toString(),expected);
 });
 add(role+'_duplicate_canonical_refused',()=>{
  const changed=structuredClone(canonical), x=changed.policies[role].dropins[0];
  x.bytesBase64=Buffer.from(Buffer.from(x.bytesBase64,'base64').toString()+'Environment=HD_DERIVATIVES_ROOT='+manifest.hdRoot+'\n').toString('base64');
  assert.throws(()=>cwdBytes(manifest,changed,role,manifest.main.root));
 },false);
 add(role+'_missing_canonical_refused',()=>{
  const changed=structuredClone(canonical), x=changed.policies[role].dropins[0];
  x.bytesBase64=Buffer.from(Buffer.from(x.bytesBase64,'base64').toString().replace('Environment=HD_DERIVATIVES_ROOT='+manifest.hdRoot+'\n','')).toString('base64');
  assert.throws(()=>cwdBytes(manifest,changed,role,manifest.main.root));
 },false);
 if(role==='hd')add('hd_changed_original_lock_command_refused',()=>{
  const changed=structuredClone(canonical), x=changed.policies.hd.dropins[0];
  x.bytesBase64=Buffer.from(Buffer.from(x.bytesBase64,'base64').toString().replace('hd-worker.lock','other.lock')).toString('base64');
  assert.throws(()=>cwdBytes(manifest,changed,'hd',manifest.main.root));
 },false);
}
const original={MainPID:'12345',InvocationID:'a'.repeat(32),ExecMainPID:'12345',ExecMainStartTimestamp:'actual-start',
 ExecMainStartTimestampMonotonic:'123456',ControlGroup:'/system.slice/sd2-hd-derivatives.service'};
const stopped={MainPID:'0',ControlPID:'0',ActiveState:'inactive',Result:'success',InvocationID:original.InvocationID,
 ExecMainPID:'12345',ExecMainStartTimestamp:'actual-start',ExecMainStartTimestampMonotonic:'123456'};
const gone={originalPidPresent:false,originalGroupPids:[],unitGroupPids:[]};
add('retained_original_natural_exit_allowed',()=>assert.equal(assertNaturalExitEvidence(stopped,original,gone),true));
add('systemd_gc_original_natural_exit_allowed',()=>assert.equal(assertNaturalExitEvidence({...stopped,InvocationID:'',
 ExecMainPID:'0',ExecMainStartTimestamp:'',ExecMainStartTimestampMonotonic:'0'},original,gone),true));
for(const [name,delta] of [['new_invocation',{InvocationID:'b'.repeat(32)}],['new_start',{ExecMainStartTimestampMonotonic:'987'}],
 ['active',{ActiveState:'active'}],['failure',{Result:'signal'}],['new_pid',{MainPID:'444'}]]){
 add(name+'_exit_refused',()=>assert.throws(()=>assertNaturalExitEvidence({...stopped,...delta},original,gone)),false);
}
for(const [name,delta] of [['original_pid_alive',{originalPidPresent:true}],['original_group_not_empty',{originalGroupPids:['9']}],
 ['unit_group_not_empty',{unitGroupPids:['10']}]]){
 add(name+'_exit_refused',()=>assert.throws(()=>assertNaturalExitEvidence(stopped,original,{...gone,...delta})),false);
}
add('flock_matches_full_device_and_inode_not_inode_only',()=>{
 const rows='1: FLOCK ADVISORY WRITE 123 00:00:777 0 EOF\n2: FLOCK ADVISORY WRITE 456 08:00:777 0 EOF\n3: POSIX ADVISORY WRITE 123 00:00:777 0 EOF';
 assert.equal(hdLockOwnerRows(rows,{dev:0,ino:777}).length,1);
 assert.ok(hdLockOwnerRows(rows,{dev:0,ino:777})[0].includes(' 123 '));
});
console.log(JSON.stringify({schema:'hd-release-protection-engineering.v1',completed:true,cases,
 actualAssertions:['common.mjs assertProtection','hd-storage-preflight.mjs assertHdStorageProtection',
  'switch.mjs cwdBytes/assertNaturalExitEvidence/hdLockOwnerRows'],
 productionWrites:0,serviceCalls:0,providerCalls:0,browserRuns:0,
 evidenceBoundary:'pure actual-function integration; not systemd/native service or user functional acceptance'}));
