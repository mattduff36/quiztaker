const test = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {readSnapshot,applyAction,localActionAllowed} = require('./pw-learn-quiz');
const {watchCoursePopup,authorizedCoursePopup} = require('./lib/course-popup');
const {classifyUrl} = require('./lib/page-probe');

const course = 'https://canon-europe.csod.com/content/canon-europe/publications/1194/lib_en/templates/master.htm';
const markup = `<h1>Review the lesson</h1>
  <fieldset><legend>Which device?</legend><label><input type=radio name=device value=one>Device one</label>
  <label><input type=radio name=device value=two>Device two</label></fieldset>
  <fieldset><legend>Which mode?</legend><label><input type=radio name=mode value=fast>Fast mode</label>
  <label><input type=radio name=mode value=slow>Slow mode</label></fieldset>
  <label><input type=checkbox>Duplex</label><label>Explain the choice <textarea></textarea></label>
  <button onclick="window.submitted=true">Submit</button><button onclick="window.advanced=true">Next</button>`;

test('grouped answers preflight every target, set idempotently and verify without navigation',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:markup}));
    await page.goto(course);
    let view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.fields.length,1);
    const action={action:'answer-group',pageId:view.snapshot.answerPageId,answers:[
      ...['Device two','Fast mode','Duplex'].map(name=>({targetId:view.snapshot.choices.find(item=>item.name===name).id,checked:true})),
      {targetId:view.snapshot.fields[0].id,text:'From the retained lesson.'},
    ]};
    assert.equal(localActionAllowed(action,view.snapshot,'read'),false);
    const disabled=page.getByLabel('Fast mode');await disabled.evaluate(el=>el.disabled=true);
    await assert.rejects(applyAction(page,action,view.snapshot,view.handles,'quiz'),/changed|unavailable|editable/i);
    assert.equal(await page.getByLabel('Device two').isChecked(),false,'preflight must finish before the first mutation');
    await disabled.evaluate(el=>el.disabled=false);
    view=await readSnapshot(page,'quiz');
    action.pageId=view.snapshot.answerPageId;
    await applyAction(page,action,view.snapshot,view.handles,'quiz');
    view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.fields[0].value,'From the retained lesson.');
    assert.match(view.snapshot.text,/verified 4 answers/i);
    assert.equal(await page.getByLabel('Device two').isChecked(),true);
    assert.equal(await page.getByLabel('Fast mode').isChecked(),true);
    assert.equal(await page.getByLabel('Duplex').isChecked(),true);
    assert.equal(await page.evaluate(()=>Boolean(window.submitted||window.advanced)),false);
    await applyAction(page,action,view.snapshot,view.handles,'quiz');
    assert.equal(await page.getByLabel('Duplex').isChecked(),true,'replay sets, never toggles');
    view=await readSnapshot(page,'quiz');
    const off={action:'answer-group',pageId:view.snapshot.answerPageId,answers:[{targetId:action.answers[2].targetId,checked:false}]};
    await applyAction(page,off,view.snapshot,view.handles,'quiz');
    assert.equal(await page.getByLabel('Duplex').isChecked(),false);
    view=await readSnapshot(page,'quiz');
    await page.getByLabel('Device two').evaluate(el=>el.value='different-option');
    await assert.rejects(applyAction(page,{...action,pageId:view.snapshot.answerPageId},view.snapshot,view.handles,'quiz'),/changed/i);
    await page.goto(course);
    view=await readSnapshot(page,'quiz');
    const first=view.snapshot.choices.find(item=>item.name==='Device two');
    const second=view.snapshot.choices.find(item=>item.name==='Fast mode');
    await page.getByLabel('Device two').evaluate(el=>el.onchange=()=>{document.querySelector('legend').textContent='A different question';});
    await assert.rejects(applyAction(page,{action:'answer-group',pageId:view.snapshot.answerPageId,answers:[
      {targetId:first.id,checked:true},{targetId:second.id,checked:true},
    ]},view.snapshot,view.handles,'quiz'),/changed/i);
    assert.equal(await page.getByLabel('Fast mode').isChecked(),false,'changed question stops the remaining answers');
  } finally {await browser.close();}
});

