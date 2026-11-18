'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {captureStableViewport}=require('./lib/stable-viewport-capture');
const {startRecorder}=require('./pw-quick-scrape');

test('headed real Chrome at 80% browser zoom: 5fps plus native captures do not resize content and masks align',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'vitriol-zoom-fixture-'));
  fs.mkdirSync(path.join(home,'profile','Default'),{recursive:true});
  fs.writeFileSync(path.join(home,'profile','Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(0.8)/Math.log(1.2)}}}));
  const context=await chromium.launchPersistentContext(path.join(home,'profile'),{channel:'chrome',headless:false,viewport:null,
    args:['--window-size=1000,800','--force-device-scale-factor=1']});
  t.after(async()=>{await context.close();fs.rmSync(home,{recursive:true,force:true});});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><title>Offline zoom fixture</title>
    <style>body{margin:0}#art{width:70vw;height:40vh;background:blue}input{position:fixed;top:200px;left:100px;width:250px;height:40px}</style>
    <h1>Authored lesson fixture</h1><div id="art"></div><input value="PRIVATE_FIXTURE">
    <script>window.sizes=[];function sample(){let r=document.querySelector('#art').getBoundingClientRect();
    sizes.push([innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,visualViewport.scale,r.width,r.height]);requestAnimationFrame(sample)}sample();</script>`}));
  const page=await context.newPage();await page.goto('https://canon-europe.csod.com/content/zoom-fixture.html');
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
  assert.ok(Math.abs(viewport.dpr-0.8)<0.01,`actual browser zoom must be 80%; DPR=${viewport.dpr}`);
  const commands=[],createSession=context.newCDPSession.bind(context);
  context.newCDPSession=async target=>{
    const session=await createSession(target),send=session.send.bind(session);
    session.send=async(method,params)=>{commands.push(method);return send(method,params);};
    return session;
  };
  const native=await context.newCDPSession(page);
  const recorder=await startRecorder(page,{home,limits:{visualMs:200,pollMs:50}});
  try {
    const box=await page.locator('input').boundingBox();
    for(let index=0;index<12;index++){
      await captureStableViewport(page,viewport,'png');
      await native.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
      await page.waitForTimeout(200);
    }
    recorder.stop('finish');const result=await recorder.done;
    assert.equal(result.error,null);assert.ok(result.frames>=1);
    const samples=await page.evaluate(()=>sizes);
    assert.ok(samples.length>20);
    assert.equal(new Set(samples.map(sample=>JSON.stringify(sample))).size,1,'viewport/DPR/layout changed during captures');
    const screenshot=fs.readdirSync(recorder.folder).find(file=>file.endsWith('.jpg'));
    const pixel=await require('sharp')(path.join(recorder.folder,screenshot))
      .extract({left:Math.floor(box.x+box.width/2),top:Math.floor(box.y+box.height/2),width:1,height:1}).raw().toBuffer();
    assert.ok([...pixel].every(channel=>channel>=28&&channel<=38),'offline privacy mask must cover input at 80% zoom');
    assert.ok(commands.every(command=>command==='Page.captureScreenshot'));
    assert.ok(commands.length>=34,`5fps recording must capture repeatedly alongside the 24 explicit captures; saw ${commands.length}`);
    t.diagnostic(`Real browser zoom 80%; ${samples.length} stable animation-frame geometry samples; ${commands.length} captures including 24 explicit captures; privacy mask pixel ${[...pixel]}.`);
  } finally {recorder.stop('finish');await recorder.done;await native.detach();}
});
