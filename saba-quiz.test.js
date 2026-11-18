const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {launchSelectedCourse,protectSabaPopups,finishSabaCourse,currentCourseSuccessful}=require('./lib/course-launch');
const {readSnapshot,applyAction,localActionAllowed,sameLearnerView}=require('./pw-learn-quiz');
const {recognizeQuizResult}=require('./lib/quiz-result');

test('native Saba matching reads sibling selected text and repair labels with a bottom question counter',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    const label='Remove the base enclosure and any other parts blocking access to the ODD';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <h1>Course assessment</h1><p>Fields marked with an asterisk (*) are required</p>
      <h2>Sequence the steps for removing an optical drive.</h2>
      <h3 id="row">${label}</h3>
      <trq-select><span id="field-control-value" hidden></span>
        <div role="combobox" style="min-height:28px;width:364px" tabindex="0" aria-labelledby="row field-control-value" aria-expanded="false" aria-controls="options"
          onclick="this.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false">Select</div>
        <div id="options" role="listbox" hidden><button role="option" onclick="const value=document.querySelector('#field-control-value');value.hidden=false;value.textContent=this.textContent;const box=document.querySelector('[role=combobox]');box.textContent=' ';box.setAttribute('aria-expanded','false');this.parentElement.hidden=true">${label}</button></div>
      </trq-select><p>Question 6 of 10</p><button aria-label="Go to next question">NEXT</button>`}));
    await page.goto(`${host}/assessment`);
    let view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.question.stem,'Sequence the steps for removing an optical drive.');
    const next=view.snapshot.buttons.find(item=>item.name==='Go to next question');
    assert.equal(localActionAllowed({action:'click',targetId:next.id},view.snapshot,'quiz'),false);
    const field=view.snapshot.buttons.find(item=>item.selection);
    await applyAction(page,{action:'click',targetId:field.id},view.snapshot,view.handles,'quiz');
    view=await readSnapshot(page,'quiz');
    const option=view.snapshot.buttons.find(item=>item.name===label && !item.selection);
    assert.ok(option);
    assert.equal(localActionAllowed({action:'click',targetId:option.id},view.snapshot,'quiz'),true);
    assert.equal(localActionAllowed({action:'click',targetId:option.id},view.snapshot,'read'),false);
    await applyAction(page,{action:'click',targetId:option.id},view.snapshot,view.handles,'quiz');
    view=await readSnapshot(page,'quiz');
    assert.deepEqual(view.snapshot.buttons.find(item=>item.selection).selection,{value:label,answered:true});
    assert.equal(localActionAllowed({action:'click',targetId:next.id},view.snapshot,'quiz'),true);
  } finally {await browser.close();}
});

const host='https://hpi-external.sabacloud.com';
const course=`${host}/app/me/learningeventdetail/coursfixture`;

test('old Successful history cannot finish or block launching an In Progress current registration',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===course
      ? `<div class="course--detail__thirdRow__enrollmentStatus__text">In Progress</div><section>Progress History<p>Successful</p></section><button onclick="window.open('/player','course','width=400')">CONTINUE</button>`
      : '<p>Current course player</p>'}));
    const landing=await context.newPage();await landing.goto(course);
    assert.equal(await currentCourseSuccessful(landing),false);
    assert.equal(await finishSabaCourse(landing),null);
    const player=await launchSelectedCourse(landing);
    assert.notEqual(player,landing);
    await landing.locator('[class*="enrollmentStatus__text"]').evaluate(el=>el.textContent='Successful');
    assert.equal(await currentCourseSuccessful(landing),true);
  }finally{await browser.close();}
});
async function click(page,name,mode='quiz',choice=false) {
  const view=await readSnapshot(page,mode);
  const target=(choice?view.snapshot.choices:view.snapshot.buttons).find(item=>item.name===name);
  assert.ok(target,`Observed ${name}`);
  const action={action:choice?'answer-select':'click',targetId:target.id};
  assert.equal(localActionAllowed(action,view.snapshot,mode),true);
  await applyAction(page,action,view.snapshot,view.handles,mode);
}

test('Continue wins over activity Launch; scoped popup protection survives Proceed on the next document',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===course
      ? `<button onclick="location.href='/proceed'">CONTINUE</button><button onclick="document.body.textContent='WRONG ACTIVITY'">LAUNCH</button>`
      : route.request().url()===`${host}/proceed`
        ? `<button onclick="window.open('/assessment','named-player','width=400,height=300')">PROCEED</button>`
        : '<h1>Question 1 of 10</h1><p>Fresh question</p>'}));
    const landing=await context.newPage();await landing.goto(course);
    // The course Continue can navigate without creating a new tab.
    await launchSelectedCourse(landing);
    assert.equal(landing.url(),`${host}/proceed`);
    const session=await context.newCDPSession(landing);
    const before=(await session.send('Browser.getWindowForTarget')).windowId;
    const popup=context.waitForEvent('page');
    await click(landing,'PROCEED');
    const assessment=await popup;await assessment.waitForLoadState();
    const child=await context.newCDPSession(assessment);
    assert.equal((await child.send('Browser.getWindowForTarget')).windowId,before);
    assert.match((await readSnapshot(assessment,'quiz')).snapshot.text,/Fresh question/);

    await landing.goto(`${host}/proceed`);
    await protectSabaPopups(landing);
    const externalPromise=context.waitForEvent('page');
    await landing.evaluate(()=>window.open('https://external-course.invalid/player','other','width=500'));
    const external=await externalPromise;await external.waitForLoadState();
    const externalSession=await context.newCDPSession(external);
    assert.equal((await externalSession.send('Browser.getWindowForTarget')).windowId,before);
    await externalSession.detach();
    await session.detach();await child.detach();
  } finally {await browser.close();}
});

test('Saba native answer selection uses a visible associated label or verified Space without force',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Question 3 of 10</h1><p>Select a repair.</p>
      <style>.trq-radio{position:relative;width:300px;height:40px}input{position:absolute;left:0;top:0;width:20px;height:20px}label{position:absolute;inset:0;background:white}</style>
      <div class="trq-radio"><input id="answer" type="radio"><label for="answer">Inspect the assembly</label></div>`}));
    await page.goto(`${host}/assessment`);
    await click(page,'Inspect the assembly','quiz',true);
    assert.equal(await page.locator('#answer').isChecked(),true);
    await page.setContent(`<h1>Question 4 of 10</h1><p>Select the next repair.</p><div style="position:relative">
      <input id="keyboard" type="radio" aria-label="Check the connector" style="width:30px;height:30px">
      <div style="position:absolute;inset:0;background:white">Visible custom radio overlay</div></div>`);
    await click(page,'Check the connector','quiz',true);
    assert.equal(await page.locator('#keyboard').isChecked(),true);
  }finally{await browser.close();}
});

