// Normal finalization for a direct Storyline SCO in the selected Saba wrapper.
// Only existing completion is committed. No status, score or answer is written.
const { readActivities } = require('./container-activities');
const { currentCourseSuccessful, originatingSabaPage } = require('./course-launch');
const {readCourseList}=require('./cert-status');
const { recognizeQuizResult } = require('./quiz-result');

const COURSE_EXIT_LABEL = /^(?:close\s+(?:module|player)|exit(?:\s+(?:course|module|and\s+finish))?)$/i;
const CONTENT_HOST = 'content-na2prd0004-na2hp.sabacloud.com';

function wrapperIdentity(address) {
  try {
    const url = new URL(address);
    if (url.origin !== 'https://hpi-external.sabacloud.com' || !/\/app\/content-player$/i.test(url.pathname)
      || !url.searchParams.get('contextid') || !url.searchParams.get('regid')) return null;
    return url.href;
  } catch { return null; }
}

function contentFrame(frame, name) {
  try {
    const url = new URL(frame.url());
    return frame.name() === name && url.protocol === 'https:' && url.hostname === CONTENT_HOST
      && (name !== 'scorm_api' || url.pathname === '/content/rcs/scorm_frame.html');
  } catch { return false; }
}

async function terminalStoryline(frame) {
  return frame.evaluate(() => {
    const label = document.getElementById('slide-label')?.textContent.trim() || '';
    const layer = document.querySelector('.slide-layer.base-layer.shown');
    if (!layer || !/^slide:\s*(?:Thank\s*You|Results(?:\s+Slide)?|Course\s+Complete)$/i.test(label)) return false;
    if ([...document.querySelectorAll('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')]
      .some(el => !el.closest('[aria-hidden=true],[hidden]') && el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))) return false;
    const text = [...document.querySelectorAll('.slide-layer.shown')].map(el => el.innerText || '').join('\n').trim();
    return /\byou\s+have\s+(?:now\s+)?completed\s+(?:this|the)\s+(?:module|course)\b/i.test(text.replace(/\s+/g, ' '))
      || /\b(?:passed|passing score|your score)\b/i.test(text) ? { label, text } : false;
  });
}

async function existingCompletion(frame, commit = false) {
  return frame.evaluate(commit => {
    const api = window.API_1484_11 || window.API;
    if (!api) return { completed: false, reason: 'scorm-api-unavailable' };
    const modern = Boolean(window.API_1484_11);
    const get = key => modern ? api.GetValue(key) : api.LMSGetValue(key);
    const error = () => String(modern ? api.GetLastError() : api.LMSGetLastError()) === '0';
    const completion = get(modern ? 'cmi.completion_status' : 'cmi.core.lesson_status');
    if (!error()) return { completed: false, reason: 'scorm-status-unreadable' };
    const success = modern ? get('cmi.success_status') : completion;
    if (!error()) return { completed: false, reason: 'scorm-status-unreadable' };
    const completed = modern ? completion === 'completed' && success !== 'failed'
      : completion === 'completed' || completion === 'passed';
    if (!completed) return { completed: false, completion, success, reason: 'scorm-completion-not-recorded' };
    if (!commit) return { completed: true, completion, success };
    const committed = String(modern ? api.Commit('') : api.LMSCommit('')) === 'true' && error();
    return { completed, committed, completion, success, ...(!committed ? { reason: 'scorm-commit-failed' } : {}) };
  }, commit);
}

const DIALOGS = '[role=dialog], [aria-modal=true], trq-dialog, trq-modal, .modal';
function courseExitDialogs(page) {
  return page.locator(DIALOGS).filter({ visible: true })
    .filter({ hasNot: page.locator(DIALOGS).filter({ visible: true }) });
}

async function exitConfirmation(page) {
  const dialogs = courseExitDialogs(page);
  if (await dialogs.count() === 0) return { confirmed: false };
  if (await dialogs.count() !== 1) return { confirmed: false, reason: 'ambiguous-course-exit-confirmation' };
  const dialog = dialogs.first();
  const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
  if (!/\b(?:close|exit|finish)\b.{0,100}\b(?:course|module|player)\b|\b(?:course|module|player)\b.{0,100}\b(?:close|exit|finish)\b/i.test(text)
    || /\b(?:account|password|sign\s*out|log\s*out|payment|purchase|buy|billing|charge|checkout|credit\s*card|delete|remove|unsubscribe|withdraw|unenroll|reset|erase|wipe|browser|discard|lose|unsaved)\b/i.test(text)) {
    return { confirmed: false, reason: 'unsafe-course-exit-confirmation' };
  }
  const yes = dialog.getByRole('button', { name: /^(?:yes|exit and finish)$/i }).filter({ visible: true });
  if (await yes.count() !== 1 || !await yes.isEnabled()) return { confirmed: false, reason: 'course-exit-confirmation-unavailable' };
  await yes.click({ timeout: 5000 });
  return { confirmed: true };
}

