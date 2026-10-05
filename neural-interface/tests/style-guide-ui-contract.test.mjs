import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createStyleGuideStore } from '../lib/style-guide/store.js';
import { registerStyleGuideRoutes } from '../lib/style-guide/api.js';
import * as serverColors from '../lib/style-guide/color.js';
import * as clientColors from '../public/shared/styleguide/sg-color-client.js';
import { createGuideState } from '../public/shared/styleguide/sg-state.js';
import { DEFAULTS, normalizeStyleGuide } from '../lib/style-guide/schema.js';
const root=resolve(import.meta.dirname,'..');
const messages=JSON.parse(readFileSync(resolve(root,'i18n/en.json'),'utf8'));
const modules=readdirSync(resolve(root,'public/shared/styleguide')).filter(f=>f.endsWith('.js')).map(f=>resolve(root,'public/shared/styleguide',f));
const sources=[...modules,resolve(root,'public/shared/ui-styleguide.js'),resolve(root,'public/shared/ui-automation-studio.js')].map(p=>readFileSync(p,'utf8'));
test('every literal styleguide key exists and the English file retains CRLF',()=>{
 let count=0;
 for(const source of sources)for(const match of source.matchAll(/\bt\(\s*['"`](styleguide\.[\w.-]+)['"`]/g)){count++;assert.equal(typeof match[1].split('.').reduce((o,k)=>o?.[k],messages),'string',match[1]);}
 assert.ok(count>200);
 for(const source of sources)for(const match of source.matchAll(/\bcard\(\s*['"]([\w-]+)['"]/g)) {
  assert.equal(typeof messages.styleguide.cards[match[1]]?.title,'string',match[1]);
  assert.equal(typeof messages.styleguide.cards[match[1]]?.purpose,'string',match[1]);
 }
 const raw=readFileSync(resolve(root,'i18n/en.json'),'utf8');assert.ok(raw.includes('\r\n'));assert.equal(raw.replaceAll('\r\n','').includes('\n'),false);
 for(const section of ['brand','colors','typography','layout','shape','motion','icons-logo','imagery','components','rules','agents','preview','import-export','history']) assert.ok(messages.styleguide.section[section]?.purpose);
 const shell=readFileSync(resolve(root,'public/shared/html-shell.js'),'utf8');
 const skills=shell.slice(shell.indexOf('<!-- Skills menu -->'),shell.indexOf('<!-- Automations menu -->'));
 assert.ok(skills.includes('id="menu-open-styleguide"'));
 assert.ok(skills.includes("t('styleguide.title')"));
});
test('every client style-guide route exists in the backend',()=>{
 const api=readFileSync(resolve(root,'public/shared/api.js'),'utf8');const block=api.slice(api.indexOf('// ─── Style Guide v2'),api.indexOf('// ─── Claude Code Sessions'));
 const server=readFileSync(resolve(root,'lib/style-guide/api.js'),'utf8');const routes=[...server.matchAll(/app\.(get|put|post|delete)\('([^']+)'/g)].map(m=>m[2]);
 const normalize=p=>p.replace(/\$\{encodeURIComponent\((?:id|variantId)\)\}/g,':id').replace(/\$\{encodeURIComponent\(assetsHash\)\}/g,':hash').replace(/\$\{encodeURIComponent\(file\)\}/g,':file').replace(':variantId',':id');
 const client=[...block.matchAll(/['"`](\/api\/style-guide(?:\/[^?`'"\s]*)?)/g)].map(m=>m[1]);
 assert.ok(client.length>=23);
 for(const path of client) assert.ok(routes.map(normalize).includes(normalize(path)),path);
 assert.ok(!block.includes('compat'));
});
test('client color core stays identical and produces the server scale and contrast reports',()=>{
 const server=readFileSync(resolve(root,'lib/style-guide/color.js'),'utf8');const client=readFileSync(resolve(root,'public/shared/styleguide/sg-color-client.js'),'utf8');assert.ok(client.startsWith(server.trimEnd()));
 for(const color of ['#3b82f6','#000000','#ffffff','hsl(120 45% 60%)','oklch(60% .2 240)','#33669980']){
  for(const opts of [{},{hueShift:30,chroma:.4},{hueShift:-22,chroma:1.8}]) assert.deepEqual(clientColors.scaleFromBase(color,opts),serverColors.scaleFromBase(color,opts));
  for(const bg of ['#fff','#112233'])assert.deepEqual(clientColors.contrastReport(color,bg),serverColors.contrastReport(color,bg));
 }
});
test('client and server parsing agree on valid colors and reject malformed arguments',()=>{
 const cases=[
  ['hsl(120grad 50% 50%)','#59bf40'],['hsl(100grad 100% 50%)','#80ff00'],
  ['hsl(108deg 50% 50%)','#59bf40'],[`hsl(${Math.PI}rad 100% 50%)`,'#00ffff'],
  ['hsl(.5turn 100% 50%)','#00ffff'],['oklch(0.6 0.1 0.5turn)',serverColors.oklchToHex({l:.6,c:.1,h:180})],
  ['hsl(abc 50% 50%)',null],['oklch(0.6)',null],['rgb(1 2)',null],['',null],
  ['rgb(12oops 2 3)',null],['oklch(0.6 nope 180)',null],['rgb(1 2 3 / nope)',null],
  ['rgb(1,,2,3)',null],['rgb(1 2 3 /)',null],['rgb(1 2 3 4 5)',null],
  ['0 1..2% 50%',null],[{r:12},null],['#3bf','#33bbff'],['rgba(1,2,3,.5)','#01020380'],
  ['0 0% 100%','#ffffff'],['transparent','#00000000'],
 ];
 for(const [input,expected] of cases){
  assert.equal(clientColors.toHex(input),expected);assert.equal(serverColors.toHex(input),expected);
  assert.deepEqual(clientColors.parseColor(input),serverColors.parseColor(input));
  assert.equal(clientColors.isColor(input),expected!==null);
 }
});
test('state debounces a whole v2 config and retains all sections in the round trip',async()=>{
 let stored=structuredClone(DEFAULTS),puts=[];
 const state=createGuideState({debounce:20,fetchGuide:async()=>({config:stored,revision:0,saved:false}),saveGuide:async(path,config)=>{puts.push(structuredClone(config));stored=normalizeStyleGuide(config);return {config:stored,revision:1,saved:true};}});
 await state.load('/test');
 for(const path of ['brand.name','colors.palettes.primary.usage','typography.fonts.body.family','layout.principles','shape.elevation.sm.usage','motion.principles','iconography.notes','logo.clearSpace','imagery.notes','components.0.notes','rules.custom','agents.instructions','exports.outDir','responsive.notes'])state.set(path,Array.isArray(state.get(path))?['Changed']:'Changed');
 await new Promise(r=>setTimeout(r,50));assert.equal(puts.length,1);assert.equal(puts[0].schemaVersion,2);assert.deepEqual(Object.keys(puts[0]),Object.keys(DEFAULTS));assert.equal(puts[0].colors.primary,undefined);
 const expected=structuredClone(stored);await state.load('/test');assert.deepEqual(state.config,expected);state.destroy();
});
test('edits during an in-flight PUT are saved and never replaced by its stale response',async()=>{
 let resolveSave;const puts=[];
 const state=createGuideState({debounce:10000,fetchGuide:async()=>({config:structuredClone(DEFAULTS)}),saveGuide:async(path,config)=>{puts.push(structuredClone(config));if(puts.length===1)await new Promise(r=>resolveSave=r);return {config,revision:puts.length};}});
 await state.load('/one');state.set('brand.name','First');const saving=state.flush();state.set('brand.name','Second');state.set('imagery.notes','Still here');resolveSave();await saving;
 assert.equal(puts.length,2);assert.equal(state.config.brand.name,'Second');assert.equal(puts[1].imagery.notes,'Still here');assert.equal(state.dirty,false);state.destroy();
});
test('a failed save keeps the draft and project switching waits for it',async()=>{
 let fail=true;const paths=[];
 const state=createGuideState({debounce:10000,fetchGuide:async path=>{paths.push(path);return {config:structuredClone(DEFAULTS)};},saveGuide:async(path,config)=>{if(fail)throw Error('offline');return {config};}});
 await state.load('/one');state.set('brand.name','Keep');await assert.rejects(state.load('/two'),/offline/);assert.equal(state.projectPath,'/one');assert.equal(state.config.brand.name,'Keep');assert.equal(state.dirty,true);assert.deepEqual(paths,['/one']);fail=false;await state.load('/two');assert.equal(state.projectPath,'/two');state.destroy();
});
test('the preview sheet and the labels only use keys that exist',()=>{
 const en=messages.styleguide;
 const preview=readFileSync(resolve(root,'public/shared/styleguide/sg-preview.js'),'utf8');
 const literal=[...preview.matchAll(/\btr\(\s*'([\w-]+)'\)/g)].map(m=>m[1]);assert.ok(literal.length>20);
 // tr('button-' + kind), tr(state) and tr(status) are built from these lists in buildPreviewDocument.
 const built=['primary','secondary','ghost','danger'].map(k=>'button-'+k).concat(['default','hover','active','focus','disabled','success','warning','danger','info']);
 for(const key of [...literal,...built])assert.equal(typeof en[key],'string',key);
 const labels=readFileSync(resolve(root,'public/shared/styleguide/sg-labels.js'),'utf8');
 // A config key whose label is a message template ({...}) shows the raw template as a field caption.
 for(const [,key,ref] of labels.matchAll(/^\s+"?([\w-]+)"?: \(\) => t\('styleguide\.([\w.-]+)'\)/gm)){const v=ref.split('.').reduce((o,k)=>o?.[k],en);assert.equal(typeof v,'string',ref);if(!['revisionRow','saved','defaults','error','restoreConfirm','listItem','tokensEstimate','automationBlock','automationError'].includes(key))assert.doesNotMatch(v,/\{/,`label ${key} uses template ${ref}`);}
});
test('every section survives load → edit → save → reload through the real store and routes',async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'sg-roundtrip-')),project=join(tmp,'project');mkdirSync(project);
 const store=createStyleGuideStore({dataHome:tmp,projects:()=>[{path:project,label:'Round trip'}]});
 const app=express();app.use(express.json({limit:'2mb'}));registerStyleGuideRoutes(app,{store});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base=`http://127.0.0.1:${server.address().port}`;
 try{
  const fetchGuide=async p=>(await fetch(`${base}/api/style-guide?projectPath=${encodeURIComponent(p)}`)).json();
  const saveGuide=async(p,config,{source='ui'}={})=>{const r=await fetch(`${base}/api/style-guide`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({projectPath:p,config,source})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
  const state=createGuideState({debounce:5,fetchGuide,saveGuide});await state.load(project);
  // One edit per section, each a value the server keeps as sent.
  const edits=[['brand.name','Round Trip'],['brand.personality',['calm','exact']],['brand.voice.dos',['Be brief']],['colors.palettes.primary.usage','Links'],['colors.semantic.dark.text','{neutral.100}'],['colors.status.info','#0284c7'],['colors.gradients.0.usage','Hero'],['colors.themes.default','dark'],
   ['typography.fonts.heading.family','Manrope'],['typography.styles.h1.size',44],['typography.scale.ratio',1.333],['typography.principles',['One scale']],['layout.spacing.scale.md',14],['layout.breakpoints.md',800],['layout.zIndex.toast',1600],['layout.container.maxWidth',1280],['layout.principles',['Breathe']],
   ['shape.radius.md',10],['shape.radiusRoles.card','xl'],['shape.borders.thick',3],['shape.elevation.sm.usage','Raised cards'],['motion.durations.fast',120],['motion.easings.enter','cubic-bezier(0, 0, 0.3, 1)'],['motion.principles',['Quick']],
   ['iconography.notes','Outline only'],['iconography.sizes',[16,24]],['logo.clearSpace','1x mark height'],['logo.donts',['No stretch']],['imagery.mood','Calm'],['imagery.generation.promptPrefix','Soft light'],['imagery.generation.aspectRatios',['4:5']],
   ['components.0.notes','One per view'],['components.1.states.hover','background {neutral.100}'],['accessibility.level','AAA'],['accessibility.notes',['Focus visible']],['rules.dos',['Use tokens']],['rules.custom','## Extra\nText'],['responsive.notes',['Stack below md']],
   ['agents.instructions','Propose first'],['agents.inject.review',true],['agents.allowProposals',false],['exports.darkMode','class'],['exports.tailwind','v3']];
  for(const [path,value] of edits)state.set(path,structuredClone(value));
  await state.flush();const saved=structuredClone(state.config);
  for(const [path,value] of edits)assert.deepEqual(path.split('.').reduce((o,k)=>o?.[k],saved),value,path);
  await state.load(project);assert.deepEqual(state.config,saved);
  // Saving the reloaded guide unchanged keeps the revision: nothing was lost or rewritten.
  const again=await saveGuide(project,state.config);assert.equal(again.changed,false);assert.equal(again.revision,saved.revision);
  state.destroy();
 }finally{await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
});
