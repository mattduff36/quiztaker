import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createRemoteKeys,deriveRemoteKey,sealRemote,openRemote,type RemoteAction,type RemoteInput} from '@quiztaker/core/remote';
import {RemoteBrowser} from '../src/remote-browser.js';
test('encrypted isolated helper-browser roundtrip uses existing tabs with stable geometry; replay/stale/wrong tab rejected',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:980,height:720}});
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<title>Course fixture</title><input aria-label="Login fixture"><button onclick="document.title='Tapped'">Tap fixture</button><main style="height:3000px">Scroll fixture</main>`}));
    const page=await context.newPage();await page.goto('https://course.invalid/lesson');
    const other=await context.newPage();await other.goto('https://course.invalid/other');
    const adapter=new RemoteBrowser('http://127.0.0.1:1',browser);
    const before=await page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,outerW:outerWidth,outerH:outerHeight}));
    const keysA=await createRemoteKeys(),keysB=await createRemoteKeys();
    const a=await deriveRemoteKey(keysA.privateKey,keysB.publicKey),b=await deriveRemoteKey(keysB.privateKey,keysA.publicKey);
    const scope={helperId:'isolated',sessionId:'fixture',clientId:'mobile'};
    let seq=0;
    async function send(action:RemoteAction){
      const frame=await adapter.frame(true);
      const encrypted=await sealRemote(a,scope,'input',++seq,{...action,frameId:frame.frameId,tabId:frame.tabId,geometry:frame.geometry});
      const command=await openRemote<RemoteInput>(b,scope,'input',encrypted,seq-1);
      await adapter.input(command,()=>true);
      await assert.rejects(adapter.input(command,()=>true),/stale/);
    }
    const frame=await adapter.frame(false);
    const encryptedFrame=await sealRemote(b,scope,'frame',1,frame);
    assert.deepEqual(await openRemote(a,scope,'frame',encryptedFrame,0),frame);
    assert.ok(frame.jpeg.length>100);assert.equal(frame.tabs.length,2);
    const inputBox=await page.locator('input').boundingBox();assert.ok(inputBox);
    await send({type:'tap',x:inputBox.x+10,y:inputBox.y+10});
    await send({type:'type',text:'not-a-real-password'});
    assert.equal(await page.locator('input').inputValue(),'not-a-real-password');
    await send({type:'key',key:'Control+A'});await send({type:'type',text:'replacement'});
    assert.equal(await page.locator('input').inputValue(),'replacement');
    const button=await page.locator('button').boundingBox();assert.ok(button);
    await send({type:'tap',x:button.x+10,y:button.y+10});assert.equal(await page.title(),'Tapped');
    await send({type:'scroll',x:0,y:400});await page.waitForFunction(()=>scrollY>0);
    await page.goto('https://course.invalid/next');
    await send({type:'back'});assert.equal(page.url(),'https://course.invalid/lesson');
    await send({type:'forward'});assert.equal(page.url(),'https://course.invalid/next');
    await page.evaluate(()=>{(window as unknown as {reloadMarker:boolean}).reloadMarker=true;});
    await send({type:'reload'});assert.equal(await page.evaluate(()=>Boolean((window as unknown as {reloadMarker?:boolean}).reloadMarker)),false);
    const stale=await adapter.frame(true);
    await page.evaluate(()=>scrollTo(0,800));
    await assert.rejects(adapter.input({...stale,type:'key',key:'Enter',geometry:stale.geometry,tabId:stale.tabId},()=>true),/geometry changed/);
    const fresh=await adapter.frame(true);
    await assert.rejects(adapter.input({type:'key',key:'Enter',frameId:fresh.frameId,tabId:'wrong',geometry:fresh.geometry},()=>true),/stale/);
    await assert.rejects(adapter.input({type:'key',key:'Enter',frameId:fresh.frameId,tabId:fresh.tabId,geometry:fresh.geometry},()=>false),/expired/);
    await send({type:'select-tab',targetId:frame.tabs[1]!.id});
    const selected=await adapter.frame(true);assert.equal(selected.tabId,frame.tabs[1]!.id);
    await assert.rejects(adapter.input({type:'type',text:'blocked',frameId:selected.frameId,tabId:selected.tabId,geometry:selected.geometry},()=>true,true),/view-only/i);
    await adapter.input({type:'select-tab',targetId:frame.tabs[0]!.id,frameId:selected.frameId,tabId:selected.tabId,geometry:selected.geometry},()=>true,true);
    assert.equal((await adapter.frame(false)).tabId,frame.tabs[0]!.id,'view-only selection never requires automation input control');
    const geometry=await page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,outerW:outerWidth,outerH:outerHeight}));
    assert.deepEqual(geometry,before,'capture and input do not resize, emulate, zoom or change existing windows');
    adapter.clear();assert.equal(browser.isConnected(),true);assert.equal(context.pages().length,2);
  }finally{await browser.close();}
});

test('manual launch follows the new player tab and scrolling reaches a nested content pane without resizing',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:980,height:720}});
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/player')
      ? '<title>Player</title><main id="pane" style="position:fixed;inset:0;overflow:auto"><div style="height:3000px">Lesson</div></main>'
      : '<title>Launch</title><button onclick="window.open(\'/player\',\'player\',\'popup,width=300,height=200\')">Continue</button>'}));
    const page=await context.newPage();await page.goto('https://course.invalid/launch');
    const adapter=new RemoteBrowser('http://127.0.0.1:1',browser);
    const first=await adapter.frame(true),box=await page.locator('button').boundingBox();assert.ok(box);
    await adapter.input({type:'tap',frameId:first.frameId,tabId:first.tabId,geometry:first.geometry,x:box.x+5,y:box.y+5},()=>true);
    let playerFrame=await adapter.frame(true);
    for(let n=0;n<20&&playerFrame.tabId===first.tabId;n++){await new Promise(resolve=>setTimeout(resolve,25));playerFrame=await adapter.frame(true);}
    assert.notEqual(playerFrame.tabId,first.tabId,'remote view follows the actual child tab');
    const child=context.pages().find(p=>p!==page)!;await child.waitForURL('**/player');
    playerFrame=await adapter.frame(true);
    await adapter.input({type:'scroll',frameId:playerFrame.frameId,tabId:playerFrame.tabId,geometry:playerFrame.geometry,x:0,y:400},()=>true);
    await child.waitForFunction(()=>document.querySelector('#pane')!.scrollTop>0);
    const back=await adapter.frame(true);
    await adapter.input({type:'select-tab',targetId:first.tabId,frameId:back.frameId,tabId:back.tabId,geometry:back.geometry},()=>true);
    assert.equal((await adapter.frame(true)).tabId,first.tabId);
    assert.deepEqual(await page.evaluate(()=>({width:innerWidth,height:innerHeight})),{width:980,height:720});
  }finally{await browser.close();}
});
