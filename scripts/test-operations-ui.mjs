/** Offline browser tests of the real Operations component. No credentials, LMS or provider calls. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {chromium,expect} from '@playwright/test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(join(tmpdir(),'vitriol-operations-'));
const artifacts=process.env.OPERATIONS_UI_ARTIFACTS || join(root,'test-results','operations-ui');
await mkdir(artifacts,{recursive:true});
const helperId='11111111-1111-4111-8111-111111111111';
await writeFile(join(temp,'entry.tsx'),`import React from ${JSON.stringify(join(root,'node_modules/react/index.js').replaceAll('\\','/'))};
import{createRoot}from ${JSON.stringify(join(root,'node_modules/react-dom/client.js').replaceAll('\\','/'))};
import{OperationsClient}from ${JSON.stringify(join(root,'apps/web/src/components/operations-client.tsx').replaceAll('\\','/'))};
createRoot(document.getElementById('root')!).render(<OperationsClient helperId="${helperId}"/>);`);
await build({entryPoints:[join(temp,'entry.tsx')],outfile:join(temp,'app.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',tsconfig:join(root,'apps/web/tsconfig.json'),define:{'process.env.NODE_ENV':'"test"'}});
const css=await postcss([tailwind({base:join(root,'apps/web')})]).process(await readFile(join(root,'apps/web/src/app/globals.css'),'utf8'),{from:join(root,'apps/web/src/app/globals.css')});
await writeFile(join(temp,'app.css'),css.css+'\n:root{--font-plex:Arial}body{margin:0}.fixture{max-width:1120px;margin:auto;padding:24px}');

function state(){return{last:null,paused:false,online:true,connected:true,refreshes:0,checks:0,activityPosts:0,pausePosts:0,jobs:new Map(),latest:null,serial:0,selected:null,blocked:false,retries:0};}
function reply(path,method,body,now,s){
  const activity=()=>({paused:s.paused,lastActivityAt:new Date(s.last??now).toISOString(),expiresAt:new Date((s.last??now)+1_800_000).toISOString(),serverNow:new Date(now).toISOString()});
  const session=()=>({id:'22222222-2222-4222-8222-222222222222',revision:1,cdp_connected:s.connected,updated_at:new Date(now).toISOString(),tabs:[{targetId:'course',index:0,title:'Xerox course overview',url:'https://example.invalid/course',fingerprint:'course-fingerprint'},{targetId:'blank',index:1,title:'Blank tab',url:'about:blank',fingerprint:'blank'}],roster:null,detection:null});
  function makeJob(capability){const id=`job-${++s.serial}`;const job={id,status:capability==='list-tabs'?'running':'completed',capability_id:capability,outcome:{verified:true,status:'verified'},result:{ok:true,result:capability==='detect'?{detection:{detected:'server-assessment',tabIdx:0,url:'https://example.invalid/course',fingerprint:'course-fingerprint',detail:'Open a course page before attempting a final assessment.'}}:{}}};s.jobs.set(id,job);s.latest=job;return id;}
  if(path==='/api/operations/activity'){
    if(s.last===null)s.last=now;
    if(body.action==='resume'){s.paused=false;s.last=now;}
    else if(body.action==='pause'){s.paused=true;s.pausePosts++;}
    else if(now-s.last>=1_800_000)s.paused=true;
    if(body.action==='activity'){s.activityPosts++;if(!s.paused)s.last=now;}
    if(body.action==='refresh'){if(s.paused)return{status:'skipped'};s.refreshes++;return{status:'queued',jobId:makeJob('list-tabs')};}
    return activity();
  }
  if(path==='/api/operations/context'){s.checks++;return{helper:{id:helperId,device_name:'Test PC',version:'1.0.15',protocol_version:2,is_online:s.online},operatorActivity:s.last===null?null:activity(),session:session(),activeJob:s.latest,captures:[],recentUrls:[],learnerEnabled:true};}
  if(path.startsWith('/api/operations/learning'))return{id:null,objective:null,history:[]};
  if(path==='/api/operations/actions'){
    if(body.capabilityId==='detect'&&!s.blocked){s.blocked=true;makeJob('list-tabs');return{plan:{planId:'detect-plan'},waitingForJob:true};}
    return{jobId:makeJob(body.capabilityId)};
  }
  if(path==='/api/jobs'){
    if(body.planId!=='detect-plan')throw Error('The foreground plan changed during refresh');
    if(s.retries++===0){s.latest.status='completed';return{__status:409,error:'A job is already active. Wait for it to finish or cancel it first.'};}
    return{jobId:makeJob('detect')};
  }
  if(path.startsWith('/api/jobs/')){const job=s.jobs.get(path.split('/').at(-1));if(job)job.status='completed';return{job,events:[],artifacts:[]};}
  throw Error(`Unexpected fixture request: ${method} ${path}`);
}
let servedState=state();
const server=createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/')){let text='';for await(const chunk of req)text+=chunk;const result=reply(req.url,req.method,text?JSON.parse(text):{},Date.now(),servedState);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;}
    if(req.url==='/app.js'||req.url==='/app.css'){res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(await readFile(join(temp,req.url.slice(1))));return;}
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Vitriol Operations verification</title></head><body><main class="fixture"><div id="root"></div></main><script src="/app.js"></script></body></html>');
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
let passed=false;
try{
  for(const viewport of [{width:1365,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const fixture=state();
    await page.clock.install({time:new Date()});
    await page.route('**/api/**',async route=>{
      const req=route.request();const now=await page.evaluate(()=>Date.now());
      const result=reply(new URL(req.url()).pathname+new URL(req.url()).search,req.method(),req.postDataJSON()||{},now,fixture);
      const {__status,...json}=result;await route.fulfill({status:__status||200,json});
    });
    await page.goto(url);
    const select=page.getByRole('combobox',{name:'Course tab',exact:true});
    await expect(select).toBeEnabled();
    await expect(select.getByRole('option')).toHaveCount(2);
    await select.selectOption('course');
    const goal=page.getByRole('textbox',{name:/What would you like to achieve/});
    const mode=page.getByRole('combobox',{name:'Course activity',exact:true});
    await expect(mode).toHaveValue('read');
    await expect(goal).toHaveValue(/Read all relevant material.*Xerox course overview/);
    await mode.selectOption('quiz');
    await expect(goal).toHaveValue(/answer and submit.*Xerox course overview/);
    await mode.selectOption('read');
    await expect(goal).toHaveValue(/Read all relevant material/);
    await goal.fill('Read this course overview and ask me before continuing.');
    await expect(page.getByRole('button',{name:'Inspect and start',exact:true})).toBeEnabled();
    const before=fixture.refreshes;
    await page.clock.fastForward(46_000);
    await expect.poll(()=>fixture.refreshes).toBeGreaterThan(before);
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    await mode.selectOption('quiz');
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    await mode.selectOption('read');
    await expect(goal).toBeFocused();
    await expect(select).toHaveValue('course');
    await expect(page.getByRole('button',{name:'Inspect and start',exact:true})).toBeEnabled();
    await page.screenshot({path:join(artifacts,viewport.width>500?'desktop.png':'mobile.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Inspect and start',exact:true}).click();
    await expect(page.getByText('This page is a quiz.',{exact:false})).toBeVisible();
    await mode.selectOption('quiz');
    await expect(page.getByText('This page is a quiz.',{exact:false})).toHaveCount(0);
    await mode.selectOption('read');
    await expect(page.getByText('This page is a quiz.',{exact:false})).toHaveCount(0);
    expect(fixture.retries).toBe(2);
    await page.clock.fastForward(28*60_000+5_000);
    await expect(page.getByRole('button',{name:'Keep working',exact:true})).toBeVisible();
    await page.clock.fastForward(2*60_000);
    await expect(page.getByRole('heading',{name:'Your session is paused',exact:true})).toBeVisible();
    await expect.poll(()=>fixture.pausePosts).toBe(0);
    const advanced=page.getByText('Advanced tools',{exact:false}).first();
    if(await advanced.count())await advanced.click();
    await expect(page.getByRole('button',{name:'End session',exact:true})).toBeEnabled();
    const probesWhenPaused=fixture.refreshes;
    await page.clock.fastForward(60_000);
    expect(fixture.refreshes).toBe(probesWhenPaused);
    await page.getByRole('button',{name:'Resume session',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Your session is paused',exact:true})).toBeHidden();
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    expect(errors).toEqual([]);
    console.log(`PASS ${viewport.width}px: guided start, preserved focus/input, automatic refresh, idle warning/pause and explicit resume.`);
    await page.close();
  }
  passed=true;
}finally{
  await browser.close();
  if(process.argv.includes('--serve')&&passed){servedState=state();console.log(`UI_FIXTURE_URL=${url}`);}
  else{await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});}
}
