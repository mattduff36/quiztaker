const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readSnapshot, applyAction, localActionAllowed, pageShowsPass, sameLearnerView } = require('./pw-learn-quiz');

async function act(page, name, mode = 'read', choice = false, retryState) {
  const view = await readSnapshot(page, mode);
  const target = (choice ? view.snapshot.choices : view.snapshot.buttons).find(control => control.name === name);
  assert.ok(target, `Observed control: ${name}`);
  const action = { action: choice ? 'answer-select' : 'click', targetId: target.id };
  assert.equal(localActionAllowed(action, view.snapshot, mode), true);
  await applyAction(page, action, view.snapshot, view.handles, mode, retryState);
  return view;
}

test('real browser reads nested course cards, collapse panels, icon modals and later long-page material', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    const inner = `<style>body{margin:0}#panel,#modal{display:none}</style><h1>Paper course</h1>
      <a href="#panel" onclick="document.querySelector('#panel').style.display='block'">GET THE STORY: TYPES OF PAPER</a>
      <a href="#panel" data-toggle="collapse" onclick="document.querySelector('#panel').style.display='block'">Getting the right paper</a>
      <div id="panel">Retained paper fact from an opened panel.</div>
      <button title="Paper quality" onclick="document.querySelector('#modal').style.display='block'"><img alt="Paper quality"></button>
      <div id="modal" role="dialog">Modal material about grain.<button onclick="this.parentElement.style.display='none'">Close</button></div>
      <a href="/logout">Log out</a>`;
    await page.setContent('<iframe style="width:950px;height:600px"></iframe>');
    const outer = page.frames()[1];
    await outer.setContent('<iframe style="width:900px;height:550px"></iframe>');
    await page.frames()[2].setContent(inner);
    let view = await readSnapshot(page);
    assert.ok(!view.snapshot.buttons.some(control => /log out/i.test(control.name)));
    assert.ok(!view.snapshot.text.includes('Retained paper fact'));
    await act(page, 'GET THE STORY: TYPES OF PAPER');
    view = await readSnapshot(page);
    assert.match(view.snapshot.text, /Retained paper fact/);
    await act(page, 'Getting the right paper');
    await act(page, 'Paper quality');
    assert.match((await readSnapshot(page)).snapshot.text, /Modal material about grain/);
    await act(page, 'Close');
    assert.doesNotMatch((await readSnapshot(page)).snapshot.text, /Modal material about grain/);

    await page.setContent(`<style>p{height:300px}</style><h1>Long lesson</h1>${Array.from({length:14}, (_, i) => `<p>Section ${i}: ${'introductory words '.repeat(70)}</p>`).join('')}<p>FINAL UNIQUE MATERIAL beyond the first six thousand characters.</p>`);
    const first = await readSnapshot(page);
    assert.doesNotMatch(first.snapshot.text, /FINAL UNIQUE/);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    const later = await readSnapshot(page);
    assert.match(later.snapshot.text, /FINAL UNIQUE MATERIAL/);
    assert.equal(sameLearnerView(first.snapshot, later.snapshot), false);
    assert.match(later.snapshot.text, /Source:.*Long lesson/);
  } finally { await browser.close(); }
});

