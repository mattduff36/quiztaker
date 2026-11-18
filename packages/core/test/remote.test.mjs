import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteKeys,deriveRemoteKey,sealRemote,openRemote,validSealedRemote,assertRemoteInput,safeRemoteUrl,supportsRemoteHelper} from '../dist/remote.js';
test('live browser requires a compatible installed helper',()=>{
  for(const version of [undefined,'1.0.47','1.0.46','1.0.8','unknown'])assert.equal(supportsRemoteHelper(version),false);
  for(const version of ['1.0.48','1.1.0','2.0.0'])assert.equal(supportsRemoteHelper(version),true);
});
const context={helperId:'helper',sessionId:'viewer-session',clientId:'mobile'};
test('ECDH endpoints encrypt inputs; AAD, expiry, sequence, direction and ciphertext tampering fail closed',async()=>{
  const viewer=await createRemoteKeys(),helper=await createRemoteKeys();
  const a=await deriveRemoteKey(viewer.privateKey,helper.publicKey),b=await deriveRemoteKey(helper.privateKey,viewer.publicKey);
  const now=Date.now(),payload={type:'type',text:'fixture-login-text'};
  const encrypted=await sealRemote(a,context,'input',1,payload,now);
  assert.equal(JSON.stringify(encrypted).includes(payload.text),false);
  assert.deepEqual(await openRemote(b,context,'input',encrypted,0,now),payload);
  for(const changed of [{...context,helperId:'other'},{...context,sessionId:'other'},{...context,clientId:'other'}])
    await assert.rejects(openRemote(b,changed,'input',encrypted,0,now));
  await assert.rejects(openRemote(b,context,'frame',encrypted,0,now));
  await assert.rejects(openRemote(b,context,'input',encrypted,1,now),/replayed/);
  await assert.rejects(openRemote(b,context,'input',encrypted,0,now+8000),/expired/);
  await assert.rejects(openRemote(b,context,'input',{...encrypted,seq:2},0,now));
  await assert.rejects(openRemote(b,context,'input',{...encrypted,expiresAt:encrypted.expiresAt-1},0,now));
  await assert.rejects(openRemote(b,context,'input',{...encrypted,ciphertext:'AAAA'+encrypted.ciphertext.slice(4)},0,now));
  assert.equal(validSealedRemote({...encrypted,ciphertext:'A'.repeat(900001)},now),false);
  await assert.rejects(sealRemote(a,context,'frame',2,'x'.repeat(650001)),/too large/);
  await assert.rejects(crypto.subtle.exportKey('jwk',viewer.privateKey));
});
test('input has an explicit narrow allowlist, bounded text, safe geometry and HTTPS navigation',()=>{
  const base={frameId:'f',tabId:'t',geometry:{width:100,height:100,dpr:1,scrollX:0,scrollY:0,url:'https://course.invalid'}};
  for(const action of [{type:'evaluate',source:'alert(1)'},{type:'key',key:'Control+L'},{type:'tap',x:100,y:1},
    {type:'scroll',x:0,y:2001},{type:'type',text:'x'.repeat(4001)},{type:'navigate',url:'https://user:password@example.com'}])
    assert.throws(()=>assertRemoteInput({...base,...action}));
  assertRemoteInput({...base,type:'key',key:'Tab'});
  for(const type of ['back','forward','reload'])assertRemoteInput({...base,type});
  for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://localhost','https://x.local','https://example.com:8443','javascript:alert(1)'])assert.equal(safeRemoteUrl(url),false,url);
  assert.equal(safeRemoteUrl('https://course.invalid/lesson'),true);
});
