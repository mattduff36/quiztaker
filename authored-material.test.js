'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {collectAuthoredMaterial, publicationRoot, scopedSource, sourceText, LIMITS} = require('./lib/authored-material');
const ROOT = 'https://canon-europe.csod.com/content/canon-europe/publications/123/';
const MASTER = ROOT + 'lib_en/templates/master.htm';

function sources() {
  return new Map([
    [ROOT+'index.htm','<html lang="en"><script src="lib/js/splash.js"></script></html>'],
    [ROOT+'lib/js/splash.js',`var target = 'lib_'+lang+'/templates/master.htm';`],
    [MASTER,'<script src="../../lib/js/course.js"></script>'],
    [ROOT+'lib/js/course.js',`masterObj.init("../xml/master.xml");`],
    [ROOT+'lib_en/xml/master.xml',`<!-- <page xml="../xml/dead.xml"/> --><page xml="../xml/lesson.xml"/><page xml="../xml/image.xml"/><page xml="../xml/missing.xml"/><page xml="../xml/quiz.xml"/>`],
    [ROOT+'lib_en/xml/lesson.xml',`<data><text><![CDATA[<p>Observed lesson &amp; source text.</p>]]></text><dialogue xml="../xml/dialogue.xml"/></data>`],
    [ROOT+'lib_en/xml/dialogue.xml','<data><text>Nested material</text><dialogue xml="../xml/lesson.xml"/><dialogue xml="https://evil.invalid/key.xml"/></data>'],
    [ROOT+'lib_en/xml/image.xml','<data><image src="diagram.png"/></data>'],
    [ROOT+'lib_en/xml/quiz.xml','<quiz><answer correct="true"><text>HIDDEN KEY</text></answer></quiz>'],
  ]);
}

test('observed loader -> active pages -> recursive dialogue, honest gaps and no answer keys', async () => {
  const files=sources(), requested=[];
  const report=await collectAuthoredMaterial({url:()=>ROOT+'index.htm'}, {title:'Fixture',read:async (_,url)=>{
    requested.push(url);
    return files.has(url) ? {text:files.get(url)} : {error:'HTTP 404'};
  }});
  assert.equal(report.materials.length,1);
  assert.match(report.materials[0].text, /\[Authored lesson source: https:.*lesson.xml\]\nObserved lesson & source text/);
  assert.match(report.materials[0].text,/Nested material/);
  assert.doesNotMatch(JSON.stringify(report.materials),/HIDDEN KEY/);
  assert.equal(report.incomplete,true);
  assert.ok(report.gaps.some(gap=>/textless/.test(gap.reason)));
  assert.ok(report.gaps.some(gap=>/HTTP 404/.test(gap.reason)));
  assert.ok(report.gaps.some(gap=>/assessment source/.test(gap.reason)));
  assert.ok(!requested.some(url=>/evil|dead.xml/.test(url)));
  assert.equal(new Set(requested).size,requested.length);
});

test('scope and all collection budgets fail closed without guessed URLs',async()=>{
  for(const url of ['http://127.0.0.1/a','https://canon-europe.csod.com.evil.invalid/content/canon-europe/publications/1/index.htm',
    'https://canon-europe.csod.com/content/canon-europe/publications/1234/index.htm']) {
    assert.equal(scopedSource(url,MASTER,ROOT),null);
  }
  for(const ref of ['../../../outside.xml','%2e%2e/secret.xml','x.xml?token=secret','x.xml#key','\\x.xml','']) assert.equal(scopedSource(ref,MASTER,ROOT),null);
  assert.equal(publicationRoot('https://user:pass@canon-europe.csod.com/content/canon-europe/publications/123/index.htm'),null);
  const files=sources(), frame={url:()=>MASTER};
  const read=async(_,url)=>files.has(url)?{text:files.get(url)}:{error:'HTTP 404'};
  for(const limits of [{requests:1},{bytes:10},{pages:1},{depth:0},{ms:0},{chars:5},{chunks:1}]) {
    const report=await collectAuthoredMaterial(frame,{read,limits:{...LIMITS,...limits}});
    assert.equal(report.incomplete,true,JSON.stringify(limits));
    assert.ok(report.requests<=(limits.requests??LIMITS.requests));
    assert.ok(report.materials.length<=(limits.chunks??LIMITS.chunks));
  }
  assert.equal(sourceText('<!-- <text>hidden</text> --><text>&#x41; &lt;b&gt;</text>'),'A <b>');
});

