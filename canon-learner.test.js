const test = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {readSnapshot,applyAction,localActionAllowed,revalidateLearnerDecision} = require('./pw-learn-quiz');
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

test('long Canon forms keep answer/control identity across preflight scrolling and the 40-choice viewport budget',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:650}});
    const form=Array.from({length:14},(_,i)=>`<fieldset style="height:210px"><legend>Question ${i+1} of 14: Device ${i+1}?</legend>
      ${['A','B','C','D'].map(letter=>`<label style="display:block"><input type=radio name="q${i}" value="${letter}">Device ${i+1} ${letter}</label>`).join('')}</fieldset>`).join('');
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Canon fixture</h1><p>Time remaining</p><p id=timer>20:00</p>
      <form>${form}<button onclick="window.submitted=true">Submit</button></form>`}));
    await page.goto(course);
    const view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.choices.length,40);
    const picks=['Device 1 B','Device 10 C'].map(name=>({targetId:view.snapshot.choices.find(item=>item.name===name).id,checked:true}));
    const action={action:'answer-group',pageId:view.snapshot.answerPageId,answers:picks};
    await page.locator('#timer').evaluate(el=>el.textContent='19:59');
    await page.evaluate(()=>scrollTo(0,2000));
    const scrolled=await readSnapshot(page,'quiz');
    const revalidated=revalidateLearnerDecision(view.snapshot,scrolled.snapshot,action);
    assert.equal(revalidated.ok,true,'scroll/countdown changes retain the original offered targets');
    await applyAction(page,action,revalidated.snapshot,scrolled.handles,'quiz');
    assert.ok(await page.evaluate(()=>scrollY)>1000,'preflight/selection really scrolled');
    const post=await readSnapshot(page,'quiz');
    assert.notDeepEqual(post.snapshot.choices.map(c=>c.id),view.snapshot.choices.map(c=>c.id),'viewport-first exposure reordered');
    assert.equal(post.snapshot.answerPageId,view.snapshot.answerPageId);
    assert.equal(await page.getByLabel('Device 1 B',{exact:true}).isChecked(),true);
    assert.equal(await page.getByLabel('Device 10 C',{exact:true}).isChecked(),true);
    assert.equal(await page.evaluate(()=>Boolean(window.submitted)),false);
    assert.equal(revalidateLearnerDecision(view.snapshot,post.snapshot,action).ok,false,'external selection changes still invalidate a pending decision');
    await page.locator('button').evaluate(el=>el.setAttribute('onclick','window.changedNavigation=true'));
    await assert.rejects(applyAction(page,{action:'answer-group',pageId:post.snapshot.answerPageId,answers:[
      {targetId:post.snapshot.choices[0].id,checked:true},
    ]},post.snapshot,post.handles,'quiz'),/changed/i);
  } finally {await browser.close();}
});

test('grouped-answer identity rejects changed options, question text, navigation and replaced documents',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<form action="/submit">${markup}</form>`}));
    await page.goto(course);
    for(const change of [
      ()=>page.locator('legend').first().evaluate(el=>el.textContent='Changed question'),
      ()=>page.getByLabel('Device two').evaluate(el=>el.value='changed'),
      ()=>page.getByLabel('Device two').evaluate(el=>el.parentElement.lastChild.textContent='Changed option'),
      ()=>page.locator('fieldset').first().evaluate(el=>el.insertAdjacentHTML('beforeend','<label><input type=radio name=device>New option</label>')),
      ()=>page.locator('button').first().evaluate(el=>el.setAttribute('formaction','/different-submit')),
      ()=>page.locator('form').evaluate(el=>el.action='/different-submit'),
      ()=>page.reload(),
    ]) {
      const before=await readSnapshot(page,'quiz');
      const action={action:'answer-group',pageId:before.snapshot.answerPageId,answers:[{targetId:before.snapshot.choices[0].id,checked:true}]};
      await change();
      const after=await readSnapshot(page,'quiz');
      assert.equal(revalidateLearnerDecision(before.snapshot,after.snapshot,action).ok,false);
      await assert.rejects(applyAction(page,action,before.snapshot,before.handles,'quiz'),/changed/);
      assert.equal(await page.getByLabel('Device one').isChecked(),false);
      await page.goto(course);
    }
  } finally {await browser.close();}
});

