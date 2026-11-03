import assert from 'node:assert/strict';
import test from 'node:test';
import { calculate, executeServerTool, isPublicAddress, searchCourseMaterial, validatePublicUrl } from '../src/lib/ai-tools.js';
import { completeHostedChat } from '../src/lib/llm-provider.js';
import { snapshotInput } from '../src/lib/ai-responses.js';
import { boundLearnerSnapshot } from '../src/lib/learner.js';
import { aiToolCatalog } from '../src/lib/ai-tool-catalog.js';

test('arithmetic parser handles precedence and rejects executable and unbounded input', async () => {
  assert.equal(calculate('(24+6)*3/2'),45); assert.equal(calculate('2**3**2'),512); assert.equal(calculate('1e2+0.5'),100.5);
  for (const input of ['process.env.SECRET','Math.random()','1/0','2**99999','1'.repeat(201),'1 2','1e','()']) assert.throws(() => calculate(input));
  assert.equal((await executeServerTool('calculate','{"expression":"4*7","extra":"bad"}')).evidence.status,'failed');
});

test('public references reject credentials, metadata, private IPs, protocols and LMS sessions', () => {
  for (const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://10.1.2.3','https://169.254.169.254/latest','https://[::1]/','https://metadata.google.internal','https://example.com/?access_token=secret','https://hpi-external.sabacloud.com/session','https://example.com:8080/']) assert.throws(() => validatePublicUrl(url),url);
  assert.equal(validatePublicUrl('https://support.usa.canon.com/manual#part').hash,'');
  for (const ip of ['10.1.1.1','100.64.0.1','127.0.0.2','192.168.1.1','198.18.0.1','224.0.0.1','::ffff:8.8.8.8','fe80::1','2001:db8::1']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true); assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});

test('material retrieval uses only authenticated owner and bounded source excerpts', async () => {
  let calls = 0;
  const result = await searchCourseMaterial('owner-id','toner temperature',async <T>(sql:string,values?:unknown[]) => {
    calls++; assert.match(sql,/where user_id = \$1/); assert.deepEqual(values,['owner-id']);
    return [{materials:[{title:'Canon material',url:'https://lms.example/course?session=private',text:'Toner temperature '+ 'fact '.repeat(3000)}]}] as T[];
  });
  assert.equal(calls,1); assert.ok(result.matches[0].excerpt.length<=1400); assert.equal(result.matches[0].url,'https://lms.example/course');
  await assert.rejects(() => searchCourseMaterial(undefined,'topic'),/Authenticated/);
  await assert.rejects(() => searchCourseMaterial('owner-id','https://lms.example/session'),/topic terms/);
});

test('snapshot keeps checked/outlines but sends image outside text and strips URL sessions', () => {
  const image = 'data:image/jpeg;base64,YWJj';
  const snapshot = {title:'Quiz',url:'https://lms.example/q?session=SECRET',text:'Read https://lms.example/course?token=SECRET',choices:[{id:'c1',name:'Answer',checked:true}],image,outlines:[{url:'https://lms.example/o?session=SECRET',title:'Outline',topics:['Toner']}]};
  assert.equal(boundLearnerSnapshot(snapshot).choices?.[0].checked,true);
  const item = snapshotInput(snapshot); const content = item.content as Array<Record<string,unknown>>;
  assert.equal(content[1].image_url,image); assert.ok(!String(content[0].text).includes(image)); assert.ok(!String(content[0].text).includes('SECRET'));
  assert.equal(boundLearnerSnapshot({...snapshot,image:'data:text/html;base64,YWJj'}).image,undefined);
});

test('Responses executes function calls, returns output by call id, and retains native citations', async () => {
  let calls=0;
  const result = await completeHostedChat({provider:'openai',model:'gpt-6.1-sol',apiKey:'sk-test-only-0123456789',userId:'owner',snapshot:{title:'Quiz',buttons:[{id:'b1',name:'Next'}]},fetchImpl:async (url,init) => {
    calls++; assert.equal(url,'https://api.openai.com/v1/responses'); const request = JSON.parse(String(init?.body));
    assert.equal(request.tools.some((t:{type:string}) => t.type==='web_search'),true); assert.equal(request.max_tool_calls,2);
    if(calls===1) return Response.json({output:[{type:'function_call',call_id:'call1',name:'calculate',arguments:'{"expression":"6*7"}'}]});
    assert.equal(request.input.at(-1).type,'function_call_output'); assert.equal(request.input.at(-1).call_id,'call1'); assert.equal(JSON.parse(request.input.at(-1).output).result,42);
    return Response.json({output:[{type:'web_search_call',status:'completed',action:{sources:[{title:'Manual',url:'https://canon.com/manual?token=private'}]}},{type:'message',content:[{type:'output_text',text:'{"action":"click","targetId":"b1"}'}]}]});
  }});
  assert.equal(result.ok,true); assert.equal(calls,2); assert.deepEqual(result.evidence?.map(e=>e.tool),['calculate','web_search']); assert.equal(result.evidence?.[1].sources?.[0].url,'https://canon.com/manual');
});

test('requested native test fails honestly when the provider does not call it; catalog reflects connection', async () => {
  const result=await completeHostedChat({provider:'openai',model:'gpt-6.1-sol',apiKey:'sk-test-only-0123456789',snapshot:{},testTool:'web_search',fetchImpl:async()=>Response.json({output_text:'{"action":"wait","ms":0}'})});
  assert.equal(result.ok,false); if(!result.ok) assert.match(result.error,/without completing/);
  assert.equal(aiToolCatalog({source:'inherited',provider:'openai',ready:true},false).some(t=>t.available),false);
  assert.equal(aiToolCatalog({source:'personal',provider:'openai',ready:true},true).every(t=>t.available),true);
});

test('Responses tool loop stops after four rounds without proposing unverified actions', async () => {
  let calls=0;
  const result=await completeHostedChat({provider:'openai',model:'gpt-6.1-sol',apiKey:'sk-test-only-0123456789',snapshot:{},fetchImpl:async()=>{
    calls++; return Response.json({output:[{type:'function_call',call_id:`call${calls}`,name:'current_time',arguments:'{}'}]});
  }});
  assert.equal(calls,4); assert.equal(result.ok,false); if(!result.ok) assert.match(result.error,/round limit/); assert.equal(result.evidence?.length,4);
});
