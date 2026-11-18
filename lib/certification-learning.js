// Whole-certification genuine learning: ordinary launches, existing learner,
// normal exits and per-row/overall portal evidence. No status/score writes.
'use strict';
const {spawn}=require('node:child_process');
const {join}=require('node:path');
const readline=require('node:readline');
const {readCourseList,readCertMeta}=require('./cert-status');
const {protectSabaPopups,launchSelectedCourse}=require('./course-launch');
const {browserTargetId}=require('./browser-tabs');
function certificationAddress(address){try{const u=new URL(address);return u.origin==='https://hpi-external.sabacloud.com'&&/\/ledetail[;/]/i.test(u.pathname)&&/crtfy[a-z0-9]+/i.test(u.pathname);}catch{return false;}}
async function runLearnerModule(page){
  const pages=page.context().browser().contexts().flatMap(c=>c.pages()),index=pages.indexOf(page);
  const env={...process.env,VITRIOL_CAPTURE_TARGET:page.url(),VITRIOL_CDP_TARGET_ID:await browserTargetId(page)};
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(__dirname,'..','pw-learn-quiz.js'),String(index)],{env,stdio:['pipe','pipe','inherit'],windowsHide:true});
    let result=null;process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{if(line.startsWith('AUTOMATION_RESULT ')){try{result=JSON.parse(line.slice(18));}catch{}}else process.stdout.write(line+'\n');});
    child.once('error',error=>{process.stdin.unpipe(child.stdin);process.stdin.pause();lines.close();reject(error);});child.once('close',code=>{process.stdin.unpipe(child.stdin);process.stdin.pause();lines.close();resolve({code,result});});
  });
}
async function returnFromAssessment(wrapper){
  if(wrapper.isClosed())return;
  const exit=wrapper.getByRole('button',{name:/^exit the test$/i}).filter({visible:true});
  if(await exit.count()===1)await exit.click({timeout:5000});
  const deadline=Date.now()+10000;
  while(!wrapper.isClosed()&&/\/content-player/.test(wrapper.url())&&Date.now()<deadline){
    const text=await wrapper.locator('body').first().innerText();
    const finish=wrapper.getByRole('button',{name:/^exit and finish$/i}).filter({visible:true});
    if(/Please choose an exit option/i.test(text)&&await finish.count()===1)await finish.click({timeout:5000});
    else if(!/Content was closed successfully/i.test(text)){
      const close=wrapper.getByRole('button',{name:/^close player$/i}).filter({visible:true});
      if(await close.count()===1)await close.click({timeout:5000});
    }
    await wrapper.waitForTimeout(250);
  }
}
async function runCertificationLearning(parent,mode,{runModule=runLearnerModule,maxModules=50}={}){
  if(!certificationAddress(parent.url()))throw Error('Selected page is not the certification overview');
  const certId=parent.url().match(/crtfy[a-z0-9]+/i)[0],context=parent.context();
  const wantsAll=mode==='quiz'&&['coordinate','read-and-assess'].includes(process.env.VITRIOL_LEARNER_INTENT|| (process.env.VITRIOL_COORDINATE==='1'?'coordinate':''));
  const eligible=row=>row.required!==false&&(wantsAll||(mode==='read'?row.targetKind==='wbt':row.targetKind==='assessment'));
  const completed=[];
  for(let count=0;count<=maxModules;count++){
    if(parent.isClosed()||!certificationAddress(parent.url())||!parent.url().includes(certId))return{completed:0,total:1,failures:[{title:certId,reason:'certification-overview-unavailable'}]};
    let rows=await readCourseList(parent);
    for(let hydration=0;!rows.length&&hydration<16;hydration++){await parent.waitForTimeout(500);rows=await readCourseList(parent);}
    const meta=await readCertMeta(parent);
    if(rows.length&&meta.pathPct===100&&rows.filter(row=>row.required!==false).every(row=>row.status==='Successful'))return{completed:Math.max(1,completed.length),total:Math.max(1,completed.length),courseResult:{status:'completed',title:meta.certTitle,evidence:['Certification overview shows 100% Path Completed and every required item Successful.',...completed]}};
    const remaining=rows.filter(row=>eligible(row)&&row.status!=='Successful');
    if(!remaining.length){if(!wantsAll&&completed.length)return{completed:completed.length,total:completed.length,courseResult:{status:'completed',title:meta.certTitle,evidence:[`Requested ${mode==='read'?'learning':'assessment'} items verified Successful; overall qualification is ${meta.pathPct??'unverified'}%.`,...completed]}};return{completed:0,total:1,failures:[{title:certId,reason:'certification-completion-unverified'}]};}
    if(count===maxModules)return{completed:0,total:remaining.length,failures:[{title:certId,reason:'step-cap'}]};
    const next=remaining.filter(row=>!row.isBlocked).sort((a,b)=>Number(a.targetKind==='assessment')-Number(b.targetKind==='assessment'))[0];
    if(!next)return{completed:0,total:remaining.length,failures:remaining.map(row=>({title:row.title,reason:row.blockedReason||'action-disabled'}))};
    console.log(`LEARNER_PROGRESS ${JSON.stringify({message:`Opening ${next.title} (${next.targetKind==='assessment'?'assessment':'learning'}).`})}`);
    await protectSabaPopups(parent);const prior=new Set(context.pages());
    const control=parent.locator('button[title]').filter({visible:true}).filter({hasText:/launch|view/i});
    const handles=await control.elementHandles();let button=null;
    for(const handle of handles)if(await handle.getAttribute('title')===next.buttonTitle){if(button)throw Error('Ambiguous certification launch');button=handle;}
    if(!button)throw Error('Certification launch changed');await button.click({timeout:5000});
    const deadline=Date.now()+15000;let selected=parent;
    while(Date.now()<deadline){
      const opened=context.pages().filter(p=>!prior.has(p));
      if(opened.length>1)throw Error('Ambiguous launched module tabs');
      selected=opened[0]||parent;
      if(!certificationAddress(parent.url())||opened.length){await selected.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});selected=await launchSelectedCourse(selected);if(!selected.url().includes('about:blank'))break;}
      await parent.waitForTimeout(200);
    }
    if(certificationAddress(selected.url()))throw Error('Module launch did not open');
    const outcome=await runModule(selected,next);
    if(outcome.code!==0||!outcome.result||!outcome.result.total||outcome.result.completed!==outcome.result.total||outcome.result.quizResult?.status==='failed')return outcome.result||{completed:0,total:1,failures:[{title:next.title,reason:'module-result-unverified'}]};
    if(next.targetKind==='assessment')await returnFromAssessment(parent);
    await parent.waitForURL(url=>certificationAddress(url.href)&&url.href.includes(certId),{timeout:15000}).catch(()=>{});
    if(!certificationAddress(parent.url()))return{completed:0,total:1,failures:[{title:next.title,reason:'parent-course-success-unverified'}]};
    const verified=(await readCourseList(parent)).filter(row=>row.title===next.title&&row.status==='Successful');
    if(verified.length!==1)return{completed:0,total:1,failures:[{title:next.title,reason:'parent-course-success-unverified'}]};
    completed.push(`${next.title}: Successful`);
    console.log(`LEARNER_PROGRESS ${JSON.stringify({message:`Verified ${next.title} Successful. Checking the remaining requirements.`})}`);
  }
}
module.exports={certificationAddress,runCertificationLearning,runLearnerModule,returnFromAssessment};
