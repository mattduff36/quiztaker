import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserChanges,browserInventoryToken} from '../src/browser-changes';
import {chromium} from 'playwright';
import {createServer} from 'node:net';
test('passive inventory token ignores order and non-page targets but detects opening, closing, title and URL changes',()=>{
 const first={targetId:'a',type:'page',url:'https://example.invalid/course',title:'Lesson'};
 const second={targetId:'b',type:'page',url:'https://example.invalid/quiz',title:'Quiz'};
 const token=browserInventoryToken([first,second]);
 assert.equal(browserInventoryToken([second,first,{...first,type:'worker',targetId:'worker'}]),token);
 assert.equal(browserInventoryToken([first,second,{...first,url:'about:blank',targetId:'blank'}]),token);
 for(const changed of [[first],[first,{...second,title:'Results'}],[first,{...second,url:'https://example.invalid/next'}],[first,{...second,targetId:'reopened'}]])assert.notEqual(browserInventoryToken(changed),token);
});
test('passive local browser target events detect navigation without changing window geometry',{timeout:20000},async()=>{
 const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
 const browser=await chromium.launch({headless:true,args:[`--remote-debugging-port=${port}`]});const monitor=new BrowserChanges(port);
 try{
  const page=await browser.newPage();await page.route('https://fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<title>Fixture lesson</title><h1>Lesson</h1>'}));
  await monitor.connect();
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+5000;while(!predicate()&&Date.now()<until)await new Promise(r=>setTimeout(r,30));assert.ok(predicate());};
  await page.goto('https://fixture.invalid/one');await wait(()=>monitor.token!=='offline');await new Promise(r=>setTimeout(r,100));
  const before=monitor.token,geometry=await page.evaluate(()=>[innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio]);
  await page.goto('https://fixture.invalid/two');await wait(()=>monitor.token!==before);
  assert.deepEqual(await page.evaluate(()=>[innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio]),geometry);
 }finally{monitor.close();await browser.close();}
});