test('Brightwave hit-tested graphic hotspots and topic Start exclude hidden and full-slide wrong-action overlays',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<style>
      .screenElement,.menuStartBtn{position:absolute;width:120px;height:40px}
      .invisibutton{width:100%;height:100%;opacity:0}
      #wrongAction{width:100vw;height:100vh;left:0;top:0}
      #actual_hotspot{left:10px;top:100px;background:blue;z-index:2}
      #menuscreen_panel_2{position:absolute;left:200px;top:100px}
      </style><div class="screenElement box" id="wrongAction"><button class="invisibutton"></button></div>
      <div class="screenElement box" id="actual_hotspot"><button class="invisibutton" onclick="window.hit=true"></button></div>
      <div style="opacity:0"><div class="screenElement box" id="hidden_hotspot"><button class="invisibutton"></button></div></div>
      <div id="menuscreen_panel_2"><p class="menuTopicButtonClosed">Firmware</p><div class="menuStartBtn"><button class="invisibutton"></button></div></div>`);
    const view=await readSnapshot(page,'read'), names=view.snapshot.buttons.map(item=>item.name);
    assert.ok(names.includes('Course hotspot: actual_hotspot'));
    assert.ok(names.includes('Open topic: Firmware - Start'));
    assert.ok(!names.some(name=>/wrongAction|hidden_hotspot/.test(name)));
    const target=view.snapshot.buttons.find(item=>item.name==='Course hotspot: actual_hotspot');
    await applyAction(page,{action:'click',targetId:target.id},view.snapshot,view.handles,'read');
    assert.equal(await page.evaluate(()=>window.hit),true);
  } finally {await browser.close();}
});

test('reused named course popups follow the exact opener, not unchanged or unrelated pages',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Offline course</h1>'}));
    const launcher=await context.newPage();await launcher.goto('https://canon-europe.csod.com/LMS/learning.aspx');
    const created=launcher.waitForEvent('popup');
    await launcher.evaluate(url=>window.open(url,'CanonLesson'),course);
    const child=await created;await child.waitForLoadState();
    const unrelated=await context.newPage();await unrelated.goto(course);
    let watcher=await watchCoursePopup(launcher);
    await unrelated.goto(course.replace('/1194/','/1195/'));
    assert.equal(await watcher.resolve(100),null);
    watcher=await watchCoursePopup(launcher);
    assert.equal(await watcher.resolve(100),null,'unchanged child is not a launch');
    watcher=await watchCoursePopup(launcher);
    await launcher.evaluate(url=>window.open(url,'CanonLesson'),course.replace('/1194/','/1196/'));
    assert.equal(await watcher.resolve(),child);
    watcher=await watchCoursePopup(child);
    await launcher.goto('https://canon-europe.csod.com/LMS/learning.aspx?return=1');
    assert.equal(await watcher.resolve(100),null,'the inner course must not rebound to the launcher');
    assert.equal(authorizedCoursePopup(launcher.url(),'https://external.invalid/index.htm'),false);
    assert.equal(authorizedCoursePopup(launcher.url(),'https://canon-europe.csod.com/login.aspx'),false);
  } finally {await browser.close();}
});

test('embedded SIMS source login screens remain lesson content; real auth is user-only',()=>{
  assert.equal(classifyUrl(course.replace('master.htm','SIMS-login.htm')),'csod-learning');
  assert.equal(classifyUrl('https://canon-europe.csod.com/login.aspx'),'session-dead');
  assert.equal(classifyUrl('https://canon-europe.csod.com/oauth/authorize'),'session-dead');
  assert.equal(classifyUrl('https://login3.id.hp.com/login'),'session-dead');
});

test('only publication-scoped graphical SIMS login is offered as a simulation interaction',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>SIMS simulation</h1>
      <div class="screenElement box" id="sim_login"><button class="invisibutton" aria-label="Log in">Log in</button></div>`}));
    await page.goto(course);
    let view=await readSnapshot(page,'read');
    assert.ok(view.snapshot.buttons.some(item=>item.name==='Course simulation: SIMS example entry'));
    await page.goto('https://canon-europe.csod.com/login.aspx');
    view=await readSnapshot(page,'read');
    assert.ok(!view.snapshot.buttons.some(item=>/login|log in|simulation/i.test(item.name)));
  } finally {await browser.close();}
});
