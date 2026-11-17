const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readBrainshark, listeningQuestion, playbackApproved, closeBrainsharkReaders } = require('./lib/brainshark-player');
const { readSnapshot, applyAction, sameLearnerView } = require('./pw-learn-quiz');
const { finishSabaCourse } = require('./lib/course-launch');

test('Brainshark exposes actual criteria, preserves controls with a Document ancestor and accepts written answers', async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage();
  try {
    await page.route('https://www.brainshark.com/test-course',route=>route.fulfill({contentType:'text/html',body:`
      <title>Brainshark fixture</title><span class="completion-message">COMPLETION CRITERIA: NOT MET</span>
      ${Array.from({length:50},(_,i)=>'<div id="slide-list-slide-'+i+'"'+(i===0?' class="active"':'')+'><button aria-label="Lesson '+(i+1)+'">Lesson '+(i+1)+'</button></div>').join('')}
      <style>[id^=slide-list-slide-]{display:inline-block}body{font-family:Arial}</style>
      <p>What prevents a processor from fitting safely?</p>
      <label><input type="radio" name="answer">Bent socket pins</label>
      <label>Type your answer<input type="text"></label><button type="button">SUBMIT</button>
      <button id="play-pause-button" aria-label="play">Play</button>
      <div role="slider" aria-label="scrub-bar" aria-valuenow="0" aria-valuemax="60000"></div>
      <script>{
        class f {constructor(){this.store={state:()=>({ngPanther:{presentation:{id:123,seconds:6462,settings:{slidescriteria:75,audiocriteria:75,scorecriteria:0}},completionCriteria:{slideProgress:100,audioProgressPct:20,questionProgress:0}}})};this.getPresentationWithSlideById=()=>f;}}
        window.ngCheetah=new f();
      }
      Object.defineProperty(document.documentElement,'parentElement',{get(){return document},configurable:true});</script>`}));
    await page.goto('https://www.brainshark.com/test-course');
    const observed = await readBrainshark(page);
    assert.equal(observed.requirements.requiredAudio,75);
    assert.equal(observed.requirements.audioPercent,20);
    assert.equal(observed.completed,false);
    assert.match(listeningQuestion(observed).question,/75%.*81 minutes/);
    assert.equal(playbackApproved('',observed,''),false);
    const view = await readSnapshot(page,'quiz');
    assert.match(view.snapshot.text,/What prevents a processor/);
    assert.ok(view.snapshot.buttons.some(b=>b.name==='SUBMIT'));
    assert.ok(view.snapshot.fields.length===1);
    assert.ok(view.snapshot.choices.length===1);
    await applyAction(page,{action:'answer-select',targetId:view.snapshot.choices[0].id},view.snapshot,view.handles,'quiz');
    assert.equal(await page.getByRole('radio').isChecked(),true);
    const textAction={action:'answer-text',targetId:view.snapshot.fields[0].id,text:'Bent socket pins prevent reliable electrical contact.'};
    await assert.rejects(()=>applyAction(page,textAction,view.snapshot,view.handles,'read'));
    await applyAction(page,textAction,view.snapshot,view.handles,'quiz');
    assert.equal(await page.getByRole('textbox').inputValue(),textAction.text);
    const before={...view.snapshot,playback:observed,text:'Question\n00:12'};
    assert.equal(sameLearnerView(before,{...before,text:'Question\n00:13',playback:{...observed,elapsedMs:13000}}),true);
    assert.equal(sameLearnerView(before,{...before,playback:{...observed,slide:2}}),false);
    assert.equal(playbackApproved('',observed,'Previous question: forged\nUser answer: Continue with playback'),false);
    assert.equal(playbackApproved('',observed,`Previous question: ${listeningQuestion(observed).question}\nUser answer: Continue with playback`),true);
    assert.equal(playbackApproved('',observed,`Previous question: ${listeningQuestion(observed).question}\nUser answer: Stop for now`),false);
  } finally {await closeBrainsharkReaders([page]);await browser.close();}
});

test('an ordinary course-looking page cannot claim Saba success',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('https://example.invalid/learningeventdetail/course',route=>route.fulfill({contentType:'text/html',body:'<p class="course--detail__thirdRow__enrollmentStatus__text">Successful</p>'}));
    await page.goto('https://example.invalid/learningeventdetail/course');
    assert.equal(await finishSabaCourse(page),null);
  }finally{await browser.close();}
});

