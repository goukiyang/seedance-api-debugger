const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=process.argv[2],dist=path.join(root,'.next-prod-candidate');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const serverJS=files(path.join(dist,'server')).filter(f=>f.endsWith('.js'));
assert(serverJS.some(file=>{const source=fs.readFileSync(file,'utf8');return source.includes('parserVersion:"1.0.2"')&&source.includes('同一人物条件返回空数组或多个值');}),'Compiled description validator missing');
const context={};vm.runInNewContext(fs.readFileSync(path.join(dist,'server/app/template-studio/page_client-reference-manifest.js'),'utf8'),context);
const manifest=context.__RSC_MANIFEST['/template-studio/page'];
const css=[...new Set(Object.values(manifest.entryCSSFiles).flat())].filter(file=>fs.readFileSync(path.join(dist,file),'utf8').includes('restoreResult'));
assert(css.length,'Actual template toolbar stylesheet missing');
for(const file of css)assert(!fs.readFileSync(path.join(dist,file),'utf8').includes('restoreFooter'),'Standalone footer remains compiled');
console.log(JSON.stringify({compiledParserVersion:'1.0.2',singletonValidatorPresent:true,templateToolbarCss:css,noStandaloneRestoreFooter:true,buildId:fs.readFileSync(path.join(dist,'BUILD_ID'),'utf8').trim()}));
