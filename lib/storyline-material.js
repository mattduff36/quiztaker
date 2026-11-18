// Read observed Storyline learning manifests and their referenced narration.
// Static string/JSON parsing only. Never execute source or retain answer keys.
'use strict';
const CONTENT_HOST='content-na2prd0004-na2hp.sabacloud.com';
function storylineRoot(address){try{const u=new URL(address);return u.protocol==='https:'&&u.hostname===CONTENT_HOST&&!u.username&&!u.password&&u.pathname.startsWith('/content/learning/')&&/\/(?:index_lms|story)\.html$/i.test(u.pathname)?u.origin+u.pathname.replace(/[^/]+$/,''):null;}catch{return null;}}
function scoped(reference,base,root){if(typeof reference!=='string'||/[\\?#\x00-\x20]/.test(reference)||/%/.test(reference.startsWith(root)?reference.slice(root.length):reference))return null;try{const u=new URL(reference,base);return u.href.startsWith(root)&&!/%/.test(u.href.slice(root.length))&&!u.search&&!u.hash&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function parseProvidedData(source,kind){
  const prefix=/^\uFEFF?\s*window\.globalProvideData\(\s*(['"])([a-z]+)\1\s*,\s*(['"])/.exec(source);
  if(!prefix||prefix[2]!==kind)throw Error('Unexpected source wrapper');
  const quote=prefix[3];let i=prefix[0].length,value='',closed=false;
  const escapes={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',"'":"'",'"':'"','\\':'\\','/':'/'};
  for(;i<source.length;i++){
    const c=source[i];if(c===quote){i++;closed=true;break;}if(c==='\n'||c==='\r')throw Error('Invalid string literal');
    if(c!=='\\'){value+=c;continue;}const e=source[++i];
    if(Object.hasOwn(escapes,e)){value+=escapes[e];continue;}
    if(e==='u'||e==='x'){const size=e==='u'?4:2,hex=source.slice(i+1,i+1+size);if(!new RegExp(`^[a-f0-9]{${size}}$`,'i').test(hex))throw Error('Invalid escape');value+=String.fromCharCode(parseInt(hex,16));i+=size;continue;}
    throw Error('Unsupported string escape');
  }
  if(!closed||!/^\s*\)\s*;?\s*$/.test(source.slice(i)))throw Error('Executable or trailing source refused');
  return JSON.parse(value);
}
async function storylineSourceRead(frame,url,root,maxBytes){return frame.evaluate(async({url,root,maxBytes})=>{
  if(!location.href.startsWith(root))throw Error('Learning publication changed');
  const r=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok||!/javascript|text|json/i.test(r.headers.get('content-type')||''))throw Error('Source unavailable');
  const reader=r.body.getReader(),decoder=new TextDecoder();let size=0,text='';
  try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Source too large');}text+=decoder.decode(v.value,{stream:true});}return{text:text+decoder.decode(),bytes:size};}finally{reader.releaseLock();}
},{url,root,maxBytes});}
async function collectStorylineMaterial(frame,{read=storylineSourceRead,title='Course',maxBytes=4*1024*1024,maxRequests=120,timeoutMs=30000}={}){
  const root=storylineRoot(frame.url());if(!root)return null;
  const observed=await frame.evaluate(()=>[...document.scripts].map(s=>s.src).concat(performance.getEntriesByType('resource').map(e=>e.name)));
  const manifests=[...new Set(observed.map(url=>scoped(url,frame.url(),root)).filter(url=>url?.endsWith('/html5/data/js/data.js')))];
  const gaps=[],materials=[];let requests=0,bytes=0,pages=0;const started=Date.now();
  const get=async url=>{if(++requests>maxRequests||bytes>=maxBytes||Date.now()-started>timeoutMs)throw Error('Collection limit');const result=await read(frame,url,root,Math.min(1024*1024,maxBytes-bytes));bytes+=result.bytes??Buffer.byteLength(result.text);if(bytes>maxBytes)throw Error('Collection limit');return result.text;};
  if(manifests.length!==1)return{root,materials,pages,requests,bytes,gaps:[{source:'manifest',reason:'Unique observed learning manifest unavailable'}],incomplete:true};
  try{
    const manifest=parseProvidedData(await get(manifests[0]),'data');
    // A mixed/assessment publication needs a separate safe lesson mapping.
    if(manifest.scorings&&Object.keys(manifest.scorings).length)throw Error('Assessment publication excluded from narration extraction');
    const captions=[...new Set((manifest.assetLib||[]).map(a=>a.captions).filter(Boolean))];
    if(captions.length>maxRequests-1)throw Error('Caption request limit');
    for(const ref of captions){
      const url=scoped(ref,root,root);if(!url||!url.startsWith(root+'story_content/')||!/_captions\.js$/i.test(url))throw Error('Caption escaped learning publication');
      try{
        const data=parseProvidedData(await get(url),'caption');const text=decodeURIComponent(data.data).split(/\r?\n/)
          .filter(line=>line.trim()&&!/^(?:WEBVTT|Kind:|Source|\d{2}:\d{2}:)/.test(line)).join(' ').trim();if(!text)continue;
        const part=`\n\n[Narration source: ${url}]\n${text}`;let group=materials.at(-1);
        if(!group||group.text.length+part.length>7400){group={url,title:`${title} - narration ${materials.length+1}`,text:''};materials.push(group);}
        if(materials.length>32)throw Error('Retained material limit');group.text+=part.slice(0,7400);pages++;
      }catch(error){gaps.push({source:ref,reason:error.message});if(/limit/i.test(error.message))break;}
    }
  }catch(error){gaps.push({source:'manifest',reason:error.message});}
  return{root,materials,pages,requests,bytes,gaps,incomplete:!!gaps.length,note:'Narration evidence collected; completion still requires normal course interactions and portal verification.'};
}
module.exports={storylineRoot,parseProvidedData,collectStorylineMaterial,scoped};