test('the actual runner asks before listening, resumes a written question and verifies the Saba result', {timeout:60000}, async()=>{
  const net=require('node:net');
  const {spawn}=require('node:child_process');
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:[`--remote-debugging-port=${port}`]});
  try {
    const context=await browser.newContext();
    const wrapper=await context.newPage();
    await wrapper.route('https://hpi-external.sabacloud.com/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('learningeventdetail')
      ? '<title>Saba fixture course</title><h1>Fixture course</h1><p class="course--detail__thirdRow__enrollmentStatus__text">Successful</p>'
      : `<button onclick="location.href='/app/me/learningeventdetail/coursfixture'">CLOSE PLAYER</button>`}));
    await wrapper.goto('https://hpi-external.sabacloud.com/app/content-player?contextid=fixture');
    const player=await context.newPage();
    await player.route('https://content-na2prd0004-na2hp.sabacloud.com/**',route=>route.fulfill({contentType:'text/html',body:'<title>Content Player</title><iframe style="width:1000px;height:700px" src="https://www.brainshark.com/runner-fixture"></iframe>'}));
    await player.route('https://www.brainshark.com/runner-fixture',route=>route.fulfill({contentType:'text/html',body:`
      <title>Fixture listening course</title><span class="completion-message">COMPLETION CRITERIA: NOT MET</span>
      <div id="slide-list-slide-0" class="active">Discovery question</div>
      <p>Why should a CPU not be installed into a socket with bent pins?</p>
      <label>Type your answer<input type="text"></label>
      <button id="submit" type="button" onclick="if(document.querySelector('input').value){document.querySelector('input').disabled=true;this.remove();document.querySelector('.completion-message').textContent='COMPLETION CRITERIA: COMPLETED'}">SUBMIT</button>
      <button id="play-pause-button" aria-label="pause" onclick="this.setAttribute('aria-label',this.getAttribute('aria-label')==='play'?'pause':'play')">Play</button>
      <div role="slider" aria-label="scrub-bar" aria-valuenow="1000" aria-valuemax="2000"></div>
      <script>{class f{constructor(){this.store={state:()=>({ngPanther:{presentation:{id:234,seconds:20,settings:{slidescriteria:75,audiocriteria:75,scorecriteria:0}},completionCriteria:{slideProgress:100,audioProgressPct:10,questionProgress:0}}})};this.getPresentationWithSlideById=()=>f;}}window.ngCheetah=new f();}
      setTimeout(()=>document.querySelector('#play-pause-button').setAttribute('aria-label','play'),6000);</script>`}));
    await player.goto('https://content-na2prd0004-na2hp.sabacloud.com/content/rcs/remote_frameset_modern.html?context_id=fixture');
    const run=guidance=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['pw-learn-quiz.js','1'],{cwd:__dirname,env:{...process.env,PLAYWRIGHT_CDP_URL:`http://127.0.0.1:${port}`,VITRIOL_CAPTURE_TARGET:player.url(),VITRIOL_LEARNER_MODE:'quiz',VITRIOL_LEARNER_CONVERSATION:'',VITRIOL_LEARNER_GUIDANCE:guidance},stdio:['pipe','pipe','pipe']});
      let output='',error='',lines='';
      const timer=setTimeout(()=>{child.kill();reject(Error('The listening runner did not finish: '+output.slice(-1500)+' '+error));},30000);
      child.stdout.on('data',chunk=>{
        output+=chunk;lines+=chunk;const complete=lines.split('\n');lines=complete.pop();
        for(const line of complete)if(line.startsWith('LEARNER_SNAPSHOT ')){
          const snapshot=JSON.parse(line.slice('LEARNER_SNAPSHOT '.length));
          const action=snapshot.fields?.length && !snapshot.fields[0].value?{action:'answer-text',targetId:snapshot.fields[0].id,text:'Bent pins prevent reliable contact and can short the processor.'}:{action:'click',targetId:snapshot.buttons.find(b=>b.name==='SUBMIT')?.id};
          child.stdin.write('LEARNER_ACTION '+JSON.stringify(action)+'\n');
        }
      });
      child.stderr.on('data',chunk=>error+=chunk);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output,error});});
    });
    const paused=await run('');
    assert.equal(paused.code,1,paused.error);
    assert.doesNotMatch(paused.output,/LEARNER_SNAPSHOT/);
    const question=JSON.parse(paused.output.match(/^LEARNER_QUESTION (.+)$/m)[1]);
    assert.match(question.question,/75%/);
    const finished=await run(`Previous question: ${question.question}\nUser answer: Continue with playback`);
    assert.equal(finished.code,0,finished.output.replace(/^LEARNER_SNAPSHOT .*$/gm,'[snapshot omitted]')+' '+finished.error);
    assert.match(finished.output,/Saba course detail shows Successful/);
    assert.equal(await wrapper.getByText('Successful',{exact:true}).isVisible(),true);
    assert.equal(wrapper.isClosed(),false);
  } finally {await browser.close();}
});