test('Saba matching exposes actual labels and selected values, guards Next, and drops prior question screenshot/feedback',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Question 5 of 10</h1><p id="stem">Match the diagnostic sequence.</p>
      ${[1,2].map(i=>`<div role="combobox" tabindex="0" aria-label="Repair field ${i}" aria-expanded="false" aria-controls="list${i}" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#list${i}').hidden=false">Select</div>
        <div id="list${i}" role="listbox" hidden>${['Inspect the assembly','Check the connector'].map(label=>`<button role="option" onclick="const c=document.querySelector('[aria-controls=list${i}]');c.textContent=this.textContent;c.setAttribute('aria-expanded','false');this.parentElement.hidden=true">${label}</button>`).join('')}</div>`).join('')}
      <button id="next" onclick="document.querySelector('h1').textContent='Question 6 of 10';document.querySelector('#stem').textContent='Match a different sequence.'">Next</button>`}));
    await page.goto(`${host}/assessment`);
    let view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.question.number,5);
    assert.equal(view.snapshot.question.stem,'Match the diagnostic sequence.');
    assert.deepEqual(view.snapshot.buttons.filter(item=>item.selection).map(item=>item.selection),[{value:'Select',answered:false},{value:'Select',answered:false}]);
    assert.equal((await readSnapshot(page,'read')).snapshot.buttons.some(item=>item.id.startsWith('m')),false);
    assert.equal(localActionAllowed({action:'click',targetId:view.snapshot.buttons.find(item=>item.name==='Next').id},view.snapshot,'quiz'),false);
    await click(page,'Repair field 1');
    view=await readSnapshot(page,'quiz');
    const option=view.snapshot.buttons.find(item=>item.name==='Inspect the assembly');
    assert.ok(option);assert.equal(localActionAllowed({action:'click',targetId:option.id},view.snapshot,'read'),false);
    await click(page,'Inspect the assembly');
    await click(page,'Repair field 2');await click(page,'Check the connector');
    await click(page,'Repair field 2');
    await page.locator('#list2 [role=option]').first().evaluate(el=>el.onclick=null);
    await assert.rejects(click(page,'Inspect the assembly'),/selection could not be confirmed/);
    await page.locator('#list2').evaluate(el=>el.hidden=true);
    await page.locator('[aria-controls=list2]').evaluate(el=>el.setAttribute('aria-expanded','false'));
    view=await readSnapshot(page,'quiz');
    assert.deepEqual(view.snapshot.buttons.filter(item=>item.selection).map(item=>item.selection.value),['Inspect the assembly','Check the connector']);
    await applyAction(page,{action:'capture'},view.snapshot,view.handles,'quiz');
    const captured=await readSnapshot(page,'quiz');
    assert.equal(captured.snapshot.imageIdentity.questionId,view.snapshot.question.id);
    assert.match(captured.snapshot.image,/^data:image\/jpeg/);
    await page.locator('#next').click();
    const fresh=await readSnapshot(page,'quiz');
    assert.equal(fresh.snapshot.question.number,6);assert.notEqual(fresh.snapshot.question.id,view.snapshot.question.id);
    assert.equal(fresh.snapshot.image,undefined);assert.equal(fresh.snapshot.imageIdentity,undefined);
    assert.doesNotMatch(fresh.snapshot.text,/Tool feedback/);
    assert.equal(sameLearnerView(view.snapshot,fresh.snapshot),false);
    await assert.rejects(applyAction(page,{action:'click',targetId:view.snapshot.buttons[0].id},view.snapshot,view.handles,'quiz'),/question target changed/);
    await page.setContent(`<h1>Question 7 of 10</h1><p>One nested matching field</p>
      <div role="combobox" tabindex="0" aria-expanded="false" aria-controls="nested" onclick="this.setAttribute('aria-expanded','true');this.querySelector('[role=listbox]').hidden=false">Select
        <div role="listbox" id="nested" hidden><button role="option" onclick="event.stopPropagation();this.closest('[role=combobox]').textContent='Inspect the assembly'">Inspect the assembly</button></div>
      </div>`);
    view=await readSnapshot(page,'quiz');
    assert.equal(view.snapshot.buttons[0].name,'Matching field 1');
    assert.deepEqual(view.snapshot.buttons[0].selection,{value:'Select',answered:false});
    await click(page,'Matching field 1');await click(page,'Inspect the assembly');
    assert.deepEqual((await readSnapshot(page,'quiz')).snapshot.buttons[0].selection,{value:'Inspect the assembly',answered:true});
  }finally{await browser.close();}
});

test('real Saba pass finalizes through Close Player and Yes, verifying only the originating course',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===course
      ? `<title>Fixture course</title><p class="course--detail__thirdRow__enrollmentStatus__text">Not evaluated</p><button onclick="window.open('/app/content-player?contextid=fixture','player','width=500')">CONTINUE</button><button>LAUNCH</button>`
      : `<p>Congratulations, you passed the assessment</p><p>Test score 100%</p><p>Test status Pass</p><p>Passing threshold 80%</p>
        <button onclick="document.body.textContent='UNEXPECTED EXIT'">EXIT</button><button onclick="document.querySelector('#yes').hidden=false">CLOSE PLAYER</button>
        <button id="yes" hidden onclick="window.opener.document.querySelector('p').textContent='Successful';window.close()">YES</button>`}));
    const landing=await context.newPage();await landing.goto(course);
    const player=await launchSelectedCourse(landing);
    assert.notEqual(player,landing);
    const result=recognizeQuizResult((await readSnapshot(player,'quiz')).snapshot);
    assert.equal(result.status,'passed');assert.equal(result.scorePercent,100);assert.equal(result.passingScorePercent,80);
    const finished=await finishSabaCourse(landing,true,player);
    assert.equal(finished.status,'completed');assert.match(finished.evidence.join(),/Saba course detail shows Successful/);
    await landing.locator('body').evaluate(body=>body.insertAdjacentHTML('beforeend','<section>Progress History<p>Successful</p></section>'));
    await launchSelectedCourse(landing);
    assert.equal(context.pages().length,1,'Never relaunch a completed course');
    await landing.goto(`${host}/app/me/learningeventdetail/courswrong`);
    await landing.setContent('<p class="course--detail__thirdRow__enrollmentStatus__text">Successful</p>');
    assert.equal(await finishSabaCourse(landing),null,'Another course success is not this result');
  }finally{await browser.close();}
});

test('the real runner finalizes a Saba assessment launched by same-tab Continue then Proceed without publishing an early pass',{timeout:60000},async()=>{
  const net=require('node:net'),{spawn}=require('node:child_process');
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:[`--remote-debugging-port=${port}`]});
  try {
    const context=await browser.newContext();
    // Two CDP clients attach during this fixture. Route the popup after its
    // blank target exists, so CI never races its first request to the real LMS.
    const popupSetup=[];
    context.on('page',popup=>{
      if(!popupSetup.length)return;
      popupSetup[0](popup);
    });
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('?done=1')
      ? '<title>Completed originating course</title><p class="course--detail__thirdRow__enrollmentStatus__text">Successful</p>'
      : route.request().url()===course
        ? `<button onclick="location.href='/proceed'">CONTINUE</button><button>LAUNCH</button>`
        : route.request().url()===`${host}/proceed`
          ? `<button onclick="window.open('about:blank','quiz','width=400')">PROCEED</button>`
          : `<p>Congratulations, you passed the assessment</p><p>Test score 100%</p><p>Test status Pass</p><p>Passing threshold 80%</p>
            <button onclick="document.querySelector('#yes').hidden=false">CLOSE PLAYER</button>
            <button id="yes" hidden onclick="window.opener.location.href='/app/me/learningeventdetail/coursfixture?done=1';window.close()">YES</button>`}));
    const page=await context.newPage();await page.goto(course);
    const popupReady=new Promise((resolve,reject)=>popupSetup.push(async popup=>{
      try {
        await popup.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<p>Congratulations, you passed the assessment</p><p>Test score 100%</p><p>Test status Pass</p><p>Passing threshold 80%</p>
          <button onclick="document.querySelector('#yes').hidden=false">CLOSE PLAYER</button><button id="yes" hidden onclick="window.opener.location.href='/app/me/learningeventdetail/coursfixture?done=1';window.close()">YES</button>`}));
        await popup.goto(`${host}/assessment`);resolve();
      }catch(error){reject(error);}
    }));
    const run=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['pw-learn-quiz.js','0'],{cwd:__dirname,env:{...process.env,PLAYWRIGHT_CDP_URL:`http://127.0.0.1:${port}`,VITRIOL_CAPTURE_TARGET:course,VITRIOL_LEARNER_MODE:'quiz',VITRIOL_COORDINATE:'',VITRIOL_LEARNER_CONVERSATION:'',VITRIOL_LEARNER_GUIDANCE:''},stdio:['pipe','pipe','pipe']});
      let output='',error='',buffer='';
      const timer=setTimeout(()=>{child.kill();reject(Error('Saba runner did not finish: '+error));},45000);
      child.stdout.on('data',chunk=>{
        output+=chunk;buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines)if(line.startsWith('LEARNER_SNAPSHOT ')){
          const snapshot=JSON.parse(line.slice(17));
          child.stdin.write('LEARNER_ACTION '+JSON.stringify({action:'click',targetId:snapshot.buttons.find(item=>item.name==='PROCEED')?.id})+'\n');
        }
      });
      child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
      child.on('exit',code=>{clearTimeout(timer);resolve({code,output,error});});
    });
    await popupReady;
    assert.equal(run.code,0,run.error+run.output.replace(/^LEARNER_SNAPSHOT.*$/gm,'[snapshot]'));
    const payload=JSON.parse(run.output.match(/^AUTOMATION_RESULT (.+)$/m)[1]);
    assert.equal(payload.courseResult.status,'completed');assert.equal(payload.quizResult.status,'passed');
    assert.equal(payload.quizResult.scorePercent,100);assert.equal(payload.quizResult.passingScorePercent,80);
    assert.equal(await page.getByText('Successful',{exact:true}).isVisible(),true);
    assert.doesNotMatch(run.output,/LEARNER_QUESTION/);
  }finally{await browser.close();}
});

