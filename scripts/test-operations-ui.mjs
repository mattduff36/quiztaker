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
import{HelperOnboarding}from ${JSON.stringify(join(root,'apps/web/src/components/helper-onboarding.tsx').replaceAll('\\','/'))};
import{ReviewList}from ${JSON.stringify(join(root,'apps/web/src/components/review-list.tsx').replaceAll('\\','/'))};
import{AppShell}from ${JSON.stringify(join(root,'apps/web/src/components/app-shell.tsx').replaceAll('\\','/'))};
function Fixture(){const[away,setAway]=React.useState(false);return <AppShell email="operator@example.invalid"><div className="fixture">{location.pathname==='/setup-test'?<><HelperOnboarding download={{status:'unavailable',url:null}} connection={{state:'not-paired'}}/><ReviewList reviews={[{id:'review-1',type:'test',title:'Review example',detail:'Review this item',next_action:'Retry the page',created_at:new Date().toISOString()}]}/></>:away?<p>Another page</p>:<><button onClick={()=>setAway(true)}>Navigate fixture away</button><OperationsClient helperId="${helperId}"/></>}</div></AppShell>};createRoot(document.getElementById('root')!).render(<Fixture/>);`);
await writeFile(join(temp,'navigation.ts'),`export const useRouter=()=>({refresh:()=>{}}); export const usePathname=()=>location.pathname;`);
await build({plugins:[{name:'test-router',setup(build){build.onResolve({filter:/^next\/navigation$/},()=>({path:join(temp,'navigation.ts')}));}}],entryPoints:[join(temp,'entry.tsx')],outfile:join(temp,'app.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',tsconfig:join(root,'apps/web/tsconfig.json'),define:{'process.env.NODE_ENV':'"test"','process.env':'{}'}});
const css=await postcss([tailwind({base:join(root,'apps/web')})]).process(await readFile(join(root,'apps/web/src/app/globals.css'),'utf8'),{from:join(root,'apps/web/src/app/globals.css')});
await writeFile(join(temp,'app.css'),css.css+'\n:root{--font-plex:Arial}body{margin:0}.fixture{max-width:1120px;margin:auto;padding:24px}');

function state(){return{last:null,paused:false,online:true,connected:true,updatePhase:null,refreshes:0,checks:0,statusFailed:false,statusStale:false,activityPosts:0,pausePosts:0,jobs:new Map(),latest:null,serial:0,selected:null,blocked:false,retries:0,task:null,finishPosts:0,questionOutput:'',pairPosts:0,holdCapability:null};}
function reply(path,method,body,now,s){
  const activity=()=>({paused:s.paused,lastActivityAt:new Date(s.last??now).toISOString(),expiresAt:new Date((s.last??now)+1_800_000).toISOString(),serverNow:new Date(now).toISOString()});
  const session=()=>s.noSession?null:({id:'22222222-2222-4222-8222-222222222222',revision:1,cdp_connected:s.connected,updated_at:new Date(now-(s.stale?120_000:0)).toISOString(),tabs:[...(!s.noCourse?[{targetId:'course',index:0,title:'Xerox course overview',url:'https://example.invalid/course',fingerprint:'course-fingerprint'}]:[]),{targetId:'blank',index:1,title:'Blank tab',url:'about:blank',fingerprint:'blank'}],roster:null,detection:null});
  function makeJob(capability){const id=`job-${++s.serial}`;const job={id,status:capability==='list-tabs'||capability===s.holdCapability?'running':'completed',capability_id:capability,outcome:{verified:true,status:'verified'},result:{ok:true,result:capability==='detect'?{detection:{detected:'server-assessment',tabIdx:0,url:'https://example.invalid/course',fingerprint:'course-fingerprint',detail:'Open a course page before attempting a final assessment.'}}:{}}};s.jobs.set(id,job);s.latest=job;return id;}
  if(path==='/api/helper/pair'){if(s.pairPosts++===0)return{__status:503,error:'Pairing is temporarily unavailable.'};return{code:'ABCD1234',expiresAt:new Date(now+2000).toISOString(),controlPlaneUrl:'https://example.invalid'};}
  if(path==='/api/reviews/review-1/resolve')return{__status:503,error:'Unavailable'};
  if(path==='/api/operations/activity'){
    if(s.last===null)s.last=now;
    if(body.action==='resume'){s.paused=false;s.last=now;}
    else if(body.action==='pause'){s.paused=true;s.pausePosts++;}
    else if(now-s.last>=1_800_000)s.paused=true;
    if(body.action==='activity'){s.activityPosts++;if(!s.paused)s.last=now;}
    if(body.action==='refresh'){if(s.refreshError)return{__status:503,error:'Browser refresh unavailable.'};if(s.paused)return{status:'skipped'};s.refreshes++;return{status:'queued',jobId:makeJob('list-tabs')};}
    return activity();
  }
  if(path==='/api/operations/context'){s.checks++;return{helper:s.unpaired?null:{id:helperId,device_name:'Test PC',version:s.helperVersion||'1.0.19',protocol_version:2,is_online:s.online},helperUpdate:s.updatePhase?{needed:true,protocolBlocked:false,currentVersion:'1.0.19',latestVersion:'1.0.21',installerAvailable:true,canSelfUpdate:true,mode:'queue',requestedVersion:'1.0.21',error:null,phase:s.updatePhase,phaseVersion:'1.0.21',phaseUpdatedAt:new Date(now).toISOString(),inProgress:true,progressLabel:'Installing · waiting for the helper to reconnect'}:undefined,courseCoverage:[{source:'https://example.invalid/course',title:'Paper theory',inventoryObserved:true,updatedAt:new Date(now).toISOString(),topics:[{title:'Paper production',visitedAt:new Date(now).toISOString(),collectedAt:new Date(now).toISOString(),collectedChars:400},{title:'Paper types',visitedAt:new Date(now).toISOString(),collectedChars:0},{title:'Paper storage',collectedChars:0}]}],operatorActivity:s.last===null?null:activity(),session:session(),activeJob:s.latest,latestTask:s.task,captures:[],recentUrls:[],learnerEnabled:true};}
  if(path==='/api/operations/tasks/finish'){
    s.finishPosts++;const task=s.jobs.get(body.jobId);task.status=body.result;task.outcome={status:`operator-${body.result}`,verified:false,operatorResolution:{result:body.result,requestedAt:new Date(now).toISOString(),resolvedAt:new Date(now).toISOString(),reportedBy:'operator'}};s.task=task;return{ok:true,status:body.result,jobId:task.id};
  }
  if(path==='/api/services/status')return s.statusFailed?{__status:503,error:'Service status is unavailable.'}:{checkedAt:new Date(now).toISOString(),activity:{session:!s.paused&&s.online&&s.connected&&!s.noSession,task:Boolean(s.task&&['queued','running','dispatched'].includes(s.task.status))},helper:{online:s.online,lastSeenAt:new Date(now).toISOString()},browser:{connected:s.connected&&!s.noSession,checkedAt:new Date(now-(s.statusStale?120_000:0)).toISOString()},assistant:{ready:true,source:'personal',provider:'openai'}};
  if(path.startsWith('/api/operations/learning'))return{id:null,objective:null,history:[]};
  if(path==='/api/operations/actions'){
    if(body.capabilityId==='start-browser'){s.startConfirm=body.confirm;s.starts=(s.starts||0)+1;if(s.actionError)return{__status:503,error:'Start unavailable.'};return{jobId:makeJob('start-browser')};}
    if(body.capabilityId==='detect'&&!s.blocked){s.blocked=true;makeJob('list-tabs');return{plan:{planId:'detect-plan'},waitingForJob:true};}
    return{jobId:makeJob(body.capabilityId)};
  }
  if(path==='/api/jobs'){
    if(body.planId!=='detect-plan')throw Error('The foreground plan changed during refresh');
    if(s.retries++===0){s.latest.status='completed';return{__status:409,error:'A job is already active. Wait for it to finish or cancel it first.'};}
    return{jobId:makeJob('detect')};
  }
  if(path.startsWith('/api/jobs/')){const job=s.jobs.get(path.split('/').at(-1));if(job&&job.capability_id!==s.holdCapability&&job.status!=='failed')job.status='completed';return{job,events:job?.capability_id==='quiz-learn'?[{data:{text:s.questionOutput}}]:[],artifacts:[]};}
  throw Error(`Unexpected fixture request: ${method} ${path}`);
}
let servedState=state();
const server=createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/')){let text='';for await(const chunk of req)text+=chunk;const result=reply(req.url,req.method,text?JSON.parse(text):{},Date.now(),servedState);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;}
    if(req.url==='/app.js'||req.url==='/app.css'){res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(await readFile(join(temp,req.url.slice(1))));return;}
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Vitriol Operations verification</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  }catch(error){res.writeHead(500);res.end(String(error));}
});
for(let attempt=0;attempt<10;attempt++){
  try{await new Promise((done,reject)=>{server.once('error',reject);server.listen(30000+Math.floor(Math.random()*20000),'127.0.0.1',()=>{server.removeListener('error',reject);done();});});break;}
  catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code)||attempt===9)throw error;}
}
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
let passed=false;
try{
  // Stage matrix uses isolated offline fixtures, including delayed requests and remounts.
  for(const viewport of [{width:1365,height:1000},{width:390,height:844}]) {
    for(const scenario of ['loading','unpaired','offline','offline-new','absent','disconnected','stale','no-course','blank-goal','old-finished','old-finished-start','start-error','start-pending']) {
      const page=await browser.newPage({viewport,...(scenario==='offline-new'?{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'}:{})}); const fixture=state();
      if(scenario==='offline-new'){fixture.online=false;fixture.helperVersion='1.0.24';await page.clock.install();await page.addInitScript(()=>document.addEventListener('click',event=>{if(event.target.closest('a')?.getAttribute('href')?.startsWith('vitriol-helper:'))event.preventDefault();},true));}
      if(scenario==='old-finished-start'){await page.clock.install();fixture.holdCapability='start-browser';}
      Object.assign(fixture,scenario==='unpaired'?{unpaired:true}:scenario==='offline'?{online:false}:scenario==='absent'?{noSession:true}:scenario==='disconnected'||scenario.startsWith('start-')?{connected:false}:scenario==='stale'?{stale:true,paused:true}:scenario==='no-course'?{noCourse:true}:{});
      if(scenario.startsWith('old-finished')){fixture.task={id:'old-task',status:'completed',capability_id:'quiz-learn',outcome:{operatorResolution:{result:'completed',requestedAt:new Date().toISOString(),resolvedAt:new Date().toISOString()}}};fixture.jobs.set('old-task',fixture.task);if(scenario==='old-finished-start')fixture.connected=false;}
      let release;const held=new Promise(done=>{release=done;});let actions=0;
      await page.route('**/api/**',async route=>{
        const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON()||{};
        if(scenario==='loading'&&path==='/api/operations/context')await held;
        if(path==='/api/operations/actions'){actions++;if(scenario==='start-pending')await held;}
        if(scenario==='start-error')fixture.actionError=true;
        const result=reply(path,req.method(),body,Date.now(),fixture),{__status,...json}=result;
        await route.fulfill({status:__status||200,json});
      });
      await page.goto(url);
      if(['loading','unpaired','offline','offline-new','absent','disconnected','stale'].includes(scenario)) {
        await expect(page.getByRole('heading',{name:'Work on a course',exact:true})).toBeHidden();
        await expect(page.getByText('Course material checklist',{exact:true})).toBeHidden();
      }
      if(scenario==='loading') {await expect(page.getByRole('heading',{name:'Checking connection…',exact:true})).toBeVisible();release();}
      if(scenario==='unpaired'){await expect(page.getByRole('heading',{name:'Welcome. Let’s get your course ready.',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Download Windows helper',exact:true})).toBeVisible();}
      if(scenario==='offline'){await expect(page.getByRole('heading',{name:'Welcome back. Let’s get connected.',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Update Vitriol Helper',exact:true})).toBeVisible();}
      if(scenario==='offline-new') {
        const open=page.getByRole('link',{name:'Open Vitriol Helper',exact:true});await expect(open).toHaveAttribute('href','vitriol-helper://open');
        await open.click();await expect(page.getByRole('link',{name:'Waiting for helper…',exact:true}).first()).toHaveAttribute('aria-disabled','true');
        await page.clock.fastForward(13_000);await expect(page.getByText(/No connection yet/)).toBeVisible();await expect(page.getByRole('link',{name:'Download or reinstall',exact:true})).toBeVisible();
        await page.screenshot({path:join(artifacts,`${viewport.width}-welcome-recovery.png`),fullPage:true});
        fixture.online=true;await page.clock.fastForward(16_000);await expect(page.getByRole('heading',{name:'Work on a course',exact:true})).toBeVisible();
      }
      if(scenario==='absent'||scenario==='disconnected')await expect(page.getByRole('button',{name:'Start browser',exact:true})).toBeEnabled();
      if(scenario==='stale'){await expect(page.getByRole('heading',{name:'Browser check needed',exact:true})).toBeVisible();expect(fixture.refreshes).toBe(0);}
      if(scenario==='no-course'){await expect(page.getByText('No course page is open yet.',{exact:false})).toBeVisible();await expect(page.getByRole('textbox',{name:/What would you like to achieve/})).toBeHidden();}
      if(scenario==='blank-goal'){await page.getByRole('combobox',{name:'Course tab',exact:true}).selectOption('course');await page.getByRole('textbox',{name:/What would you like to achieve/}).fill('');await expect(page.getByRole('button',{name:'Inspect and start',exact:true})).toBeDisabled();}
      if(scenario==='old-finished'){await expect(page.getByRole('heading',{name:'Work on a course',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Current task',exact:true})).toBeHidden();await expect(page.getByText(/Marked completed by you/)).toBeHidden();await expect(page.getByText('Task recorded',{exact:true})).toBeHidden();}
      if(scenario==='old-finished-start'){await page.getByRole('button',{name:'Start browser',exact:true}).click();await expect.poll(()=>fixture.starts).toBe(1);await page.clock.fastForward(31_000);await expect(page.getByText(/Marked completed by you/)).toBeHidden();await expect(page.getByRole('heading',{name:'Current task',exact:true})).toBeHidden();}
      if(scenario.startsWith('start-')) {
        await page.getByRole('button',{name:'Start browser',exact:true}).click();
        if(scenario==='start-pending') {
          await expect(page.getByText('Starting browser…',{exact:true})).toBeVisible();
          await page.getByRole('button',{name:'Start browser',exact:true}).dispatchEvent('click');
          expect(actions).toBe(1);release();
          await expect.poll(()=>fixture.starts).toBe(1);expect(fixture.startConfirm).toBe(true);
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await page.reload();await expect(page.getByRole('heading',{name:'Work on a course',exact:true})).toBeHidden();expect(fixture.starts).toBe(1);
        }else await expect(page.getByRole('alert')).toContainText('Start unavailable.');
      }
      if(['offline','absent','no-course','stale','start-pending'].includes(scenario))await page.screenshot({path:join(artifacts,`${viewport.width}-${scenario}.png`),fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.close();
    }
    console.log(`PASS ${viewport.width}px progressive stage matrix, delayed start duplicate guard, error and remount.`);
  }
  for(const explicitlyStop of [false,true]) {
    const page=await browser.newPage();const fixture=state();fixture.paused=true;
    let release;const held=new Promise(done=>{release=done;});let queued=0,deletes=0;
    await page.route('**/api/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON()||{};
      if(path==='/api/operations/actions'&&body.capabilityId==='list-tabs'){queued++;await held;}
      if(path.startsWith('/api/jobs/')&&req.method()==='DELETE')deletes++;
      const result=reply(path,req.method(),body,Date.now(),fixture),{__status,...json}=result;
      await route.fulfill({status:__status||200,json});
    });
    await page.goto(url);await page.getByRole('button',{name:'Resume session',exact:true}).click();
    await page.getByRole('combobox',{name:'Course tab',exact:true}).selectOption('course');
    await page.getByRole('textbox',{name:/What would you like to achieve/}).fill('Read this course');
    await page.getByRole('button',{name:'Inspect and start',exact:true}).click();
    await expect.poll(()=>queued).toBe(1);
    if(explicitlyStop)await page.getByRole('button',{name:'Stop',exact:true}).click();
    await page.getByRole('button',{name:'Navigate fixture away',exact:true}).click();release();
    await expect.poll(()=>fixture.jobs.size).toBeGreaterThan(0);
    if(explicitlyStop)await expect.poll(()=>deletes).toBe(1);
    else {await page.waitForTimeout(100);expect(deletes).toBe(0);}
    await page.close();
  }
  console.log('PASS navigation preserves acknowledged jobs; explicit Stop survives pending queue and navigation.');
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
    const services=page.getByRole('navigation',{name:'Service status',exact:true});
    await expect(services.getByRole('link',{name:'Helper: Connected',exact:true})).toBeVisible();
    await expect(services.getByRole('link',{name:'Assistant: Configured',exact:true})).toBeVisible();
    const normal=page.getByRole('tab',{name:'Normal',exact:true});
    const advanced=page.getByRole('tab',{name:'Advanced',exact:true});
    await expect(normal).toHaveAttribute('aria-selected','true');
    const select=page.getByRole('combobox',{name:'Course tab',exact:true});
    await expect(select).toBeEnabled();
    await expect(select.getByRole('option')).toHaveCount(2);
    await select.selectOption('course');
    const goal=page.getByRole('textbox',{name:/What would you like to achieve/});
    const mode=page.getByRole('combobox',{name:'Course activity',exact:true});
    await expect(mode).toHaveValue('read');
    await expect(goal).toHaveValue(/Read all relevant material.*Xerox course overview/);
    await goal.fill('x'.repeat(1005));
    await expect(goal).toHaveValue('x'.repeat(1000));
    await goal.fill('');
    // User edits are preserved; this fixture now checks default mode goals on a fresh mount.
    await page.reload();
    await select.selectOption('course');
    await mode.selectOption('quiz');
    await expect(goal).toHaveValue(/answer and submit.*Xerox course overview/);
    await mode.selectOption('read');
    await expect(goal).toHaveValue(/Read all relevant material/);
    await goal.fill('Read this course overview and ask me before continuing.');
    await page.getByText('Course material checklist',{exact:true}).click();
    await expect(page.getByText('3 topics found · 1 with collected material · 1 unchecked',{exact:true})).toBeVisible();
    await expect(page.getByText('Visited · not collected',{exact:true})).toBeVisible();
    await page.screenshot({path:join(artifacts,viewport.width>500?'desktop-coverage.png':'mobile-coverage.png'),fullPage:true});
    fixture.updatePhase='installing';fixture.online=false;
    await page.clock.fastForward(16_000);
    await expect(page.getByText('Installing · waiting for the helper to reconnect · v1.0.21',{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Work on a course',exact:true})).toBeHidden();
    const probesDuringUpdate=fixture.refreshes;
    await page.clock.fastForward(46_000);
    expect(fixture.refreshes).toBe(probesDuringUpdate);
    await advanced.click();
    await expect(page.getByRole('button',{name:'End browser session',exact:true})).toBeDisabled();
    await page.screenshot({path:join(artifacts,viewport.width>500?'desktop-update.png':'mobile-update.png'),fullPage:true});
    await normal.click();
    await expect(goal).toBeHidden();
    fixture.updatePhase=null;fixture.online=true;
    await page.clock.fastForward(16_000);
    await expect(page.getByRole('button',{name:'Inspect and start',exact:true})).toBeEnabled();
    const jobsBeforeSwitch=[...fixture.jobs.values()].filter(job=>job.capability_id!=='list-tabs').length;
    await advanced.click();
    await expect(advanced).toHaveAttribute('aria-selected','true');
    await expect(goal).toBeHidden();
    await expect(page.getByRole('button',{name:'End browser session',exact:true})).toBeVisible();
    await expect(services).toBeVisible();
    await page.screenshot({path:join(artifacts,viewport.width>500?'desktop-advanced.png':'mobile-advanced.png'),fullPage:true});
    await advanced.press('Home');
    await expect(normal).toHaveAttribute('aria-selected','true');
    await expect(normal).toBeFocused();
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    expect([...fixture.jobs.values()].filter(job=>job.capability_id!=='list-tabs').length).toBe(jobsBeforeSwitch);
    await goal.focus();
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
    await page.evaluate(()=>window.scrollTo(0,0));
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
    await advanced.click();
    await expect(page.getByRole('button',{name:'End browser session',exact:true})).toBeEnabled();
    const probesWhenPaused=fixture.refreshes;
    await page.clock.fastForward(60_000);
    expect(fixture.refreshes).toBe(probesWhenPaused);
    await page.getByRole('button',{name:'Resume session',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Your session is paused',exact:true})).toBeHidden();
    await normal.click();
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    fixture.statusStale=true;
    await page.clock.fastForward(21_000);
    await expect(services.getByRole('link',{name:'Browser: Check overdue',exact:true})).toBeVisible();
    fixture.statusFailed=true;
    await page.clock.fastForward(21_000);
    await expect(services.getByRole('link',{name:'Website: Unavailable',exact:true})).toBeVisible();
    await expect(services.getByRole('link',{name:'Helper: Unknown',exact:true})).toBeVisible();
    fixture.statusFailed=false;fixture.statusStale=false;
    await page.clock.fastForward(41_000);
    await expect(services.getByRole('link',{name:'Browser: Connected',exact:true})).toBeVisible();
    // A real awaiting question survives a later maintenance job and pause/offline state.
    const task={id:'question-task',status:'completed',capability_id:'quiz-learn',input:{target:{targetId:'course',browserSessionId:'22222222-2222-4222-8222-222222222222'}}};
    fixture.jobs.set(task.id,task);fixture.latest=task;fixture.task=task;
    fixture.questionOutput='LEARNER_QUESTION '+JSON.stringify({question:'Which module should I read next?',options:['Paper storage','Paper types'],url:'https://example.invalid/course'});
    await page.clock.fastForward(16_000);
    await expect(page.getByRole('heading',{name:'Your AI assistant has a question',exact:true})).toBeVisible();
    const refreshesWithQuestion=fixture.refreshes;
    fixture.latest={id:'background-observation',status:'completed',capability_id:'list-tabs'};
    await page.clock.fastForward(46_000);
    expect(fixture.refreshes).toBe(refreshesWithQuestion);
    await expect(page.getByText('Which module should I read next?',{exact:true})).toBeVisible();
    await expect(goal).toHaveValue('Read this course overview and ask me before continuing.');
    await page.getByRole('button',{name:'Pause session',exact:true}).click();
    fixture.online=false;
    await page.clock.fastForward(61_000);
    await expect(page.getByRole('heading',{name:'Your session is paused',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Paper storage',exact:true})).toBeHidden();
    await expect(page.getByRole('button',{name:'Mark complete',exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:'Mark failed',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Mark complete',exact:true}).click();
    await expect(page.getByText(/Marked completed by you/)).toBeVisible();
    await expect(goal).toBeHidden();
    await expect(page.getByText('Which module should I read next?',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'End browser session',exact:true})).toBeHidden();
    expect(fixture.finishPosts).toBe(1);
    await page.clock.fastForward(60_000);
    expect(fixture.refreshes).toBe(refreshesWithQuestion);
    // Finishing during a guided wait stops the local orchestrator before another step can queue.
    fixture.online=true;fixture.paused=false;fixture.holdCapability='detect';
    await page.clock.fastForward(61_000);
    await goal.fill('Read the selected course page.');
    await expect(page.getByRole('button',{name:'Inspect and start',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Inspect and start',exact:true}).click();
    await expect.poll(()=>fixture.latest?.capability_id).toBe('detect');
    await expect(page.getByRole('button',{name:'Mark failed',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Mark failed',exact:true}).click();
    await expect(page.getByText(/Marked failed by you/)).toBeVisible();
    const jobsAtFinish=fixture.serial;
    await page.clock.fastForward(8000);
    expect(fixture.serial).toBe(jobsAtFinish);
    expect(fixture.finishPosts).toBe(2);
    await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
    await page.goto(url+'/setup-test');
    await expect(page.getByRole('button',{name:'Generate code',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Generate code',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('Pairing is temporarily unavailable.');
    await page.getByRole('button',{name:'Generate code',exact:true}).click();
    await expect(page.getByRole('link',{name:'Launch Vitriol Helper',exact:true})).toHaveAttribute('href',/^vitriol-helper:\/\/pair/);
    await page.clock.fastForward(3000);
    await expect(page.getByText('Your pairing code has expired.',{exact:false})).toBeVisible();
    await expect(page.getByRole('button',{name:'Generate code',exact:true})).toBeEnabled();
    await expect(page.getByRole('link',{name:'Launch Vitriol Helper',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Resolve',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('Could not resolve this review.');
    await expect(page.getByText('Review example',{exact:true})).toBeVisible();
    await page.screenshot({path:join(artifacts,viewport.width>500?'desktop-helper-recovery.png':'mobile-helper-recovery.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    console.log(`PASS ${viewport.width}px: Normal/Advanced preserve state and keyboard focus; compact service status handles stale/failure/recovery; guided start, automatic refresh and idle protection.`);
    await page.close();
  }
  passed=true;
}finally{
  await browser.close();
  if(process.argv.includes('--serve')&&passed){servedState=state();console.log(`UI_FIXTURE_URL=${url}`);}
  else{await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});}
}