test('hidden persistent slides cannot starve later controls or misattribute the active topic', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1000,height:800}});
    await page.setContent('<iframe style="width:950px;height:750px"></iframe>');
    const frame = page.frames()[1];
    await frame.setContent(`<style>.card{position:relative;width:240px;height:80px;transform-style:preserve-3d}.card.flipped{transform:rotateY(180deg)}.face{position:absolute;inset:0;backface-visibility:hidden}.back{transform:rotateY(180deg)}</style>
      <section hidden><h1>GET INVOLVED: PROBLEMS WITH PRINTING</h1>${Array.from({length:150},(_,i)=>`<button>Hidden old control ${i}</button>`).join('')}</section>
      <h1 style="position:absolute;left:-5000px;top:0">GET INVOLVED: OLD OFFSCREEN TOPIC</h1>
      <h1>GET THE STORY: TYPES OF PAPER</h1>
      <div class="card"><div class="face front" role="button" onclick="this.parentElement.classList.add('flipped')">Open paper card</div><div class="face back" role="button" onclick="this.parentElement.classList.remove('flipped')">Paper card back: Reverse-side material</div></div>
      <a href="javascript:;" onclick="document.querySelector('#panel').hidden=false">Getting the right paper</a><div id="panel" hidden>Opened accordion material</div>
      <a href="javascript:;" onclick="document.querySelector('#status').textContent='Next lesson selected'">Next</a><output id="status"></output>
      <div id="speech" class="dki-element-content speech-bubble" tabindex="1" style="cursor:pointer">Sarah: hear about paper quality</div><output id="speech-status"></output>
      <img id="quality-icon" class="dki-element-content pngFix hasRollover" tabindex="-1" alt="" width="32" height="32" style="cursor:pointer">
      <img class="dki-element-content hasRollover" alt="Not interactive" width="32" height="32" style="cursor:auto">
      <div id="quality-modal" hidden>Modal fact about paper quality retained for later questions.<button type="button" onclick="this.parentElement.hidden=true">Close</button></div>
      <a href="javascript:alert('bad')">Unsafe script link</a><a href="javascript:;alert('bad')">Unsafe appended script</a>
      ${Array.from({length:45},(_,i)=>`<button type="button">Extra course control ${i}</button>`).join('')}`);
    await frame.evaluate(() => {
      document.querySelector('#speech').addEventListener('click',() => document.querySelector('#speech-status').textContent='Sarah speech bubble opened');
      document.querySelector('#quality-icon').addEventListener('click',() => document.querySelector('#quality-modal').hidden=false);
    });
    const before = await readSnapshot(page);
    assert.equal(before.snapshot.buttons.length,40);
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Next'));
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Getting the right paper'));
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Open paper card'));
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Sarah: hear about paper quality'));
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Course information icon 1'));
    assert.ok(!before.snapshot.buttons.some(control=>control.name==='Not interactive'));
    assert.ok(!before.snapshot.buttons.some(control=>/Hidden old|Paper card back|Unsafe/.test(control.name)));
    assert.match(before.snapshot.text,/Source:.*GET THE STORY: TYPES OF PAPER/);
    assert.doesNotMatch(before.snapshot.text,/GET INVOLVED|Reverse-side material/);
    await act(page,'Open paper card');
    const flipped = await readSnapshot(page);
    assert.ok(!flipped.snapshot.buttons.some(control=>control.name==='Open paper card'));
    assert.ok(flipped.snapshot.buttons.some(control=>control.name==='Paper card back: Reverse-side material'));
    assert.match(flipped.snapshot.text,/Reverse-side material/);
    await act(page,'Getting the right paper');
    assert.match((await readSnapshot(page)).snapshot.text,/Opened accordion material/);
    await act(page,'Next');
    assert.match((await readSnapshot(page)).snapshot.text,/Next lesson selected/);
    await act(page,'Sarah: hear about paper quality');
    assert.match((await readSnapshot(page)).snapshot.text,/Sarah speech bubble opened/);
    await act(page,'Course information icon 1');
    const capturedModal = (await readSnapshot(page)).snapshot;
    assert.match(capturedModal.text,/Modal fact about paper quality retained for later questions/);
    await act(page,'Close');
    assert.doesNotMatch((await readSnapshot(page)).snapshot.text,/Modal fact about paper quality retained for later questions/);
    assert.match(capturedModal.text,/Modal fact about paper quality retained for later questions/);
  } finally { await browser.close(); }
});

