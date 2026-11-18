'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {protectSabaPopups}=require('./lib/course-launch');
async function windowId(context,page) {
  const session=await context.newCDPSession(page);
  try{return (await session.send('Browser.getWindowForTarget')).windowId;}
  finally{await session.detach();}
}
test('selected HTTPS course launches keep real Chrome window IDs, proxies, names, frames and scope',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>{
      const path=new URL(route.request().url()).pathname;
      const pages={
        '/course':`<a id="ordinary" href="https://external-player.invalid/player" target="_blank">Lesson</a>
          <button id="continue" onclick="location.href='/proceed'">Continue</button>
          <iframe name="lessonFrame" src="/frame"></iframe>
          <button id="frameLink" onclick="window.open('/inside','lessonFrame','width=300,height=200')">In frame</button>`,
        '/proceed':`<button id="proceed" onclick="window.player=window.open('https://external-player.invalid/player','coursePlayer','width=400,height=300');window.proxyOkay=!!player&&player.opener===window">Proceed</button>`,
        '/player':`<p>External player</p><button id="nested" onclick="window.open('https://sso.invalid/login','sso','width=500,height=300')">Sign in</button>`,
        '/immediate':`<script>window.open('https://sso.invalid/inline','inlineSSO','popup,width=400,height=300')</script><p>Inline course child</p>`,
        '/frame':`<button id="launch" onclick="window.open('https://external-player.invalid/frame-player','framePlayer','width=450,height=350')">Launch module</button>`,
      };
      return route.fulfill({contentType:'text/html',body:pages[path]||'<p>Fixture content</p>'});
    });
    const page=await context.newPage();await page.goto('https://course.invalid/course');
    const original=await windowId(context,page);
    const legacyPromise=context.waitForEvent('page');
    await page.evaluate(()=>window.open('https://external-player.invalid/legacy','coursePlayer','popup,width=350,height=250'));
    const legacy=await legacyPromise;await legacy.waitForLoadState();
    assert.notEqual(await windowId(context,legacy),original,'fixture begins with an older separate named popup');
    await protectSabaPopups(page);
    const ordinaryPromise=context.waitForEvent('page');
    await page.locator('#ordinary').click();const ordinary=await ordinaryPromise;await ordinary.waitForLoadState();
    assert.equal(await windowId(context,ordinary),original,'ordinary external course links stay in the course window');
    await ordinary.close();
    const count=context.pages().length;
    await page.locator('#frameLink').click();
    await page.frame({name:'lessonFrame'}).waitForURL('**/inside');
    assert.equal(context.pages().length,count,'named iframe navigation does not become a new tab');
    await page.goto('https://course.invalid/course');
    const nestedPromise=context.waitForEvent('page');
    await page.frameLocator('iframe').locator('#launch').click();
    const framePlayer=await nestedPromise;await framePlayer.waitForLoadState();
    assert.equal(await windowId(context,framePlayer),original,'nested course frame popup shares the existing window');
    await page.locator('#continue').click();await page.waitForURL('**/proceed');
    const popupPromise=context.waitForEvent('page');
    await page.locator('#proceed').click();const player=await popupPromise;await player.waitForLoadState();
    assert.equal(await windowId(context,player),original,'JS Proceed with sizing features opens a tab');
    assert.match(legacy.url(),/\/legacy$/,'an old named popup is not reused or moved');
    assert.equal(await page.evaluate(()=>window.proxyOkay),true,'original useful WindowProxy/opener is preserved');
    const existing=context.pages().length;
    await page.locator('#proceed').click();await player.waitForLoadState();
    assert.equal(context.pages().length,existing,'named launch reuses the existing child');
    assert.equal(await page.evaluate(()=>window.player.closed),false);
    const ssoPromise=context.waitForEvent('page');
    await player.locator('#nested').click();const sso=await ssoPromise;await sso.waitForLoadState();
    assert.equal(await windowId(context,sso),original,'actual external course child inherits protection');
    const immediate=await page.evaluate(()=>Boolean(window.open('https://external-player.invalid/immediate','immediateChild','popup,width=400,height=300')));
    assert.equal(immediate,true);
    for(let attempt=0;attempt<100&&!context.pages().some(tab=>tab.url()==='https://sso.invalid/inline');attempt++)await new Promise(resolve=>setTimeout(resolve,25));
    const inline=context.pages().find(tab=>tab.url()==='https://sso.invalid/inline');
    assert.ok(inline,'inline child script opens its SSO page');
    await inline.waitForLoadState();
    assert.equal(await windowId(context,inline),original,'immediate inline external grandchild also shares the course window');
    const unrelated=await context.newPage();await unrelated.goto('https://unrelated.invalid/course');
    assert.equal(await unrelated.evaluate(()=>Boolean(window.__vitriolCourseOpen)),false);
    const unprotectedPromise=context.waitForEvent('page');
    await unrelated.evaluate(()=>window.open('https://external-player.invalid/player','unrelatedPopup','popup,width=350,height=250'));
    const unprotected=await unprotectedPromise;await unprotected.waitForLoadState();
    assert.notEqual(await windowId(context,unprotected),await windowId(context,unrelated),'unrelated tabs are not normalized');
    await page.evaluate(()=>window.open('/self','_self','width=300,height=200'));await page.waitForURL('**/self');
    assert.equal(await windowId(context,page),original,'_self remains in its original tab');
  }finally{await browser.close();}
});
