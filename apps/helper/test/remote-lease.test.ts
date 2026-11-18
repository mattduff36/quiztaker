import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteBroker} from '../src/remote.js';
import type {RemoteBrowser} from '../src/remote-browser.js';

test('relay outage cannot retain local automation reservation beyond the server lease',async()=>{
  let now=1000,calls=0;
  const browser={clear(){}} as unknown as RemoteBrowser;
  const broker=new RemoteBroker('fixture',async()=>{
    if(++calls>1)throw new Error('Relay unavailable');
    return {sessions:[],manualReserved:true,leaseUntil:2000};
  },()=>true,()=>{},browser,()=>now);
  try{
    broker.start();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(broker.blocksAutomation,true);
    now=2001;
    assert.equal(broker.blocksAutomation,false,'local expiry releases polling even without a successful exchange');
  }finally{broker.stop();}
});