test('DKI rollover icons activate without hover and keep a stable logical name after an actual hover swap', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:900,height:600}});
    await page.setContent(`<h1>Paper quality</h1><div id="icon-box" style="position:relative;width:64px;height:64px"><img id="content_148383" class="dki-element-content pngFix hasRollover" alt="" tabindex="-1" width="64" height="64" style="cursor:pointer"></div>
      <img id="content_999" class="dki-element-content hasRollover" alt="Hidden unrelated icon" width="64" height="64" style="cursor:pointer;display:none">
      <img id="orphan_rollover" class="dki-element-content dki-image-rollover" data-id="888" width="32" height="32">
      <div id="modal" hidden>Captured paper-quality modal facts.<button type="button" onclick="this.parentElement.hidden=true">Close</button></div>`);
    await page.evaluate(() => {
      window.hoverCount=0;window.hiddenClicks=0;
      const base=document.querySelector('#content_148383');
      const open=()=>document.querySelector('#modal').hidden=false;
      base.addEventListener('click',open);
      document.querySelector('#content_999').addEventListener('click',()=>window.hiddenClicks++);
      base.addEventListener('mouseover',()=>{
        window.hoverCount++;
        let clone=document.querySelector('#content_148383_rollover');
        if(!clone){
          clone=document.createElement('img');clone.id='content_148383_rollover';clone.className='dki-element-content pngFix dki-image-rollover';clone.dataset.id='148383';clone.width=64;clone.height=64;clone.style.cssText='position:absolute;inset:0;cursor:pointer';
          clone.addEventListener('click',open);document.querySelector('#icon-box').append(clone);
        }
        base.style.display='none';
      });
    });
    const initial=await readSnapshot(page);
    assert.deepEqual(initial.snapshot.buttons.map(control=>control.name),['Course information icon 1']);
    await act(page,'Course information icon 1');
    assert.equal(await page.evaluate(()=>window.hoverCount),0,'activation must avoid the pointer hover that replaces the base image');
    assert.match((await readSnapshot(page)).snapshot.text,/Captured paper-quality modal facts/);
    await act(page,'Close');
    const box=await page.locator('#content_148383').boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.locator('#content_148383_rollover').waitFor({state:'visible'});
    assert.equal(await page.locator('#content_148383').isVisible(),false);
    const hovered=await readSnapshot(page);
    assert.deepEqual(hovered.snapshot.buttons,initial.snapshot.buttons);
    assert.equal(sameLearnerView(hovered.snapshot,initial.snapshot),true);
    await assert.rejects(applyAction(page,{action:'click',targetId:initial.snapshot.buttons[0].id},initial.snapshot,initial.handles),/target changed/);
    await applyAction(page,{action:'click',targetId:hovered.snapshot.buttons[0].id},hovered.snapshot,hovered.handles);
    assert.match((await readSnapshot(page)).snapshot.text,/Captured paper-quality modal facts/);
    await act(page,'Close');
    assert.doesNotMatch((await readSnapshot(page)).snapshot.text,/Captured paper-quality modal facts/);
    assert.equal(await page.evaluate(()=>window.hiddenClicks),0);
  } finally {await browser.close();}
});

test('curriculum scrolling offers later modules before the control caps and ignores passive cso-frame containers', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:900,height:400}});
    await page.setContent(`<style>body{margin:0}a.module{display:block;height:28px;line-height:28px}header{position:fixed;top:0;right:0;background:white}</style><header><output id="selected">No module chosen</output></header>
      <div data-toggle="cso-frame" class="treeRoot"><h1>Long curriculum</h1>
      ${Array.from({length:160},()=>'<div data-toggle="cso-frame" class="cso-placeholder">100%</div>').join('')}
      <button type="button" data-toggle="cso-frame" onclick="document.querySelector('#selected').textContent='Overview opened'">Course overview</button>
      ${Array.from({length:150},(_,i)=>`<a class="module" href="javascript:;" onclick="document.querySelector('#selected').textContent='Module ${i+1} opened'">Open module ${String(i+1).padStart(3,'0')}</a>`).join('')}</div>`);
    const before = await readSnapshot(page);
    assert.equal(before.snapshot.buttons.length,40);
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Course overview'),'a real cso-frame button must remain actionable');
    assert.ok(before.snapshot.buttons.some(control=>control.name==='Open module 001'));
    assert.ok(!before.snapshot.buttons.some(control=>control.name==='Open module 150'));
    assert.ok(before.snapshot.buttons.every(control=>control.name==='Course overview'||/^Open module \d{3}$/.test(control.name)),'passive progress/tree containers must not consume controls');
    assert.equal(sameLearnerView(before.snapshot,(await readSnapshot(page)).snapshot),true);
    for(let index=0;index<30;index+=1) await applyAction(page,{action:'scroll'},before.snapshot,before.handles);
    const after = await readSnapshot(page);
    assert.equal(after.snapshot.buttons.length,40);
    assert.ok(after.snapshot.buttons.some(control=>control.name==='Open module 150'),'viewport priority must run before both the 120-candidate and 40-control caps');
    assert.ok(after.snapshot.buttons.some(control=>control.name==='Open module 001'),'offscreen course controls remain a fallback');
    assert.equal(sameLearnerView(after.snapshot,(await readSnapshot(page)).snapshot),true);
    await act(page,'Open module 150');
    assert.equal(await page.locator('#selected').textContent(),'Module 150 opened');
  } finally {await browser.close();}
});

