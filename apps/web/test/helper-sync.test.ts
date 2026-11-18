import assert from 'node:assert/strict';
import test from 'node:test';
import { helperSyncSchema, importedReviewId } from '../src/lib/helper-sync';
import { localSyncBatches } from '../../helper/src/sync';

test('helper batches satisfy the actual authenticated sync schema without losing overflow streams',()=>{
  const ts='2026-11-18T00:00:00.000Z';
  const payload={
    history:Array.from({length:1001},(_,i)=>({sourceId:`h${i}`,kind:'course',title:'Fixture',result:'passed',detail:'',occurredAt:ts,payload:{}})),
    reviews:Array.from({length:401},(_,i)=>({sourceId:`r${i}`,type:'review',title:`Review ${i}`,detail:'',nextAction:''})),
    captures:Array.from({length:201},(_,i)=>({sourceId:`c${i}`,title:'Capture',detail:'',capturedAt:ts,probe:{}})),
  };
  const batches=localSyncBatches(payload);
  assert.equal(batches.length,3);
  for(const batch of batches)assert.equal(helperSyncSchema.safeParse(batch).success,true);
  assert.equal(helperSyncSchema.safeParse(payload).success,false);
  for(const stream of ['history','reviews','captures'] as const) {
    assert.deepEqual(batches.flatMap(batch=>batch[stream]).map(row=>row.sourceId),payload[stream].map(row=>row.sourceId));
  }
});

test('imported review storage identity is stable across retries and isolated by owner/helper/source',()=>{
  const id=importedReviewId('owner','helper','source');
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(importedReviewId('owner','helper','source'),id);
  for(const key of [['other','helper','source'],['owner','other','source'],['owner','helper','other']]) {
    assert.notEqual(importedReviewId(key[0],key[1],key[2]),id);
  }
});
