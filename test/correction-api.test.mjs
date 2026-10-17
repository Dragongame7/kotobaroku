import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createApplication } from '../server/app.mjs';
const raw = '天気がいいので選択しようと思います。', corrected = raw.replace('選択', '洗濯');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const start = Date.now(); while (!predicate()) { if (Date.now()-start > 5000) throw Error('timeout'); await pause(5); } }
test('HTTP and normal-recording correction share Gemma, reject other models, preserve raw and lock during drain', async t => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type','application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ ready:true, models:[{ name:'gemma4:latest', size:100,size_vram:100 }] })); return; }
    const chunks=[]; for await (const chunk of req) chunks.push(chunk); const body=JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (!body.messages?.length) { res.end('{}'); return; }
    if (body.format) { await pause(50); res.end(JSON.stringify({message:{content:JSON.stringify(body.format.properties.nearSynonym ? {nearSynonym:false} : {text:corrected})}})); return; }
    res.end(JSON.stringify({message:{content:'Laundry.'}})+'\n'+JSON.stringify({done:true})+'\n');
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening'); const url=`http://127.0.0.1:${upstream.address().port}`;
  const asr = new WebSocketServer({server:upstream}); asr.on('connection', socket => {socket.send('{"type":"session.created"}');socket.on('message',(data,binary)=>{if(binary){socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:raw}));return;}const event=JSON.parse(data.toString()); if(event.type==='session.update')socket.send('{"type":"session.updated"}'); if(event.type==='input_audio_buffer.commit')socket.send('{"type":"input_audio_buffer.committed"}');});});
  const application=createApplication({model:'gemma4:latest',asrUrl:url,ollamaUrl:url}); application.server.listen(0,'127.0.0.1');await once(application.server,'listening'); const base=`http://127.0.0.1:${application.server.address().port}`;
  t.after(async()=>{application.cancelProcessing();for(const c of application.sockets.clients)c.terminate();for(const c of asr.clients)c.terminate();asr.close();application.sockets.close();application.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>application.server.close(r)),new Promise(r=>upstream.close(r))]);});
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/correct',{text:raw,model:'qwen3.5:4b'})).status,400);
  const response=await post('/api/correct',{text:raw}); const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(events[0].correction.correctedSource,corrected);assert.equal(events[0].rawSource,raw);
  const client=new WebSocket(base.replace('http:','ws:')+'/ws/transcribe');const messages=[];
  client.on('message',data=>{const e=JSON.parse(data.toString());messages.push(e);if(e.type==='session.created')client.send(JSON.stringify({type:'session.update',session:{language:'ja-JP',sample_rate:16000},captions:{correctionMode:'conservative'}}));});
  await until(()=>messages.some(e=>e.type==='session.updated'));client.send(Buffer.alloc(3200));await until(()=>messages.some(e=>e.type==='caption.segment')); client.send('{"type":"input_audio_buffer.commit"}');
  await until(()=>messages.some(e=>e.type==='input_audio_buffer.committed'));
  assert.equal((await post('/api/process',{text:'blocked'})).status,409);
  await until(()=>messages.some(e=>e.type==='caption.finished'));assert.equal(messages.find(e=>e.type==='caption.correction').correction.correctedSource,corrected);
  assert.ok(requests.every(body=>body.model==='gemma4:latest'));assert.ok(!requests.some(body=>body.stream===true));
  await until(()=>client.readyState===WebSocket.CLOSED);
  const h=await(await fetch(base+'/api/health')).json();assert.equal(h.processing,false);assert.equal(h.translation.defaultModel,'gemma4:latest');
});