test('real answer, form Next, final Submit and visible pass; old mode cannot submit', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Quiz question</h1><form onsubmit="event.preventDefault();if(this.choice.value==='correct'){document.querySelector('#question').hidden=true;document.querySelector('#summary').hidden=false}">
      <div id="question"><label><input type="radio" name="choice" value="correct">Correct material answer</label><label><input type="radio" name="choice" value="wrong">Other answer</label><input type="submit" value="Next »"></div></form>
      <div id="summary" hidden><p>Summary</p><button onclick="document.body.innerHTML='<h1>Quiz result</h1><p>You passed this quiz. Your score: 100%</p>'">Submit quiz</button></div>`);
    let view = await readSnapshot(page, 'quiz');
    const next = view.snapshot.buttons.find(control => control.name === 'Next »');
    assert.equal(next.kind, 'quiz-navigation');
    assert.equal(localActionAllowed({action:'click', targetId: next.id}, view.snapshot), false);
    assert.equal((await readSnapshot(page)).snapshot.buttons.some(control => control.name === 'Next »'), false);
    await act(page, 'Correct material answer', 'quiz', true);
    await act(page, 'Next »', 'quiz');
    view = await readSnapshot(page, 'quiz');
    const submit = view.snapshot.buttons.find(control => control.name === 'Submit quiz');
    assert.equal(submit.kind, 'submission');
    assert.equal(localActionAllowed({action:'click',targetId:submit.id}, {...view.snapshot, mode:'quiz', submissionAuthorized:true}), false);
    assert.equal(pageShowsPass(view.snapshot), false);
    await act(page, 'Submit quiz', 'quiz');
    assert.equal(pageShowsPass((await readSnapshot(page, 'quiz')).snapshot), true);
    await page.setContent('<h1>Quiz result</h1><p>You have not passed. Your score: 100%</p>');
    assert.equal(pageShowsPass((await readSnapshot(page, 'quiz')).snapshot), false);
  } finally { await browser.close(); }
});

test('radio snapshots expose checked state so a model selects once then advances', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<h1>Question 1 of 20</h1><label><input type="radio" name="answer" value="a">Answer A</label><label><input type="radio" name="answer" value="b">Answer B</label><button type="button" onclick="document.querySelector('h1').textContent='Question 2 of 20'">Next »</button><button type="button"><input type="checkbox" checked>Choice wrapper</button>`);
    let view=await readSnapshot(page,'quiz');
    assert.deepEqual(view.snapshot.choices.filter(choice=>choice.id.startsWith('c')).map(choice=>choice.checked),[false,false]);
    assert.equal(view.snapshot.buttons.find(control=>control.name==='Choice wrapper').checked,true);
    const next=view.snapshot.buttons.find(control=>control.name==='Next »');
    assert.equal(localActionAllowed({action:'click',targetId:next.id},view.snapshot,'quiz'),false);
    const model=snapshot=>snapshot.choices.some(choice=>choice.id.startsWith('c')&&choice.checked===true)?{action:'click',targetId:snapshot.buttons.find(control=>control.name==='Next »').id}:{action:'answer-select',targetId:snapshot.choices.find(choice=>choice.name==='Answer A').id};
    await applyAction(page,model(view.snapshot),view.snapshot,view.handles,'quiz');
    view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.choices.find(choice=>choice.name==='Answer A').checked,true);
    assert.equal(localActionAllowed({action:'answer-select',targetId:view.snapshot.choices.find(choice=>choice.name==='Answer A').id},view.snapshot,'quiz'),false);
    await applyAction(page,model(view.snapshot),view.snapshot,view.handles,'quiz');
    assert.match((await readSnapshot(page,'quiz')).snapshot.text,/Question 2 of 20/);
    await page.setContent('<h1>Question 2 of 20</h1><div role="radio">Unknown custom choice state</div><button type="button">Next</button>');
    const legacy=await readSnapshot(page,'quiz');
    assert.equal(legacy.snapshot.choices[0].checked,undefined);
    assert.equal(localActionAllowed({action:'click',targetId:legacy.snapshot.buttons[0].id},legacy.snapshot,'quiz'),true);
  } finally {await browser.close();}
});

