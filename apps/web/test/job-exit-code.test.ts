import assert from 'node:assert/strict';
import test from 'node:test';
import {recordJobEvent} from '../src/lib/jobs';
import type {SqlQuery} from '../src/lib/db';

test('actual terminal ingestion stores a legacy unsigned Windows status as signed int32 and preserves raw evidence', async()=>{
  const oldBlob=process.env.BLOB_READ_WRITE_TOKEN;delete process.env.BLOB_READ_WRITE_TOKEN;
  const writes:Array<{text:string;values:unknown[]}>=[];
  const job={id:'job',helper_id:'helper',user_id:'owner',plan_id:'plan',attempt_id:'attempt',capability_id:'list-tabs',capability_version:1,script:'pw-list-tabs.js',status:'running'};
  const sql:SqlQuery=async<T>(text:string,values:unknown[]=[])=>{
    writes.push({text,values});
    if(text.includes('select status from jobs'))return [{status:job.status}] as T[];
    return [];
  };
  const deps={
    queryOne:async<T>(text:string):Promise<T|null>=>text.includes('select * from jobs')?job as T:null,
    queryRows:async<T>():Promise<T[]>=>[],
    withTransaction:async<T>(fn:(query:SqlQuery)=>Promise<T>)=>fn(sql),
  };
  try {
    await recordJobEvent('helper','owner','job',{sequence:4,event:'failed',data:{code:3221226505,output:'Native executor stopped.'},occurredAt:new Date().toISOString()},deps);
    const update=writes.find(write=>write.text.includes('exit_code = $3'))!;
    assert.ok(update,'the real terminal ingestion must reach its jobs update');
    assert.equal(update.values[1],'failed');
    assert.equal(update.values[2],-1073740791);
    const event=writes.find(write=>write.text.includes('insert into job_events'))!;
    assert.deepEqual(JSON.parse(String(event.values[4])),{code:-1073740791,rawCode:3221226505});
    const outcome=JSON.parse(String(update.values[3]));
    assert.equal(outcome.verified,false);
    writes.length=0;job.status='helper-offline';
    await recordJobEvent('helper','owner','job',{sequence:4,event:'failed',data:{code:3221226505},occurredAt:new Date().toISOString()},deps);
    assert.equal(writes.length,0,'already recovered terminal jobs acknowledge replay without rewriting outcomes');
  } finally {if(oldBlob===undefined)delete process.env.BLOB_READ_WRITE_TOKEN;else process.env.BLOB_READ_WRITE_TOKEN=oldBlob;}
});
