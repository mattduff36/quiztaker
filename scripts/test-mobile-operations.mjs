/** Real Operations + two clients + encrypted relay + actual isolated helper/CDP adapter.
 * Run with tsx and the web tsconfig. No live helper, port 9222, credentials or DB.
 */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {chromium,expect} from '@playwright/test';
import {MobileStore} from '../apps/web/test/fixtures/mobile-store.ts';
import {sharedOperations,idempotentOperation,assertSharedWorkflow} from '../apps/web/src/lib/shared-operations-store.ts';
import {remoteViewer,remoteHelper} from '../apps/web/src/lib/remote-relay.ts';
import {RemoteBroker} from '../apps/helper/src/remote.ts';
import {RemoteBrowser} from '../apps/helper/src/remote-browser.ts';
const require=createRequire(import.meta.url);
const {browserTargetId}=require('../lib/browser-tabs.js');
const root=resolve('.'),temp=await mkdtemp(join(tmpdir(),'vitriol-mobile-'));
const store=new MobileStore(),errors=[],wire=[],jobs=new Map(),starts=[];
let latest=null,serial=0,localIdle=true,relayOffline=false,broker,captures=0,dropCommand=false,dropped=0;
const browser=await chromium.launch({channel:'chrome',headless:true});
const courseContext=await browser.newContext({viewport:{width:1000,height:700}});
await courseContext.route('https://course.invalid/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><title>${new URL(route.request().url()).pathname==='/second'?'Second course':'Fixture course'}</title>
  <style>body{margin:0;height:2200px}input{position:absolute;top:80px;left:50px;width:300px;height:42px}</style>
  <input aria-label="Fixture login" onkeydown="if(event.key==='Enter')document.body.dataset.enter='yes'"><h1>Course fixture</h1>`}));
const course=await courseContext.newPage();await course.goto('https://course.invalid/course');
const second=await courseContext.newPage();await second.goto('https://course.invalid/second');
const tabIds=[await browserTargetId(course),await browserTargetId(second)];
const geometry=await course.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:screenX,y:screenY,outerWidth,outerHeight}));
const session=()=>({id:store.sessionId,revision:1,cdp_connected:true,updated_at:new Date().toISOString(),tabs:[course,second].map((p,i)=>({
  targetId:`course-${i}`,cdpTargetId:tabIds[i],index:i,title:i?'Second course':'Fixture course',url:p.url(),fingerprint:`fixture-${i}`,
})),detection:null,roster:null});
const activity=()=>({paused:store.paused,lastActivityAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString(),serverNow:new Date().toISOString()});
function makeJob(capability){
  starts.push(capability);
  const job={id:`job-${++serial}`,capability_id:capability,status:'running',created:Date.now(),
    result:{ok:true,result:capability==='detect'?{detection:{detected:'unknown',tabIdx:0,url:course.url(),fingerprint:'fixture-0',detail:'Fixture format'}}:{}},
    outcome:{verified:false,status:'needs-user-input'}};
  jobs.set(job.id,job);latest=job;store.active=true;return job.id;
}
await writeFile(join(temp,'entry.tsx'),`import React from ${JSON.stringify(join(root,'node_modules','react','index.js'))};
import{createRoot}from ${JSON.stringify(join(root,'node_modules','react-dom','client.js'))};
import{OperationsClient}from ${JSON.stringify(join(root,'apps','web','src','components','operations-client.tsx'))};
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl p-4"><OperationsClient helperId="${store.helperId}"/></main>);`);
await build({entryPoints:[join(temp,'entry.tsx')],outfile:join(temp,'app.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',
  tsconfig:join(root,'apps','web','tsconfig.json'),define:{'process.env.NODE_ENV':'"test"','process.env':'{}'}});
const css=await postcss([tailwind({base:join(root,'apps','web')})]).process(await readFile(join(root,'apps','web','src','app','globals.css'),'utf8'),{from:join(root,'apps','web','src','app','globals.css')});
await writeFile(join(temp,'app.css'),css.css+'\nbody{margin:0}');
const server=createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/')){
      if(!req.headers.cookie?.includes('fixtureAccount=owner')){res.writeHead(401);res.end('{}');return;}
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=raw?JSON.parse(raw):{},path=new URL(req.url,'http://fixture.invalid').pathname;
      let value;
      if(path==='/api/operations/shared')value=await sharedOperations(store.userId,body,store);
      else if(path==='/api/operations/remote'){
        wire.push(raw);
        if(relayOffline){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Fixture relay disconnected"}');return;}
        value=await remoteViewer(store.userId,body,store);
      }else if(path==='/api/operations/context')value={helper:{id:store.helperId,is_online:true,version:'1.0.48',protocol_version:2},session:session(),operatorActivity:activity(),activeJob:latest,learnerEnabled:true,captures:[],recentUrls:[]};
      else if(path==='/api/operations/activity'){
        if(body.action==='pause')store.paused=true;if(body.action==='resume')store.paused=false;
        value=body.action==='refresh'?{status:'skipped'}:activity();
      }else if(path==='/api/operations/learning')value={id:null,objective:null,history:[]};
      else if(path==='/api/operations/actions'){
        const response=await idempotentOperation(store.userId,store.helperId,body.requestId,body,async()=>{
          await assertSharedWorkflow(store.query,store.userId,store.helperId,body.sharedClientId,body.workflowId);
          return Response.json({jobId:makeJob(body.capabilityId)});
        },store);
        res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());return;
      }else if(path.startsWith('/api/jobs/')){
        const job=jobs.get(path.split('/').at(-1));
        if(Date.now()-job.created>350){job.status=job.capability_id==='quiz-learn'?'awaiting-input':'completed';store.active=false;}
        value={job,events:job.capability_id==='quiz-learn'?[{data:{text:'LEARNER_QUESTION '+JSON.stringify({question:'Which fixture topic next?',url:course.url()})}}]:[]};
      }else throw new Error(`Unexpected fixture route ${path}`);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
    }
    if(req.url==='/app.js'||req.url==='/app.css'){res.writeHead(200,{'Content-Type':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(await readFile(join(temp,req.url.slice(1))));return;}
    res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  }catch(error){errors.push(error);res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url=`http://127.0.0.1:${server.address().port}`;
const adapter=new RemoteBrowser('http://127.0.0.1:1', {isConnected:()=>true,contexts:()=>[courseContext]});
const capture=adapter.frame.bind(adapter);adapter.frame=async(...args)=>{captures++;return capture(...args);};
broker=new RemoteBroker(store.helperId,async input=>{const value=await remoteHelper(store.userId,store.helperId,input,store);if(dropCommand){for(const session of value.sessions)if(session.command){session.command=null;dropCommand=false;dropped++;break;}}return value;},()=>localIdle,()=>{},adapter);
broker.start();
async function client(viewport){
  const context=await browser.newContext({viewport});
  await context.addCookies([{name:'fixtureAccount',value:'owner',url}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error));
  await page.goto(url);return page;
}
async function noOverflow(page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
try{
  await mkdir('test-results/mobile-operations',{recursive:true});
  const desktop=await client({width:1365,height:1000}),mobile=await client({width:390,height:844});
  await desktop.locator('#guided-course-tab').selectOption('course-0');
  const goal='Read the fixture lessons, then ask which topic to open.';
  await desktop.getByLabel(/What would you like to achieve/).fill(goal);
  await expect(mobile.locator('#guided-course-tab')).toHaveValue('course-0');
  await expect(mobile.getByLabel(/What would you like to achieve/)).toHaveValue(goal);
  await mobile.getByLabel(/What would you like to achieve/).fill(goal+' Mobile edit.');
  await expect(desktop.getByLabel(/What would you like to achieve/)).toHaveValue(goal+' Mobile edit.');
  store.paused=true;
  await expect(desktop.getByRole('button',{name:'Resume session',exact:true})).toBeVisible({timeout:6000});
  await expect(mobile.getByRole('button',{name:'Resume session',exact:true})).toBeVisible({timeout:6000});
  await desktop.getByRole('button',{name:'Resume session',exact:true}).click();
  await expect(mobile.getByRole('button',{name:'Resume session',exact:true})).toBeHidden({timeout:6000});
  await noOverflow(mobile);await noOverflow(desktop);
  await mobile.screenshot({path:'test-results/mobile-operations/task-390.png',fullPage:true});
  await desktop.screenshot({path:'test-results/mobile-operations/task-desktop.png',fullPage:true});
  await Promise.allSettled([desktop.getByRole('button',{name:'Inspect and start',exact:true}).click({timeout:3000}),mobile.getByRole('button',{name:'Inspect and start',exact:true}).click({timeout:3000})]);
  await expect(desktop.getByRole('heading',{name:'Vitriol has a question',exact:true})).toBeVisible({timeout:25000});
  await expect(mobile.getByRole('heading',{name:'Vitriol has a question',exact:true})).toBeVisible();
  expect(starts).toEqual(['list-tabs','detect','learn-capture','quiz-learn']);
  await mobile.getByRole('textbox',{name:'Your reply',exact:true}).fill('Read the next topic.');
  await expect(desktop.getByRole('textbox',{name:'Your reply',exact:true})).toHaveValue('Read the next topic.');
  await mobile.getByRole('button',{name:'View Browser',exact:true}).click();
  await expect(desktop.getByRole('button',{name:'Task',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(mobile.getByRole('img',{name:/Live view/})).toBeVisible({timeout:15000});
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeDisabled();
  await expect(mobile.getByRole('combobox',{name:'Browser tab',exact:true})).toBeEnabled();
  await mobile.getByRole('combobox',{name:'Browser tab',exact:true}).selectOption(tabIds[1]);
  await expect(desktop.locator('#guided-course-tab')).toHaveValue('course-1',{timeout:12000});
  await mobile.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>store.remote.size,{timeout:6000}).toBe(0);
  await expect(desktop.getByRole('alert').filter({hasText:/connection|disconnected|unavailable/i})).toHaveCount(0);
  await mobile.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(mobile.getByRole('img',{name:/Live view/})).toBeVisible({timeout:12000});
  await desktop.close(); // Private broker is independent of desktop Operations.
  await expect(mobile.getByRole('combobox',{name:'Browser tab',exact:true})).toBeEnabled();
  await mobile.getByRole('combobox',{name:'Browser tab',exact:true}).selectOption(tabIds[0]);
  await expect.poll(()=>store.draft?.draft.selectedTarget,{timeout:12000}).toBe('course-0');
  localIdle=false;
  await mobile.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(mobile.getByText('Waiting for automation to stop',{exact:true})).toBeVisible();
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeDisabled();
  localIdle=true;
  await expect(mobile.getByText('You have manual control',{exact:true})).toBeVisible({timeout:12000});
  const image=mobile.getByRole('img',{name:/Live view/});
  const box=await image.boundingBox();await image.click({position:{x:box.width*150/1000,y:box.height*100/700}});
  await expect.poll(()=>course.locator('input').evaluate(el=>document.activeElement===el)).toBe(true);
  const secret='fixture-login-never-in-relay-plaintext';
  await mobile.getByRole('textbox',{name:/Type or paste/}).fill(secret);
  await expect(mobile.getByRole('button',{name:'Send text',exact:true})).toBeEnabled({timeout:12000});
  await mobile.getByRole('button',{name:'Send text',exact:true}).click();
  await expect(course.locator('input')).toHaveValue(secret,{timeout:12000});
  await expect(mobile.getByRole('combobox',{name:'Send a key',exact:true})).toBeEnabled({timeout:12000});
  await mobile.getByRole('combobox',{name:'Send a key',exact:true}).selectOption('Enter');
  await expect.poll(()=>course.locator('body').getAttribute('data-enter')).toBe('yes');
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeEnabled({timeout:12000});
  await mobile.getByRole('button',{name:'Scroll down',exact:true}).click();
  await expect.poll(()=>course.evaluate(()=>scrollY)).toBeGreaterThan(0);
  expect(wire.join('')).not.toContain(secret);expect(JSON.stringify([...store.remote.values()])).not.toContain(secret);
  await mobile.screenshot({path:'test-results/mobile-operations/browser-390.png',fullPage:true});
  for(const viewport of [{width:844,height:390},{width:1365,height:1000}]){
    const page=await client(viewport);
    await expect(page.getByLabel(/What would you like to achieve/)).toHaveValue(goal+' Mobile edit.');
    await page.getByRole('button',{name:'View Browser',exact:true}).click();
    await expect(page.getByRole('img',{name:/Live view/})).toBeVisible({timeout:12000});
    await noOverflow(page);
    await page.screenshot({path:`test-results/mobile-operations/browser-${viewport.width}.png`,fullPage:true});
    expect(await page.getByRole('button',{name:'Take control',exact:true}).evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.close();
  }
  await expect(mobile.getByRole('button',{name:'Float preview',exact:true})).toBeEnabled();
  await mobile.getByRole('button',{name:'Float preview',exact:true}).click();
  await expect(mobile.getByRole('button',{name:'Expand browser preview',exact:true})).toBeVisible();
  await expect(mobile.getByRole('button',{name:'Task',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>store.helper.remote_session_id,{timeout:8000}).toBe(null);
  await mobile.getByRole('button',{name:'Expand browser preview',exact:true}).click();
  await expect(mobile.getByRole('button',{name:'Take control',exact:true})).toBeEnabled({timeout:12000});
  await mobile.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(mobile.getByText('You have manual control',{exact:true})).toBeVisible({timeout:12000}).catch(async error=>{console.log('FLOAT DEBUG',await mobile.locator('body').innerText(),JSON.stringify(store.helper));throw error;});
  let releaseOld;const oldResponse=new Promise(done=>{releaseOld=done;});let holdInput=true;
  await mobile.route('**/api/operations/remote',async route=>{
    if(holdInput&&route.request().postDataJSON()?.action==='input'){holdInput=false;const response=await route.fetch();await oldResponse;await route.fulfill({response});}
    else await route.continue();
  });
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeEnabled();
  await mobile.getByRole('button',{name:'Scroll down',exact:true}).click();
  await expect.poll(()=>holdInput).toBe(false);
  await mobile.getByRole('button',{name:'Reconnect',exact:true}).click();
  await expect(mobile.getByText('View only',{exact:true})).toBeVisible({timeout:12000});
  releaseOld();
  await expect(mobile.getByRole('button',{name:'Take control',exact:true})).toBeEnabled({timeout:12000});
  await mobile.unroute('**/api/operations/remote');
  await mobile.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(mobile.getByText('You have manual control',{exact:true})).toBeVisible({timeout:12000});
  dropCommand=true;
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeEnabled();
  await mobile.getByRole('button',{name:'Scroll down',exact:true}).click();
  await expect(mobile.getByRole('alert').filter({hasText:'last action could not be confirmed'})).toBeVisible({timeout:18000});
  expect(dropped).toBe(1);
  await mobile.getByRole('button',{name:'Reconnect',exact:true}).click();
  await expect(mobile.getByText('View only',{exact:true})).toBeVisible({timeout:12000});
  relayOffline=true;
  await expect(mobile.getByRole('alert')).toContainText('Fixture relay disconnected',{timeout:12000});
  await expect(mobile.getByRole('button',{name:'Scroll down',exact:true})).toBeDisabled();
  relayOffline=false;await mobile.getByRole('button',{name:'Reconnect',exact:true}).click();
  await expect(mobile.getByRole('img',{name:/Live view/})).toBeVisible({timeout:12000});
  await expect(mobile.getByText('View only',{exact:true})).toBeVisible();
  await mobile.getByRole('button',{name:'Task',exact:true}).click();
  await expect(mobile.getByLabel(/What would you like to achieve/)).toHaveValue(goal+' Mobile edit.');
  await mobile.getByRole('button',{name:'Close browser preview',exact:true}).click();
  await expect.poll(()=>store.remote.size,{timeout:6000}).toBe(0);
  const atClose=captures;await new Promise(done=>setTimeout(done,2500));expect(captures-atClose).toBeLessThanOrEqual(1);
  const observer=await client({width:1365,height:1000});
  await expect(observer.getByLabel(/What would you like to achieve/)).toHaveValue(goal+' Mobile edit.');
  await mobile.getByRole('button',{name:'New task',exact:true}).click();
  await expect(observer.getByRole('heading',{name:'Vitriol has a question',exact:true})).toHaveCount(0,{timeout:6000});
  await expect(observer.getByLabel(/What would you like to achieve/)).toHaveValue('Read the course material, follow its topics and panels, and retain it for later questions.');
  await observer.close();
  latest=null;
  store.sessionId='33333333-3333-4333-8333-333333333333';
  await expect(mobile.locator('#guided-course-tab')).toHaveValue('');
  await expect(mobile.getByLabel(/What would you like to achieve/)).toHaveValue('Read the course material, follow its topics and panels, and retain it for later questions.');
  await expect(mobile.getByRole('heading',{name:'Vitriol has a question',exact:true})).toHaveCount(0);
  const freshDesktop=await client({width:1365,height:1000});
  await expect(freshDesktop.locator('#guided-course-tab')).toHaveValue('');
  await expect(freshDesktop.getByLabel(/What would you like to achieve/)).toHaveValue('Read the course material, follow its topics and panels, and retain it for later questions.');
  await freshDesktop.close();
  expect(store.draft.draft).toEqual({});
  expect(await course.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:screenX,y:screenY,outerWidth,outerHeight}))).toEqual(geometry);
  expect(errors.filter(error=>!/Another device/.test(error.message))).toEqual([]);
  console.log('PASS two-device drafts/selection/questions/replies, session reset without stale local drafts, exclusive start, portrait/landscape/desktop, independent surfaces, real encrypted helper capture/tap/type/key/scroll/tab, idle gate, reconnect, viewer cleanup and unchanged browser geometry.');
}finally{
  broker?.stop();await browser.close();await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});
}