test('scroll directions and literal find-text inspect rendered course text with nonfatal missing feedback', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:900,height:400}});
    await page.setContent(`<h1>Opening overview</h1>${'<p style="height:100px">Earlier lesson material</p>'.repeat(18)}<p>Needle caliper material</p>${'<p style="height:100px">Later lesson material</p>'.repeat(8)}`);
    const initial=await readSnapshot(page);
    await applyAction(page,{action:'find-text',text:'Needle caliper material'},initial.snapshot,initial.handles);
    const found=await readSnapshot(page);
    assert.match(found.snapshot.text,/Found rendered text: Needle caliper material/);
    const position=await page.evaluate(()=>scrollY);
    assert.ok(position>0);
    await applyAction(page,{action:'scroll',direction:'up'},found.snapshot,found.handles);
    const up=await page.evaluate(()=>scrollY);assert.ok(up<position);
    await applyAction(page,{action:'scroll'},found.snapshot,found.handles);
    assert.ok(await page.evaluate(()=>scrollY)>up);
    await applyAction(page,{action:'find-text',text:'javascript:window.unwantedExecution=true'},found.snapshot,found.handles);
    assert.match((await readSnapshot(page)).snapshot.text,/Text was not found in rendered course content/);
    assert.equal(await page.evaluate(()=>window.unwantedExecution),undefined);
  } finally {await browser.close();}
});

test('capture attaches one bounded viewport JPEG and skips visible password/auth forms', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:800,height:400}});
    await page.setContent('<h1>Course diagram</h1><p>A visible diagram explanation.</p>');
    let captures=0;const screenshot=page.screenshot.bind(page);page.screenshot=async options=>{captures++;return screenshot(options);};
    const initial=await readSnapshot(page);assert.equal(captures,0);
    await applyAction(page,{action:'capture'},initial.snapshot,initial.handles);
    const first=await readSnapshot(page);const second=await readSnapshot(page);
    assert.match(first.snapshot.image,/^data:image\/jpeg;base64,/);
    assert.ok(first.snapshot.image.length<=900_000);
    assert.equal(Buffer.from(first.snapshot.image.split(',')[1],'base64').readUInt16BE(0),0xffd8);
    assert.equal(second.snapshot.image,undefined);assert.equal(captures,1);
    assert.equal(sameLearnerView(first.snapshot,second.snapshot),true);
    assert.equal(sameLearnerView(first.snapshot,{...second.snapshot,text:'Changed course content'}),false);
    await page.setContent('<form><label>Password<input type="password" value="fixture-only-secret"></label></form>');
    await applyAction(page,{action:'capture'},second.snapshot,second.handles);
    const blocked=await readSnapshot(page);assert.equal(blocked.snapshot.image,undefined);assert.equal(captures,1);
    assert.match(blocked.snapshot.text,/Screenshot skipped/);
    assert.doesNotMatch(blocked.snapshot.text,/fixture-only-secret/);
    await page.setContent('<h1>Course view</h1>');
    page.screenshot=async()=>Buffer.alloc(900_000);
    await applyAction(page,{action:'capture'},blocked.snapshot,blocked.handles);
    const oversized=await readSnapshot(page);assert.equal(oversized.snapshot.image,undefined);assert.match(oversized.snapshot.text,/exceeds the size limit/);
  } finally {await browser.close();}
});

