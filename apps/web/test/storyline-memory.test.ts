import test from 'node:test';
import assert from 'node:assert/strict';
import {withAuthoredMaterials} from '../src/lib/learner-memory';
test('Storyline narration memory is publication scoped, source labelled and rejects another host or root',()=>{
 const root='https://content-na2prd0004-na2hp.sabacloud.com/content/learning/fixture%3D/';
 const source={url:root+'story_content/one_captions.js',title:'Narration',text:'A fact from the authenticated course narration. '.repeat(4)};
 const snapshot={url:root+'index_lms.html',sourcePublication:root+'index_lms.html',sourceMaterials:[source]};
 assert.equal(withAuthoredMaterials([],snapshot)[0].url,source.url);
 assert.throws(()=>withAuthoredMaterials([],{...snapshot,sourceMaterials:[{...source,url:root.replace('fixture%3D','other')+'story_content/one_captions.js'}]}),/Invalid authored material source/);
 const external='https://evil.invalid/content/learning/fixture%3D/index_lms.html';
 assert.throws(()=>withAuthoredMaterials([],{...snapshot,url:root+'../../rcs/remote_frameset_modern.html?sco_url='+encodeURIComponent(external)}),/Invalid authored publication scope/);
 assert.throws(()=>withAuthoredMaterials([],{...snapshot,url:'https://evil.invalid/course'}),/Invalid authored publication scope/);
});
