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
    assert.equal(await page.locator('#question').textContent(),'Question 2');
    await act(page,'Summary','quiz');
    assert.equal(await page.locator('#question').textContent(),'Quiz summary');
    await act(page,'Save / Return Later','quiz');
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