test('outlines inventory hidden topics with concrete canonical source URLs without claiming they were read', async () => {
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('https://course.invalid/**',route=>{
      const url=new URL(route.request().url());
      const body=url.pathname.endsWith('LMS3.aspx')?`<h1>Generic course wrapper</h1>${['2427/PaperTheory.html','2428/Chapter.html','2429/Chapter.html','2430/Chapter.html','2431/Chapter.html'].map(path=>`<iframe src="/content/${path}?session=fixture#topic" style="width:500px;height:200px"></iframe>`).join('')}`
        :url.pathname.includes('EvalLaunch')?'<h1>Question 1 of 20</h1><h2>Assessment only</h2>'
        :`<title>Actual course source</title><h1>Paper theory</h1><section hidden><h2>Hidden unvisited topic</h2></section>${Array.from({length:70},(_,i)=>`<h2>Topic ${i}</h2>`).join('')}`;
      return route.fulfill({contentType:'text/html',body});
    });
    const page=await context.newPage();await page.goto('https://course.invalid/lms/scorm/clientLMS/LMS3.aspx?token=fixture');
    const view=await readSnapshot(page);
    assert.equal(view.snapshot.outlines.length,4);
    assert.equal(view.snapshot.outlines[0].url,'https://course.invalid/content/2427/PaperTheory.html');
    assert.ok(view.snapshot.outlines.every(outline=>!/[?#]/.test(outline.url)&&outline.topics.length<=60&&outline.topics.every(topic=>topic.length<=160)));
    assert.ok(view.snapshot.outlines[0].topics.includes('Hidden unvisited topic'));
    assert.doesNotMatch(view.snapshot.text,/Hidden unvisited topic/);
    await page.goto('https://course.invalid/EvalLaunch.aspx');
    const assessment=await readSnapshot(page,'quiz');assert.equal(assessment.snapshot.outlines,undefined);assert.match(assessment.snapshot.text,/Question 1 of 20/);
  } finally {await browser.close();}
});

test('observed WebForms assessment anchors navigate only in quiz mode and reject arbitrary script or external actions', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    const options = target => `javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("${target}", "", true, "", "", false, true));`;
    await page.setContent(`<h1 id="question">Question 1</h1><label><input type="radio" name="answer" value="correct">Correct answer</label><label><input type="radio" name="answer" value="other">Other answer</label>
      <a role="button" href="javascript:__doPostBack('ac$SaveButton','')" onclick="javascript:stopCountdown();">Save / Return Later</a>
      <a role="button" href='${options('ac$ReviewButton')}'>Summary</a><a role="button" href='${options('ac$NextButton')}'>Next »</a>
      <a role="button" href="javascript:alert(1)">Arbitrary script</a>
      <a role="button" href=" &#x09;javascript:alert(1)">Whitespace script</a>
      <a role="button" href='${options('ac$NextButton')}alert(1)'>Appended script</a>
      <a role="button" href='javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("ac$NextButton", "", true, "", "https://evil.invalid/submit", false, true));'>External action</a>
      <a role="button" href="javascript:__doPostBack('ac$DeleteAccountButton','')">Misleading target</a>
      <a role="button" href="javascript:__doPostBack('ac$NextButton','nonempty')">Nonempty argument</a>
      <a href='${options('ac$NextButton')}'>Missing button role</a>`);
    await page.evaluate(() => {
      window.stopCountdown = () => {window.countdownStopped=true;};
      window.WebForm_PostBackOptions = function(eventTarget,eventArgument,validation,validationGroup,actionUrl,trackFocus,clientSubmit) {Object.assign(this,{eventTarget,eventArgument,validation,validationGroup,actionUrl,trackFocus,clientSubmit});};
      window.__doPostBack = target => {
        if(target==='ac$NextButton' && document.querySelector('input[value=correct]').checked) document.querySelector('#question').textContent='Question 2';
        if(target==='ac$ReviewButton') document.querySelector('#question').textContent='Quiz summary';
        if(target==='ac$SaveButton') document.querySelector('#question').textContent='Quiz saved';
      };
      window.WebForm_DoPostBackWithOptions = options => window.__doPostBack(options.eventTarget);
    });
    const quiz = await readSnapshot(page,'quiz');
    assert.deepEqual(quiz.snapshot.buttons.map(control=>control.name),['Save / Return Later','Summary','Next »']);
    for(const target of quiz.snapshot.buttons) {
      assert.equal(target.kind,'quiz-navigation');
      assert.equal(localActionAllowed({action:'click',targetId:target.id},quiz.snapshot),false);
    }
    assert.deepEqual((await readSnapshot(page,'read')).snapshot.buttons,[]);
    await act(page,'Correct answer','quiz',true);
    await act(page,'Next »','quiz');
    await page.waitForFunction(expected=>document.querySelector('#question')?.textContent===expected,'Question 2',{timeout:5000});
    assert.equal(await page.locator('#question').textContent(),'Question 2');
    await act(page,'Summary','quiz');
    await page.waitForFunction(expected=>document.querySelector('#question')?.textContent===expected,'Quiz summary',{timeout:5000});
    assert.equal(await page.locator('#question').textContent(),'Quiz summary');
    await act(page,'Save / Return Later','quiz');
    await page.waitForFunction(expected=>document.querySelector('#question')?.textContent===expected,'Quiz saved',{timeout:5000});
    assert.equal(await page.locator('#question').textContent(),'Quiz saved');
    assert.equal(await page.evaluate(()=>window.countdownStopped),true);
  } finally {await browser.close();}
});

