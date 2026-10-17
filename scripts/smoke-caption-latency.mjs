import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LiveTranslation } from '../server/translation.mjs';
import { scriptLlm } from './llm-runtime.mjs';
const base='http://127.0.0.1:3210';
const health=await(await fetch(base+'/api/health')).json();
assert.ok(!health.recording&&!health.processing,'Stop recording and processing first.');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const started=Date.now();while(!predicate()){if(Date.now()-started>90000)throw Error('Latency smoke timeout');await pause(20);}}
const scenarios=[];
for(const sentenceMode of ['speed','balanced','context'])for(const correctionMode of ['off','conservative'])for(const punctuation of [true,false]){
  const source=punctuation?'天気がいいので選択しようと思います。':'天気がいいので選択しようと思っているので';
  const controller=new AbortController();const events=[];let finished=false;let activity;
  const live=new LiveTranslation({...scriptLlm(),ollamaUrl:scriptLlm().ollamaUrl,model:health.defaultModel,sourceLanguage:'ja-JP',targetLanguage:'en-US',sentenceMode,correctionMode,signal:controller.signal,emit:event=>events.push(event),drained:()=>{finished=true;}});
  try{
    await live.warm();const began=Date.now();live.enqueue(source);activity=setInterval(()=>live.activity(),100);
    await until(()=>events.some(event=>event.type==='translation.completed'&&!event.provisional));
    clearInterval(activity);live.finishInput();await until(()=>finished);
    const rows=[...live.rows.values()];assert.equal(rows.map(row=>row.rawSource).join(''),source);assert.ok(rows.every(row=>row.status==='done'));
    assert.equal(rows[0].boundary,punctuation?'sentence':'time');
    if(punctuation)assert.ok(rows[0].timing.finalizedAt-rows[0].timing.sourceReceivedAt<500,'Explicit full stop should finalize immediately.');
    if(correctionMode==='off')assert.ok(rows.every(row=>row.correction.status==='off'));
    assert.ok(!events.some(event=>event.type==='translation.error'));
    const report={sentenceMode,correctionMode,punctuation,elapsedMs:Date.now()-began,residency:live.residency,rows};scenarios.push(report);
    console.log(sentenceMode,correctionMode,punctuation?'full stop':'no punctuation',JSON.stringify(rows.map(row=>({boundary:row.boundary,correction:row.correction.status,timing:row.timing}))));
  }finally{clearInterval(activity);controller.abort();}
}
await mkdir('reports',{recursive:true});await writeFile('reports/caption-latency.json',JSON.stringify({createdAt:new Date().toISOString(),model:health.defaultModel,note:'Simulated finalized ASR text with real Gemma. Source receipt timing excludes microphone, acoustic inference and endpointing.',scenarios},null,2));
console.log('Three sentence modes, correction ON/OFF and punctuation/no punctuation passed.');
