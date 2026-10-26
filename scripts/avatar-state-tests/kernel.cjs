const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
const ts = require('typescript');
const root = path.resolve(__dirname,'../..');
async function main() {
  // Keep the real error type but exclude task/DB/Provider module initialization.
  const taskPath=path.join(root,'src/lib/image-studio/tasks.ts');
  const taskSource=fs.readFileSync(taskPath,'utf8');
  const ast=ts.createSourceFile(taskPath,taskSource,ts.ScriptTarget.Latest,true);
  const errorClass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='StudioError');
  assert.ok(errorClass);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sd2-avatar-kernel-'));
  const bundle=await esbuild.build({entryPoints:[path.join(root,'src/lib/avatar-random/engine.ts'),path.join(root,'src/lib/avatar-random/description-contract.ts'),path.join(root,'src/lib/avatar-random/layout.ts')],outdir:dir,bundle:true,platform:'node',format:'cjs',tsconfig:path.join(root,'tsconfig.json'),metafile:true,plugins:[{name:'error-only-task-boundary',setup(build){build.onResolve({filter:/^@\/lib\/image-studio\/tasks$/},()=>({path:'error-only',namespace:'isolated'}));build.onLoad({filter:/.*/,namespace:'isolated'},()=>({contents:errorClass.getText(ast),loader:'ts'}));}}]});
  assert.ok(!Object.keys(bundle.metafile.inputs).some(p=>/prisma|credits\/policy|integrations\//.test(p)));
  const {randomAvatar,compileAvatar,createAvatarCandidates,parseAvatarRules,emptyConstraints}=require(path.join(dir,'engine.js'));
  const {validateDescriptionConstraints}=require(path.join(dir,'description-contract.js'));
  const {withAvatarLayout,avatarOutputCount}=require(path.join(dir,'layout.js'));
  const base={layout:'independent',description:'',choices:{},locks:{},intensity:'standard',people:1,candidates:4};
  const fields=(explicit, description)=>validateDescriptionConstraints({explicit,details:[],scopes:[],background:'',unrecognized:[],conflicts:[]},description);
  const cases=[];
  function samples(name,rules,constraints,check,previous) {
    const signatures=new Set();
    for(let i=0;i<12;i++){
      const dna=randomAvatar(parseAvatarRules(rules),constraints,`state-test-fixed-${i}`,previous);
      check(dna);const compiled=compileAvatar([dna],constraints,false);
      assert.ok(compiled.prompt.includes('画面中恰好1个人'));
      assert.ok(compiled.standardDescription.includes(`${dna.fields.age.value}岁的${dna.fields.gender.value}`));
      signatures.add(JSON.stringify(Object.fromEntries(Object.entries(dna.fields).filter(([,f])=>!f.locked&&f.source==='random').map(([k,f])=>[k,f.value]))));
    }
    assert.ok(signatures.size>1,'unfixed fields must still vary');
    cases.push({group:2,name,status:'PASS',samples:12,unfixedDistinct:signatures.size});
  }
  samples('fixed gender',base,fields({gender:{value:'女性',evidence:'女性'}},'女性'),d=>assert.equal(d.fields.gender.value,'女性'));
  samples('age range 25-35',{...base,choices:{age:'25-35'}},emptyConstraints(),d=>assert.ok(Number(d.fields.age.value)>=25&&Number(d.fields.age.value)<=35));
  samples('no glasses and short hair',base,fields({glasses:{value:'不戴眼镜',evidence:'不戴眼镜',excluded:['黑框眼镜','细框眼镜']},hair_length:{value:'短发',evidence:'短发'}},'不戴眼镜，短发'),d=>{assert.equal(d.fields.glasses.value,'不戴眼镜');assert.equal(d.fields.hair_length.value,'短发');assert.ok(!d.details.some(x=>/眼镜/.test(x.value)));});
  samples('combined fixed conditions',{...base,choices:{age:'25-35'}},fields({gender:{value:'男性',evidence:'男性'},glasses:{value:'不戴眼镜',evidence:'不戴眼镜'},hair_length:{value:'长发',evidence:'长发'}},'男性，不戴眼镜，长发'),d=>{assert.equal(d.fields.gender.value,'男性');assert.equal(d.fields.hair_length.value,'长发');assert.equal(d.fields.glasses.value,'不戴眼镜');assert.ok(Number(d.fields.age.value)>=25&&Number(d.fields.age.value)<=35);});
  const previous=randomAvatar(base,emptyConstraints(),'locked-baseline');
  samples('locked fields remain unchanged',{...base,locks:{gender:previous.fields.gender,face_shape:previous.fields.face_shape,age:previous.fields.age}},emptyConstraints(),d=>{for(const key of ['gender','face_shape','age']){assert.equal(d.fields[key].value,previous.fields[key].value);assert.equal(d.fields[key].locked,true);}},previous);
  for(let i=0;i<12;i++){
    assert.throws(()=>createAvatarCandidates(base,{...emptyConstraints(),conflicts:['合成明确冲突']}));
    assert.throws(()=>randomAvatar({...base,choices:{gender:'男性'}},fields({gender:{value:'',evidence:'不要男性',excluded:['男性']}},'不要男性'),`conflict-${i}`));
  }
  cases.push({group:2,name:'conflicts rejected before output',status:'PASS',samples:12});
  const candidates=createAvatarCandidates(base,emptyConstraints());
  const old={id:'legacy',candidates,model:'synthetic',quality:'auto',resolution:'1K',aspectRatio:'1:1',settingsRevision:1,unitCredits:5,referenceIds:[],createdAt:'2026-10-05T00:00:00Z'};
  const before=JSON.stringify(old);const sheet=withAvatarLayout(old,'contact-sheet');
  assert.equal(avatarOutputCount(sheet),1);assert.equal(sheet.aspectRatio,'1:1');assert.equal(sheet.candidates.length,4);assert.equal(new Set(sheet.candidates.map(c=>c.characterId)).size,4);assert.equal(sheet.unitCredits*avatarOutputCount(sheet),5);assert.equal(JSON.stringify(old),before);
  assert.ok(sheet.sheetPrompt.includes('左上格'));assert.ok(sheet.sheetPrompt.includes('右下格'));assert.ok(!sheet.sheetPrompt.includes('画面中恰好1个人'));
  for(const count of [1,2,4]){const independent=withAvatarLayout({...sheet,candidates:candidates.slice(0,count)},'independent');assert.equal(avatarOutputCount(independent),count);assert.equal(independent.unitCredits*avatarOutputCount(independent),count*5);}
  cases.push({group:1,name:'real kernel: default four DNA compile to one square image',status:'PASS'});
  cases.push({group:5,name:'real layout core: 1 vs 1/2/4 counts/quotes, old snapshot immutable',status:'PASS'});
  const report={scope:'synthetic controlled constraints; real random/compile/layout core',externalModelCalls:0,dbCalls:0,seedSet:'state-test-fixed-0..11',cases,passed:cases.length};
  const dest=path.resolve(process.env.AVATAR_STATE_EVIDENCE||path.join(root,'docs/materials/2026-10-04-controlled-avatar-generator/2026-10-05-state-tests/baseline'));fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'kernel-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
