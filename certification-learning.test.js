const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {runCertificationLearning}=require('./lib/certification-learning');
test('genuine certification driver launches learning before assessment, verifies each return and stops on failed child',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});const previous=process.env.VITRIOL_LEARNER_INTENT;process.env.VITRIOL_LEARNER_INTENT='read-and-assess';
 try{for(const fail of [false,true]){
  const ctx=await browser.newContext();let done=new Set(),launched=[];
  const origin='https://hpi-external.sabacloud.com',url=origin+'/Saba/Web_spf/HPI/app/me/ledetail/crtfyfixture';
  await ctx.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url()===url?`<h1>Fixture certification</h1><p>${done.size===2?'100':'0'}% Path Completed</p>${['Assessment','Learning'].map(title=>`<section><p>${done.has(title)?'Successful':'Registered'} ${title==='Assessment'?'Exam/Test':''}</p><button title="${done.has(title)?'Print certificate for':'Launch WBT'} ${title}" onclick="location.href='${origin}/module/${title}'">${done.has(title)?'Print certificate':'Launch'}</button></section>`).join('')}`:'<h1>Module fixture</h1>'}));
  const page=await ctx.newPage();await page.goto(url);
  const result=await runCertificationLearning(page,'quiz',{runModule:async(selected,row)=>{
    launched.push(row.title);if(fail)return{code:1,result:{completed:0,total:1,failures:[{reason:'module-failed'}]}};
    done.add(row.title);await selected.goto(url);return{code:0,result:{completed:1,total:1}};
  }});
  assert.deepEqual(launched,fail?['Learning']:['Learning','Assessment']);assert.equal(result.completed===result.total,!fail);
  if(!fail)assert.match(result.courseResult.evidence[0],/every required item Successful/);
  await ctx.close();
 }}finally{if(previous===undefined)delete process.env.VITRIOL_LEARNER_INTENT;else process.env.VITRIOL_LEARNER_INTENT=previous;await browser.close();}
});
