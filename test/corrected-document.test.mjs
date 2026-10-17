import test from 'node:test';
import assert from 'node:assert/strict';
import { correctedDocument } from '../src/corrections.ts';
const raw='天気がいいので選択します。',corrected=raw.replace('選択','洗濯');
const row={id:'new:1',source:raw,correction:{status:'applied',correctedSource:corrected,edits:[{from:'選択',to:'洗濯',start:7,end:9,reason:'同音語'}]}};
test('correction mapping preserves Unicode and display whitespace outside the replacement',()=>{
  const text='😀\n天気がいいので選択します。';
  assert.equal(correctedDocument(text,[row]),text.replace('選択','洗濯'));
});
test('resumed recording never applies its correction to an identical sentence in an edited draft',()=>{
  const draft='😀 '+raw+' \n';const document=draft.trimEnd()+'\n'+raw;
  const old={...row,id:'old:1',stale:true};
  const appended={...row,documentOffset:draft.replace(/\s/gu,'').length};
  const result=correctedDocument(document,[old,appended]);
  assert.equal(result,draft.trimEnd()+'\n'+corrected);
  assert.equal(correctedDocument(document,JSON.parse(JSON.stringify([old,appended]))),result);
});
