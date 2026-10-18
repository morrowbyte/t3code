'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateTrigger,decideDispatch}=require('./nightly-after-ci.cjs');
const source='a'.repeat(40),other='b'.repeat(40);
const run={id:123,repository:{full_name:'morrowbyte/t3code'},head_repository:{full_name:'morrowbyte/t3code'},event:'push',head_branch:'main',path:'.github/workflows/weasel-ci.yml',status:'completed',conclusion:'success',head_sha:source};
const state=()=>({source,main:source,statuses:[],runs:[],runCount:0,releases:[]});
test('only successful normal main-push CI qualifies',()=>{
  assert.equal(validateTrigger(run,'morrowbyte/t3code'),source);
  const {repository: omitted, ...webhookRun}=run; assert.equal(validateTrigger(webhookRun,'morrowbyte/t3code'),source);
  for(const delta of [{event:'pull_request'},{event:'workflow_dispatch'},{head_branch:'weasel/check'},{conclusion:'failure'},{repository:{full_name:'foreign/repo'}}])assert.throws(()=>validateTrigger({...run,...delta},'morrowbyte/t3code'));
});
test('one eligible source without intent requests dispatch',()=>assert.equal(decideDispatch(state()).action,'dispatch'));
test('main advancing does not release unpinned source',()=>assert.equal(decideDispatch({...state(),main:other}).action,'skip'));
test('persisted intent without visible run fails closed for every marker state',()=>{
  for(const markerState of ['pending','success','error','failure'])assert.equal(decideDispatch({...state(),statuses:[{context:'weasel/nightly-dispatch',state:markerState}]}).action,'stop');
});
test('existing exact run is reconciled, never dispatched again',()=>{
  const release={id:456,head_sha:source,path:'.github/workflows/weasel-release.yml',event:'workflow_dispatch',head_branch:'main'};
  assert.equal(decideDispatch({...state(),runs:[release],runCount:1}).action,'reconcile');
  assert.throws(()=>decideDispatch({...state(),runs:[release,{...release,id:457}],runCount:2}));
  const published={id:789,target_commitish:source,draft:false,published_at:'2026-10-16T18:00:00Z'};
  assert.equal(decideDispatch({...state(),releases:[published]}).reason,'source-already-published');
  assert.equal(decideDispatch({...state(),releases:[{...published,target_commitish:other}]}).action,'dispatch');
  assert.equal(decideDispatch({...state(),releases:[{...published,draft:true}]}).action,'dispatch');
});
test('truncated observations cannot clear intent or invent a unique run',()=>{
  assert.throws(()=>decideDispatch({...state(),statuses:Array(100).fill({context:'unrelated'})}));
  assert.throws(()=>decideDispatch({...state(),runCount:1}));
  assert.throws(()=>decideDispatch({...state(),releases:undefined}));
});

const {readFileSync}=require('node:fs');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const {spawnSync}=require('node:child_process');
const {parse}=createRequire(resolve(__dirname,'../../packages/shared/package.json'))('yaml');
const releaseWorkflow=parse(readFileSync(resolve(__dirname,'../../.github/workflows/weasel-release.yml'),'utf8'));
const expression=(value,inputs,needs,cancelled=false)=>Function('inputs','needs','cancelled',`return (${value.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '')})`)(inputs,needs,()=>cancelled);
const platformInputs=(desktop_only=false)=>({desktop_only,publish:true,recover_desktop_run_id:''});
const desktopJobs=['preflight','build_bundle','build_linux','build_nixos','build_windows'];
const releaseNeeds=(android)=>Object.fromEntries([...desktopJobs.map(name=>[name,{result:'success'}]),['build_android_apk',{result:android}]]);
test('desktop-only release skips Android while the default still requires it',()=>{
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.desktop_only.default,false);
  assert.equal(expression(releaseWorkflow.jobs.build_android_apk.if,platformInputs(true),{}),false);
  assert.equal(expression(releaseWorkflow.jobs.build_android_apk.if,platformInputs(false),{}),true);
  const gate=releaseWorkflow.jobs.publish.if;
  assert.equal(expression(gate,platformInputs(true),releaseNeeds('skipped')),true);
  assert.equal(expression(gate,platformInputs(false),releaseNeeds('skipped')),false);
  assert.equal(expression(gate,platformInputs(false),releaseNeeds('success')),true);
  assert.equal(expression(gate,platformInputs(true),releaseNeeds('success')),false);
});
test('every desktop package and cancellation gate remains required in either mode',()=>{
  const gate=releaseWorkflow.jobs.publish.if;
  for(const desktopOnly of [false,true]){
    const inputs=platformInputs(desktopOnly),needs=releaseNeeds(desktopOnly?'skipped':'success');
    for(const job of desktopJobs)assert.equal(expression(gate,inputs,{...needs,[job]:{result:'failure'}}),false);
    assert.equal(expression(gate,{...inputs,publish:false},needs),false);
    assert.equal(expression(gate,inputs,needs,true),false);
  }
  const recoveryNeeds=Object.fromEntries([...desktopJobs.map(name=>[name,{result:name==='preflight'?'success':'skipped'}]),['build_android_apk',{result:'success'}]]);
  assert.equal(expression(gate,{...platformInputs(),recover_desktop_run_id:'39093205395'},recoveryNeeds),true);
});
test('desktop-only cannot enter Android recovery or publish mobile assets',()=>{
  const steps=releaseWorkflow.jobs.preflight.steps;
  const validation=steps.find(step=>step.name==='Validate platform selection');
  const run=(desktop,recovery)=>spawnSync('bash',['-c',validation.run],{env:{...process.env,DESKTOP_ONLY:String(desktop),RECOVERY_RUN_ID:recovery}}).status;
  assert.equal(run(true,''),0);
  assert.equal(run(false,'39093205395'),0);
  assert.notEqual(run(true,'39093205395'),0);
  const publishSteps=releaseWorkflow.jobs.publish.steps;
  const androidProof=publishSteps.find(step=>step.name==='Verify Android bytes from this build before publication');
  assert.equal(expression(androidProof.if,platformInputs(true),{}),false);
  const payload=publishSteps.find(step=>step.name==='Verify isolated release payload');
  assert.match(payload.run,/DESKTOP_ONLY/);
  assert.match(payload.run,/\*\.apk/);
  assert.equal(Object.keys(releaseWorkflow.jobs).some(name=>/mac/i.test(name)),false);
});