test('learner process re-inspects a partial grouped answer and preserves the attempt instead of failing fatally',async()=>{
  const net=require('node:net'),{spawn}=require('node:child_process');
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:[`--remote-debugging-port=${port}`]});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:markup}));
    await page.goto(course);
    await page.getByLabel('Device two').evaluate(el=>el.onchange=()=>{document.querySelector('legend').textContent='A revised device prompt';});
    const snapshots=[];
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['pw-learn-quiz.js','0'],{
        cwd:__dirname,env:{...process.env,VITRIOL_LEARNER_MODE:'quiz',VITRIOL_LEARNER_INTENT:'',VITRIOL_CDP_TARGET_ID:'',VITRIOL_CAPTURE_TARGET:'',PLAYWRIGHT_CDP_URL:`http://127.0.0.1:${port}`},
        stdio:['pipe','pipe','pipe'],
      });
      let output='',error='',pending='';
      const timer=setTimeout(()=>{child.kill();reject(new Error('Grouped-answer recovery did not return a fresh snapshot'));},25000);
      child.stdout.on('data',chunk=>{
        output+=chunk;pending+=chunk;
        const lines=pending.split('\n');pending=lines.pop();
        for(const line of lines)if(line.startsWith('LEARNER_SNAPSHOT ')) {
          const snapshot=JSON.parse(line.slice('LEARNER_SNAPSHOT '.length));snapshots.push(snapshot);
          const action=snapshots.length===1 ? {action:'answer-group',pageId:snapshot.answerPageId,answers:
            ['Device two','Fast mode'].map(name=>({targetId:snapshot.choices.find(item=>item.name===name).id,checked:true}))}
            : {action:'ask-user',question:'Review the preserved attempt.',options:['Resume']};
          child.stdin.write(`LEARNER_ACTION ${JSON.stringify(action)}\n`);
        }
      });
      child.stderr.on('data',chunk=>error+=chunk);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);resolve({code,output,error});});
    });
    assert.equal(result.code,1,result.error);
    assert.equal(snapshots.length,2);
    assert.match(result.output,/Grouped answers interrupted; preserving the current attempt and inspecting again/);
    assert.match(result.output,/^LEARNER_QUESTION /m);
    assert.equal(snapshots[1].choices.find(item=>item.name==='Device two').checked,true);
    assert.equal(snapshots[1].choices.find(item=>item.name==='Fast mode').checked,false);
    assert.equal(await page.getByLabel('Device two').isChecked(),true);
    assert.equal(await page.evaluate(()=>Boolean(window.submitted||window.advanced)),false);
  } finally {await browser.close();}
});

test('native radio grouping follows form/name, even across separate fieldsets; repeated prompts are distinct controls',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.setContent(`<form>
      <fieldset><legend>Same prompt</legend><label><input type=radio name=shared>Yes</label></fieldset>
      <fieldset><legend>Same prompt</legend><label><input type=radio name=shared>No</label></fieldset>
      <fieldset><legend>Same prompt</legend><label><input type=radio name=other>Yes</label></fieldset></form>`);
    const view=await readSnapshot(page,'quiz'),[a,b,c]=view.snapshot.choices;
    assert.equal(a.groupId,b.groupId);assert.notEqual(a.groupId,c.groupId);assert.notEqual(a.id,c.id);
    assert.equal(localActionAllowed({action:'answer-group',pageId:view.snapshot.answerPageId,answers:[
      {targetId:a.id,checked:true},{targetId:b.id,checked:true},
    ]},view.snapshot,'quiz'),false);
  } finally {await browser.close();}
});

test('grouped custom checkboxes preserve click and Rise keyboard selection behavior',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    for(const rise of [false,true]) {
      await page.setContent(`<div ${rise?'class="quiz-card quiz-card--active"':''}>
        <div role=checkbox tabindex=0 aria-checked=false ${rise
          ?'onkeydown="if(event.key===\' \')this.setAttribute(\'aria-checked\',String(this.getAttribute(\'aria-checked\')!==\'true\'))"'
          :'onclick="this.setAttribute(\'aria-checked\',String(this.getAttribute(\'aria-checked\')!==\'true\'))"'}>Duplex</div></div>`);
      for(const checked of [true,false]) {
        const view=await readSnapshot(page,'quiz');
        await applyAction(page,{action:'answer-group',pageId:view.snapshot.answerPageId,answers:[{targetId:view.snapshot.choices[0].id,checked}]},
          view.snapshot,view.handles,'quiz');
        assert.equal(await page.getByRole('checkbox').getAttribute('aria-checked'),String(checked));
      }
    }
  } finally {await browser.close();}
});

test('Waveform exit confirmation and graphical topics expose real hit-tested overlay buttons, never text underlays',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<style>
      .hit{position:relative;width:180px;height:55px;margin:15px}.invisibutton{position:absolute;inset:0;width:100%;height:100%;opacity:0}
      </style><h1>Waveform</h1><div id=navBtn_exit class=hit><p>Exit</p><button class=invisibutton onclick="window.exited=true"></button></div>
      <div id=exit_yesBtn class=hit><div class=btn><p>Yes</p></div><button class=invisibutton onclick="window.confirmed=true"></button></div>
      <div id=exit_noBtn class=hit><div class=btn><p>No</p></div><button class=invisibutton></button></div>
      <div id=menuscreen_panel_1 class=hit><p class="selected menuTopicButtonOpen">Networks</p><button class=invisibutton></button></div>`}));
    await page.goto(course.replace('templates/master.htm','html/course.htm'));
    const view=await readSnapshot(page,'read');
    for(const name of ['Course player: Exit','Course player: Confirm exit','Course player: Cancel exit','Open topic: Networks']) {
      const target=view.snapshot.buttons.find(item=>item.name===name);
      assert.ok(target,name);assert.equal(await view.handles.get(target.id).evaluate(el=>el.matches('button.invisibutton')),true);
      assert.equal(localActionAllowed({action:'click',targetId:target.id},view.snapshot,'read'),true);
    }
    const yes=view.snapshot.buttons.find(item=>item.name==='Course player: Confirm exit');
    await applyAction(page,{action:'click',targetId:yes.id},view.snapshot,view.handles,'read');
    assert.equal(await page.evaluate(()=>window.confirmed),true);
    await page.goto('https://canon-europe.csod.com/login.aspx');
    assert.ok(!(await readSnapshot(page,'read')).snapshot.buttons.some(item=>item.name.startsWith('Course player:')));
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