test('stale observed target cannot be clicked after its label changes', async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Open topic</button>');
    const view = await readSnapshot(page);
    await page.locator('button').evaluate(el => el.textContent = 'Delete account');
    await assert.rejects(applyAction(page, {action:'click',targetId:view.snapshot.buttons[0].id}, view.snapshot, view.handles), /changed/);
  } finally { await browser.close(); }
});

test('observed existing course tabs can be selected and revisited; unrelated origins and stale tabs are refused', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const context = await browser.newContext();
    await context.route('**/*',route=>{ const path = new URL(route.request().url()).pathname; return route.fulfill({contentType:'text/html',body:`<title>${path.includes('/lms/scorm/')?'':path.includes('quiz')?'Paper assessment':'Paper course curriculum'}</title><p>Course page material</p>`}); });
    const course = await context.newPage(); await course.goto('https://course.invalid/learning');
    const quiz = await context.newPage(); await quiz.goto('https://course.invalid/quiz');
    const unrelated = await context.newPage(); await unrelated.goto('https://other.invalid/quiz');
    const lesson = await context.newPage(); await lesson.goto('https://course.invalid/lms/scorm/clientLMS/LMS3.aspx?lesson=paper');
    const observed = await readSnapshot(course,'quiz');
    assert.equal(observed.snapshot.tabs.length,2);
    assert.equal(observed.snapshot.tabs[0].name,'Paper assessment');
    const action = {action:'select-tab',targetId:observed.snapshot.tabs[0].id};
    assert.equal(await applyAction(course,action,observed.snapshot,observed.handles,'quiz'),quiz);
    const back = await readSnapshot(quiz,'quiz');
    const lessonTab = back.snapshot.tabs.find(tab=>tab.url.includes('/lms/scorm/clientLMS/LMS3.aspx'));
    assert.equal(lessonTab.name,'Course page');
    assert.equal(await applyAction(quiz,{action:'select-tab',targetId:lessonTab.id},back.snapshot,back.handles,'quiz'),lesson);
    assert.equal(await applyAction(quiz,{action:'select-tab',targetId:back.snapshot.tabs[0].id},back.snapshot,back.handles,'quiz'),course);
    assert.equal(localActionAllowed(action,{...observed.snapshot,tabs:[{...observed.snapshot.tabs[0],url:'https://other.invalid/quiz'}]},'quiz'),false);
    await quiz.goto('https://course.invalid/changed');
    await assert.rejects(applyAction(course,action,observed.snapshot,observed.handles,'quiz'),/tab changed/);
  } finally { await browser.close(); }
});

test('answer labels remain selectable; Home is course navigation and read mode excludes attempt controls', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    const attempts = ['Start Quiz','Begin the Test','Launch Assessment','Retake','Retry quiz'];
    await page.setContent(`<button type="button">Home</button><button type="button">Delete account</button>${attempts.map(name=>`<button type="button">${name}</button>`).join('')}${['Password','Delete','Exit','Account'].map((name,i)=>`<label><input type="checkbox" id="c${i}">${name}</label>`).join('')}`);
    const read = await readSnapshot(page);
    assert.ok(read.snapshot.buttons.some(control=>control.name==='Home'));
    assert.ok(!read.snapshot.buttons.some(control=>attempts.includes(control.name)||control.name==='Delete account'));
    const quiz = await readSnapshot(page,'quiz');
    for(const name of attempts) {
      const target = quiz.snapshot.buttons.find(control=>control.name===name);
      assert.equal(target.kind,'quiz-navigation');
      assert.equal(localActionAllowed({action:'click',targetId:target.id},quiz.snapshot),false);
      assert.equal(localActionAllowed({action:'click',targetId:target.id},quiz.snapshot,'quiz'),true);
    }
    for(const name of ['Password','Delete','Exit','Account']) await act(page,name,'quiz',true);
    await act(page,'Home');
  } finally { await browser.close(); }
});