test('real learner bounds unchanged coordination and prioritizes fresh questions/results over stale handoff',{timeout:120000},async()=>{
  const net=require('node:net'),{spawn}=require('node:child_process');
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:[`--remote-debugging-port=${port}`]});
  try {
    const page=await browser.newPage();
    for(const scenario of ['corrected','bounded','late-result','fresh-question']){
      await page.setContent(`<h1>Question 5 of 10</h1><p>Current unchanged question</p><button>Next</button>
        <button onclick="document.body.innerHTML='<p>Congratulations, you passed the assessment</p><p>Test score 100%</p><p>Test status Pass</p><p>Passing threshold 80%</p>'">Continue</button>`);
      const run=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['pw-learn-quiz.js','0'],{cwd:__dirname,env:{...process.env,PLAYWRIGHT_CDP_URL:`http://127.0.0.1:${port}`,VITRIOL_CAPTURE_TARGET:'',VITRIOL_LEARNER_MODE:'quiz',VITRIOL_COORDINATE:'1'},stdio:['pipe','pipe','pipe']});
        let output='',error='',buffer='',coordinations=0;const observations=[];
        const timer=setTimeout(()=>{child.kill();reject(Error(`Unchanged runner ${scenario} did not finish (${coordinations} coordination requests): ${error}\n${output.replace(/^LEARNER_SNAPSHOT .*$/gm,'[snapshot]').slice(-3000)}`));},40000);
        child.stdout.on('data',chunk=>{
          output+=chunk;buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();
          for(const line of lines)if(line.startsWith('LEARNER_SNAPSHOT ')){
            const snapshot=JSON.parse(line.slice(17));
            observations.push(snapshot);
            if(scenario==='fresh-question'){
              const question=observations.length===1?'Old question guidance':'Fresh question guidance';
              const respond=()=>child.stdin.write('LEARNER_ACTION '+JSON.stringify({action:'ask-user',question})+'\n');
              if(observations.length===1)page.setContent('<h1>Question 6 of 10</h1><p>A fresh question stem</p><button>Next</button>').then(respond).catch(reject);
              else respond();
              continue;
            }
            if(snapshot.unchangedAction)coordinations++;
            const action={action:'click',targetId:snapshot.buttons.find(item=>item.name===(snapshot.unchangedAction&&scenario==='corrected'?'Continue':'Next'))?.id};
            if(snapshot.unchangedAction&&scenario==='late-result'){
              page.getByRole('button',{name:'Continue',exact:true}).click().then(()=>child.stdin.write('LEARNER_ACTION '+JSON.stringify({action:'ask-user',question:'Old unchanged question'})+'\n')).catch(reject);
            }else child.stdin.write('LEARNER_ACTION '+JSON.stringify(action)+'\n');
          }
        });
        child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
        child.on('exit',code=>{clearTimeout(timer);resolve({code,output,error,coordinations,observations});});
      });
      if(scenario==='bounded'){
        assert.equal(run.code,1,run.error);assert.equal(run.coordinations,2);assert.match(run.output,/LEARNER_QUESTION/);
      }else if(scenario==='fresh-question'){
        assert.equal(run.code,1,run.error);assert.equal(run.coordinations,0);
        assert.match(run.output,/LEARNER_QUESTION .*Fresh question guidance/);assert.doesNotMatch(run.output,/LEARNER_QUESTION .*Old question guidance/);
        assert.deepEqual(run.observations.map(snapshot=>snapshot.question.number),[5,6]);
        assert.notEqual(run.observations[0].imageIdentity.id,run.observations[1].imageIdentity.id);
        for(const snapshot of run.observations)assert.equal(snapshot.imageIdentity.questionId,snapshot.question.id);
      }else{
        assert.equal(run.code,0,run.error);assert.equal(run.coordinations,1);assert.doesNotMatch(run.output,/LEARNER_QUESTION/);
        assert.equal(JSON.parse(run.output.match(/^AUTOMATION_RESULT (.+)$/m)[1]).quizResult.status,'passed');
      }
    }
  }finally{await browser.close();}
});