test('long lessons retain late pages and nested panels within the chunk budget',async()=>{
  const files=sources();
  files.set(ROOT+'lib_en/xml/master.xml',Array.from({length:94},(_,i)=>`<page xml="../xml/page-${i}.xml"/>`).join(''));
  for(let i=0;i<94;i++) files.set(ROOT+`lib_en/xml/page-${i}.xml`,
    `<data><text>Page ${i}: ${'retained lesson fact '.repeat(25)}</text>${i===93?'<dialogue xml="../xml/final-panel.xml"/>':''}</data>`);
  files.set(ROOT+'lib_en/xml/final-panel.xml','<data><text>Final nested panel: JDF job intent.</text></data>');
  const report=await collectAuthoredMaterial({url:()=>MASTER},{read:async(_,url)=>
    files.has(url)?{text:files.get(url)}:{error:'HTTP 404'}});
  assert.equal(report.pages,95);
  assert.equal(report.incomplete,false);
  assert.ok(report.materials.length<=32);
  assert.ok(report.materials.every(source=>source.text.length<=7400));
  const retained=report.materials.map(source=>source.text).join('\n');
  for(let i=0;i<94;i++) assert.ok(retained.includes(`Page ${i}:`),`missing page ${i}`);
  assert.match(retained,/final-panel\.xml\]\nFinal nested panel: JDF job intent/);
});

test('authenticated browser source transport blocks redirects before following them',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.addCookies([{name:'fixture-session',value:'offline-only',url:ROOT}]);
    const files=sources();let escaped=0,cookieSeen=false;
    await context.route('**/*',async route=>{
      const url=route.request().url();
      if(!url.startsWith(ROOT)) {escaped++;return route.abort();}
      cookieSeen ||= (route.request().headers().cookie||'').includes('fixture-session=offline-only');
      if(url.endsWith('missing.xml')) return route.fulfill({status:302,headers:{location:'https://evil.invalid/redirect.xml'}});
      return route.fulfill({status:files.has(url)?200:404,contentType:url.endsWith('.xml')?'application/xml':'text/html',body:files.get(url)||''});
    });

    test('partial page budgets retain safe text, failed reads consume bytes and stalled reads time out',async()=>{
      const files=sources(),frame={url:()=>MASTER};
      const report=await collectAuthoredMaterial(frame,{limits:{...LIMITS,pages:1},
        read:async(_,url)=>({text:files.get(url)||''})});
      assert.equal(report.materials.length,1);
      assert.equal(report.incomplete,true);
      let requests=0;
      const refused=await collectAuthoredMaterial(frame,{limits:{...LIMITS,bytes:8,responseBytes:8},
        read:async()=>{requests++;return requests<=3?{text:files.get([MASTER,ROOT+'lib/js/course.js',ROOT+'lib_en/xml/master.xml'][requests-1]),bytes:0}:{error:'response byte limit',bytes:8};}});
      assert.equal(refused.bytes,8);
      assert.equal(requests,4);
      const started=Date.now();
      const stalled=await collectAuthoredMaterial(frame,{limits:{...LIMITS,ms:25},read:()=>new Promise(()=>{})});
      assert.equal(stalled.incomplete,true);
      assert.ok(Date.now()-started<1000);
    });
    const page=await context.newPage();await page.goto(MASTER);
    const report=await collectAuthoredMaterial(page.mainFrame());
    assert.equal(cookieSeen,true);assert.equal(escaped,0);
    assert.ok(report.gaps.some(gap=>/redirect blocked/.test(gap.reason)));
    assert.equal(report.materials.length,1);
  } finally {await browser.close();}
});
