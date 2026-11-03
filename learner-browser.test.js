const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readSnapshot, applyAction, localActionAllowed, pageShowsPass, sameLearnerView } = require('./pw-learn-quiz');

async function act(page, name, mode = 'read', choice = false) {
  const view = await readSnapshot(page, mode);
  const target = (choice ? view.snapshot.choices : view.snapshot.buttons).find(control => control.name === name);
  assert.ok(target, `Observed control: ${name}`);
  const action = { action: choice ? 'answer-select' : 'click', targetId: target.id };
  assert.equal(localActionAllowed(action, view.snapshot, mode), true);
  await applyAction(page, action, view.snapshot, view.handles, mode);
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
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<title>${new URL(route.request().url()).pathname.includes('quiz')?'Paper assessment':'Paper course curriculum'}</title><p>Course page material</p>`}));
    const course = await context.newPage(); await course.goto('https://course.invalid/learning');
    const quiz = await context.newPage(); await quiz.goto('https://course.invalid/quiz');
    const unrelated = await context.newPage(); await unrelated.goto('https://other.invalid/quiz');
    const observed = await readSnapshot(course,'quiz');
    assert.equal(observed.snapshot.tabs.length,1);
    assert.equal(observed.snapshot.tabs[0].name,'Paper assessment');
    const action = {action:'select-tab',targetId:observed.snapshot.tabs[0].id};
    assert.equal(await applyAction(course,action,observed.snapshot,observed.handles,'quiz'),quiz);
    const back = await readSnapshot(quiz,'quiz');
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
