'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {listBrowserTabs,selectBrowserPage}=require('./lib/browser-tabs');
const {choosePage}=require('./lib/detection-engine');

test('live tab identity survives identical title/URL, navigation, and numeric reorder; closed targets fail',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const previous=process.env.VITRIOL_CDP_TARGET_ID;
  try {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<title>Curriculum</title><p>Fixture</p>'}));
    const a=await context.newPage(),b=await context.newPage();
    const url='https://example.com/curriculum';
    await a.goto(url);await b.goto(url);
    const first=await listBrowserTabs(browser),id=first[1].cdpTargetId;
    assert.notEqual(first[0].cdpTargetId,id);
    process.env.VITRIOL_CDP_TARGET_ID=id;
    const inspected=await choosePage(context,0);
    assert.equal(inspected.page,b);assert.equal(inspected.reason,'explicit-live-target');
    assert.equal(await selectBrowserPage([b,a],0,id),b);
    await b.goto('https://example.com/loading?course=second');
    assert.equal((await listBrowserTabs(browser))[1].cdpTargetId,id);
    assert.equal(await selectBrowserPage([a,b],0,id),b);
    await b.close();
    const replacement=await context.newPage();await replacement.goto(url);
    await assert.rejects(selectBrowserPage([a,replacement],1,id),/closed or missing/);
    await assert.rejects(choosePage(context,1),/closed or missing/);
  } finally {
    if(previous===undefined)delete process.env.VITRIOL_CDP_TARGET_ID;else process.env.VITRIOL_CDP_TARGET_ID=previous;
    await browser.close();
  }
});
