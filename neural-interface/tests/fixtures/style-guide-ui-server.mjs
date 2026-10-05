// Isolated editor fixture for visual checks in the SynaBun internal browser.
// No browser is started here. All API state and artifacts live in a temp folder.
import express from 'express';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createStyleGuideStore} from '../../lib/style-guide/store.js';
import {registerStyleGuideRoutes} from '../../lib/style-guide/api.js';
const temp=mkdtempSync('/private/tmp/synabun-sg-visual-'),project=join(temp,'project');
mkdirSync(project);
const store=createStyleGuideStore({dataHome:temp,projects:()=>[{path:project,label:'Style Guide preview'}]});
const app=express();app.use(express.json({limit:'2mb'}));
registerStyleGuideRoutes(app,{store});
app.get('/shared/storage.js',(req,res)=>res.type('js').send("export const storage={getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v),removeItem:k=>localStorage.removeItem(k)};"));
app.get('/shared/ui-sync.js',(req,res)=>res.type('js').send('export const isGuest=()=>false;export const hasPermission=()=>true;export const showGuestToast=()=>{};'));
app.get('/shared/ui-sidepanel-runtime.js',(req,res)=>res.type('js').send('export const routeSidepanelEvent=()=>false;'));
app.get('/shared/ui-native-loop-router.js',(req,res)=>res.type('js').send('export const getNativeLoopRouterClaimToken=()=>null;export const getNativeLoopRouterWindowId=()=>null;export const routeNativeLoopRun=()=>false;'));
app.get('/api/config',(req,res)=>res.json({}));app.get('/favicon.ico',(req,res)=>res.status(204).end());
app.use('/i18n',express.static(resolve(import.meta.dirname,'../../i18n')));
app.get('/',(req,res)=>res.send(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/shared/styles.css"><style>html,body{margin:0;height:100%;background:#101014;font-family:Inter,system-ui,sans-serif;overflow:hidden}</style></head><body><button id="open">Style Guide</button><script type="module">import {initStyleGuide} from '/shared/ui-styleguide.js';import {emit} from '/shared/state.js';initStyleGuide();document.querySelector('#open').onclick=()=>emit('styleguide:open');window.ready=true;</script></body></html>`));
app.use(express.static(resolve(import.meta.dirname,'../../public')));
const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,project,pid:process.pid})));
const stop=()=>server.close(()=>{rmSync(temp,{recursive:true,force:true});process.exit(0);});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