async function returnedCourseEvidence(page, wrapperAddress, title) {
  if (page.isClosed()) return null;
  const address = new URL(page.url());
  if (address.origin !== 'https://hpi-external.sabacloud.com') return null;
  const back = new URL(wrapperAddress).searchParams.get('backurl') || '';
  const courseId = back.match(/\/learningeventdetail[;/](cours[a-z0-9]+)/i)?.[1];
  const certId = back.match(/\/ledetail[;/](crtfy[a-z0-9]+)/i)?.[1];
  if (courseId && new RegExp(`/learningeventdetail[;/]${courseId}(?:[;/]|$)`).test(address.pathname)
    && await currentCourseSuccessful(page)) return 'Saba course detail shows Successful for the same course.';
  if (certId && new RegExp(`/ledetail[;/]${certId}(?:[;/]|$)`).test(address.pathname)) {
    title = title.replace(/^Cornerstone Saba:\s*/i, '').replace(/\s+/g, ' ').trim();
    const certificate=(await readCourseList(page)).filter(row=>row.title.replace(/\s+/g,' ').trim()===title
      &&row.action==='CERT'&&!row.isBlocked).length===1;
    if (certificate) return 'Saba certification return shows a unique enabled Print certificate action for this course.';
  }
  return null;
}

function createStorylineFinalizer(selectedPage, activateControl, { timeoutMs = 10000 } = {}) {
  const page=wrapperIdentity(selectedPage.url())?selectedPage:originatingSabaPage(selectedPage);
  const external=page&&selectedPage!==page?selectedPage:null;
  const boundAddress = page&&wrapperIdentity(page.url());
  const contentPages=(external||page)?.frames()||[];
  const publications=contentPages.map(frame=>{try{const u=new URL(frame.url());const sco=u.searchParams.get('sco_url');if(u.origin!==`https://${CONTENT_HOST}`||u.pathname!=='/content/rcs/remote_frameset_modern.html'||!sco)return null;const source=new URL(sco,u);return source.origin===u.origin&&source.pathname.startsWith('/content/learning/')?source.origin+source.pathname.replace(/[^/]+$/,''):null;}catch{return null;}}).filter(Boolean);
  const boundPublication=[...new Set(publications)].length===1?publications[0]:null;
  return async function finalize() {
    if (!boundAddress || page.isClosed() || page.url() !== boundAddress) return { attempted: false };
    if(external){if(external.isClosed())return{attempted:false};const child=new URL(external.url());if((child.searchParams.get('context_id')||child.searchParams.get('contextid'))!==new URL(boundAddress).searchParams.get('contextid'))return{attempted:false};}
    let courseTitle=(await page.title()).replace(/^Cornerstone Saba:\s*/i,'').trim();
    const ended=await Promise.all((external||page).frames().map(async frame=>{
      try{const u=new URL(frame.url());if(!boundPublication||u.href!==boundPublication+'lms/goodbye.html'||!courseTitle)return false;
        return frame.evaluate(()=>/^The content has ended\. You may close this window\.$/.test(document.body.innerText.replace(/\s+/g,' ').trim())&&!document.querySelector('input,textarea,[role=radio],[role=checkbox]'));
      }catch{return false;}
    }));
    if(ended.filter(Boolean).length===1){
      const evidence=['The scoped learning content reached its normal goodbye page.'];
      const close=page.getByRole('button',{name:/^close player$/i}).filter({visible:true});
      if(await close.count()!==1)return{attempted:true,reason:'course-close-player-unavailable',evidence};
      await close.click({timeout:5000});
      const finish=page.getByRole('button',{name:/^exit and finish$/i}).filter({visible:true});
      await finish.waitFor({state:'visible',timeout:3000}).catch(()=>{});
      if(await finish.count()===1&&await finish.isEnabled()&&/Please choose an exit option/i.test(await page.locator('body').first().innerText())){
        await finish.click({timeout:5000});evidence.push('Used normal Exit and finish after content end.');
      }
      const deadline=Date.now()+timeoutMs;
      while(!page.isClosed()&&Date.now()<deadline){
        const verified=await returnedCourseEvidence(page,boundAddress,courseTitle);if(verified)return{attempted:true,verified:true,title:courseTitle,evidence:[...evidence,verified]};
        await page.waitForTimeout(250);
      }
      return{attempted:true,reason:'parent-course-success-unverified',title:courseTitle,evidence};
    }
    let frames = (external||page).frames().filter(frame => frame.parentFrame() === (external||page).mainFrame());
    const players = frames.filter(frame => {
      try { const url = new URL(frame.url()); return url.origin === `https://${CONTENT_HOST}`
        && url.pathname === '/content/rcs/remote_frameset_modern.html'; } catch { return false; }
    });
    if (players.length > 1) return { attempted: false };
    const player = players[0];
    if (player) frames = (external||page).frames().filter(frame => frame.parentFrame() === player);
    const scos = frames.filter(frame => contentFrame(frame, 'sco'));
    const apis = external?[external.mainFrame()]:player ? [player] : frames.filter(frame => contentFrame(frame, 'scorm_api'));
    if (scos.length !== 1 || apis.length !== 1) return { attempted: false };
    const terminal = await terminalStoryline(scos[0]);
    if (!terminal) return { attempted: false };
    const quizResult = /Results/i.test(terminal.label) ? recognizeQuizResult({ text: `Quiz Results\n${terminal.text}` }) : null;
    const result = value => ({ attempted: true, ...(quizResult ? { quizResult } : {}), ...value });
    const rows = await readActivities(page);
    if (rows.length !== 1 || !rows[0].title) return result({ reason: 'terminal-activity-identity-ambiguous' });
    const activity = rows[0];
    const headings = page.getByRole('heading', { level: 1 }).filter({ visible: true });
    const terminalTitle = await headings.count() === 1 ? (await headings.innerText()).trim()
      : (await page.title()).replace(/^Cornerstone Saba:\s*/i, '').trim();
    if (!terminalTitle) return result({ reason: 'course-title-unavailable' });
    courseTitle=terminalTitle;
    const sco = scos[0], api = apis[0], scoAddress = sco.url(), apiAddress = api.url();
    const evidence = [];
    let saved = await existingCompletion(api, true);
    if (saved.completed && !saved.committed) return result({ reason: saved.reason, evidence });
    const close = sco.getByRole('button', { name: /^(?:close module|exit course|exit module)$/i }).filter({ visible: true });
    if (await close.count() > 1) return result({ reason: 'ambiguous-module-exit', evidence });
    if (await close.count() === 1) {
      if (page.url() !== boundAddress || sco.url() !== scoAddress || api.url() !== apiAddress
        || JSON.stringify(await terminalStoryline(sco)) !== JSON.stringify(terminal)) {
        return result({ reason: 'course-finalization-target-changed', evidence });
      }
      const name = await close.getAttribute('aria-label') || (await close.innerText()).trim();
      await activateControl(page, close, name);
      evidence.push('Activated the observed terminal module exit.');
      if (!page.isClosed() && page.url() === boundAddress) {
        const confirmation = await exitConfirmation(page);
        if (confirmation.reason) return result({ reason: confirmation.reason, evidence });
      }
    }
    // A course can set its real completion in its Close module handler.
    if (!saved.committed && !api.isDetached() && api.url() === apiAddress) saved = await existingCompletion(api, true);
    if (!saved.committed) return result({ reason: saved.reason || 'scorm-completion-unverified', evidence });
    evidence.push(`Existing SCORM completion (${saved.completion}/${saved.success}) committed without changing status or score.`);
    async function verifyReturn() {
      const deadline = Date.now() + timeoutMs;
      while (!page.isClosed()) {
        const verified = await returnedCourseEvidence(page, boundAddress, courseTitle);
        if (verified) return result({ verified: true, title: courseTitle, evidence: [...evidence, verified] });
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(200);
      }
      return result({ reason: 'parent-course-success-unverified', evidence });
    }
    // Storyline's normal exit can navigate the existing wrapper directly back
    // to its certification; that expected return still needs LMS verification.
    if (page.isClosed() || page.url() !== boundAddress) return verifyReturn();
    const deadline = Date.now() + timeoutMs;
    let lmsCompleted = false;
    while (!page.isClosed() && page.url() === boundAddress) {
      const current = await readActivities(page);
      lmsCompleted = current.length === 1 && current[0].title === activity.title
        && current[0].domId === activity.domId && current[0].status === 'Completed';
      if (lmsCompleted || Date.now() >= deadline) break;
      await page.waitForTimeout(200);
    }
    if (lmsCompleted) evidence.push('The same Saba activity shows Completed Successfully.');
    if (page.isClosed() || page.url() !== boundAddress) return verifyReturn();
    const closePlayer = page.getByRole('button', { name: /^close player$/i }).filter({ visible: true });
    if (await closePlayer.count() !== 1 || !await closePlayer.isEnabled()) return result({ reason: 'course-close-player-unavailable', evidence });
    await closePlayer.click({ timeout: 5000 });
    if (!page.isClosed() && page.url() === boundAddress) {
      await courseExitDialogs(page)
        .first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 2000) }).catch(error => {
          if (error.name !== 'TimeoutError') throw error;
        });
      const confirmation = await exitConfirmation(page);
      if (confirmation.reason) return result({ reason: confirmation.reason, evidence });
    }
    return verifyReturn();
  };
}

module.exports = { COURSE_EXIT_LABEL, createStorylineFinalizer, existingCompletion, exitConfirmation, returnedCourseEvidence };