test('observed no-op JavaScript anchors open course panels and popups; arbitrary JavaScript links stay excluded', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const context = await browser.newContext();
    await context.route('https://course.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Course lesson</h1>'}));
    const page = await context.newPage();
    await page.setContent(`<a href="javascript:void(0);" onclick="document.querySelector('#panel').hidden=false">Open curriculum</a><div id="panel" hidden>Opened course material</div>
      <a href="javascript: void( 0 )" onclick="window.open('https://course.invalid/lesson','_blank')">Open lesson</a>
      <a href="javascript:alert('bad')">Run arbitrary script</a><a href="javascript:void(1)">Not a no-op</a><a href="javascript:void(0);">Delete account</a>`);
    const observed = await readSnapshot(page);
    assert.deepEqual(observed.snapshot.buttons.map(control=>control.name),['Open curriculum','Open lesson']);
    await act(page,'Open curriculum');
    assert.match((await readSnapshot(page)).snapshot.text,/Opened course material/);
    const popup = page.waitForEvent('popup');
    await act(page,'Open lesson');
    const lesson = await popup;
    await lesson.waitForURL('https://course.invalid/lesson');
    await lesson.waitForLoadState('domcontentloaded');
    assert.equal(lesson.url(),'https://course.invalid/lesson');
  } finally { await browser.close(); }
});

test('a failed result can retake, answer, submit and visibly pass; repeated retries are bounded', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Quiz result</h1><div id="result">You did not pass. Review feedback: use the retained amber calibration fact.<button onclick="this.parentElement.hidden=true;document.querySelector('#question').hidden=false">Retake quiz</button></div>
      <form id="question" hidden onsubmit="event.preventDefault();this.hidden=true;document.querySelector('#summary').hidden=false"><label><input type="radio" name="answer" value="amber">Amber</label><label><input type="radio" name="answer" value="blue">Blue</label><input type="submit" value="Next »"></form>
      <div id="summary" hidden><button onclick="document.body.innerHTML='<h1>Quiz result</h1><p>You passed this quiz. Your score: 100%</p>'">Submit quiz</button></div>`);
    const failure = await readSnapshot(page,'quiz');
    assert.match(failure.snapshot.text,/did not pass.*Review feedback/s);
    assert.equal(pageShowsPass(failure.snapshot),false);
    const budget = {count:0};
    // Deterministic fixture decisions use actual observed controls. The same
    // apply path and per-job budget are used by the runtime after proposals.
    await act(page,'Retake quiz','quiz',false,budget);
    await act(page,'Amber','quiz',true,budget);
    await act(page,'Next »','quiz',false,budget);
    await act(page,'Submit quiz','quiz',false,budget);
    assert.equal(pageShowsPass((await readSnapshot(page,'quiz')).snapshot),true);
    assert.equal(budget.count,1);

    await page.setContent(`<p>You did not pass. Feedback remains available.</p><button onclick="document.querySelector('#attempts').textContent=String(Number(document.querySelector('#attempts').textContent)+1)">Retry quiz</button><output id="attempts">0</output>`);
    const limit = {count:0};
    await act(page,'Retry quiz','quiz',false,limit);
    await act(page,'Retry quiz','quiz',false,limit);
    await assert.rejects(act(page,'Retry quiz','quiz',false,limit),error=>error.code==='LEARNER_RETRY_LIMIT');
    assert.equal(await page.locator('#attempts').textContent(),'2');
    assert.equal(pageShowsPass((await readSnapshot(page,'quiz')).snapshot),false);
  } finally { await browser.close(); }
});
