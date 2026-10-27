const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { deps, ts } = require('./audit-decode-upload-loader.cjs');
const { createRequire } = require('node:module');
const path = require('node:path');
const lintDeps = process.env.AUD_LINT_MODULES ? createRequire(path.join(process.env.AUD_LINT_MODULES,'package.json')) : deps;
const { Linter } = lintDeps('eslint');
const linter = new Linter();
linter.defineParser('typescript',lintDeps('@typescript-eslint/parser'));
linter.defineRule('typescript/no-unused-vars',lintDeps('@typescript-eslint/eslint-plugin').rules['no-unused-vars']);
const files = [...new Set([...execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n').filter(file=>/\.tsx?$/.test(file)),
  'src/lib/media/decode-image.ts','src/lib/media/image-limits.ts','src/lib/assets/streamed-upload.ts'])];
let errors = 0, warnings = 0, unchangedBaseline = 0;
function isUnchangedBaseline(file, source, message) {
  if(file!=='src/lib/assets/site-upload.ts'||message.ruleId!=='no-unreachable')return false;
  const previous=execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'});
  const find=text=>{const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);return tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='validateSiteUploadBuffer');};
  const before=find(previous),now=find(source);
  if(!before||!now||before.getText()!==now.getText())return false;
  const line=now.getSourceFile().getLineAndCharacterOfPosition(now.pos).line+1,end=now.getSourceFile().getLineAndCharacterOfPosition(now.end).line+1;
  return message.line>=line&&message.line<=end;
}
for(const file of files) {
  const source=fs.readFileSync(file,'utf8');
  const messages = linter.verify(source,{parser:'typescript',parserOptions:{ecmaVersion:2022,sourceType:'module'},env:{node:true,es2022:true},rules:{
    'no-unreachable':'error','no-dupe-args':'error','no-dupe-keys':'error','constructor-super':'error','valid-typeof':'error',
    'typescript/no-unused-vars':['warn',{args:'none',varsIgnorePattern:'^_',caughtErrors:'none',ignoreRestSiblings:true}],
  }},{filename:file});
  for(const message of messages){const baseline=isUnchangedBaseline(file,source,message);if(baseline)unchangedBaseline++;else if(message.severity===2)errors++;else warnings++;console.log(`${file}:${message.line}:${message.column} ${baseline?'UNCHANGED_BASELINE':message.severity===2?'ERROR':'WARN'} ${message.ruleId||'parse'} ${message.message}`);}
}
console.log(`${errors?'FAIL':'PASS'} focused ESLint: ${files.length} TypeScript files, ${errors} new errors, ${warnings} warnings, ${unchangedBaseline} exact unchanged baseline finding; not the project-wide Next lint gate`);
process.exitCode=errors?1:0;
