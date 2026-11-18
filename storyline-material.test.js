const test=require('node:test'),assert=require('node:assert/strict');
const {parseProvidedData,scoped,collectStorylineMaterial}=require('./lib/storyline-material');
const root='https://content-na2prd0004-na2hp.sabacloud.com/content/learning/fixture%3D/';
const wrap=(kind,data)=>`window.globalProvideData('${kind}',${JSON.stringify(JSON.stringify(data))});`;
test('static Storyline parser reads quoted JSON and rejects executable suffixes',()=>{
 assert.deepEqual(parseProvidedData(wrap('data',{text:"It's a lesson"}),'data'),{text:"It's a lesson"});
 for(const source of [wrap('data',{})+';fetch("/secret")',"window.globalProvideData('data',JSON.stringify({}));"])assert.throws(()=>parseProvidedData(source,'data'));
 assert.equal(scoped(root+'html5/data/js/data.js',root,root),root+'html5/data/js/data.js');
 for(const ref of ['../other/file','story_content/%2e%2e/x_captions.js','https://evil.invalid/x','story_content/x_captions.js?token=1'])assert.equal(scoped(ref,root,root),null);
});
test('only observed manifest narration is retained, with missing sources explicit and assessments excluded',async()=>{
 const manifest=root+'html5/data/js/data.js',caption=root+'story_content/one_captions.js';
 const frame={url:()=>root+'index_lms.html',evaluate:async()=>[manifest]};
 const calls=[];const read=async(_f,url)=>{calls.push(url);return{text:url===manifest?wrap('data',{assetLib:[{captions:'story_content/one_captions.js'},{captions:'story_content/missing_captions.js'}]}):url===caption?wrap('caption',{data:encodeURIComponent('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nRemember this fact.')}):(()=>{throw Error('Not found')})()};};
 const result=await collectStorylineMaterial(frame,{read,title:'Lesson'});
 assert.equal(result.pages,1);assert.match(result.materials[0].text,/Remember this fact/);assert.equal(result.incomplete,true);assert.equal(calls.length,3);
 const blocked=await collectStorylineMaterial(frame,{read:async()=>({text:wrap('data',{scorings:{assessment:'private'},assetLib:[{captions:'story_content/one_captions.js'}]})})});
 assert.equal(blocked.materials.length,0);assert.match(blocked.gaps[0].reason,/Assessment publication excluded/);
});
