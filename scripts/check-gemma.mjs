import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { scriptLlm } from './llm-runtime.mjs';
import { warmTranslation } from '../server/translation.mjs';
import { structuredChat,modelPlacement } from '../server/llm-client.mjs';
try{process.loadEnvFile();}catch(error){if(error.code!=='ENOENT')throw error;}
scriptLlm({ ollamaOnly: true });
const health=await(await fetch('http://127.0.0.1:3210/api/health')).json();
assert.ok(health.asr.ready&&!health.recording&&!health.processing,'ASR must be running and the app must be idle.');
const config={...scriptLlm(),ollamaUrl:scriptLlm().ollamaUrl,model:scriptLlm().model,signal:AbortSignal.timeout(180000)};
const show=await(await config.fetcher(config.ollamaUrl+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:config.model})})).json();
assert.ok(!show.error,show.error);
const began=performance.now();await warmTranslation(config);const warmMs=Math.round(performance.now()-began);
const query=performance.now();const response=await structuredChat({...config,timeoutMs:10000,format:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},messages:[{role:'user',content:'JSONのtextに「準備完了」と返してください。'}]});
assert.equal(response.text,'準備完了');const requestMs=Math.round(performance.now()-query);
let gpu=null;try{gpu=execFileSync('nvidia-smi',['--query-gpu=name,memory.used,memory.total','--format=csv,noheader'],{windowsHide:true,encoding:'utf8'}).trim();}catch{}
const report={createdAt:new Date().toISOString(),model:config.model,asr:health.asr,details:show.details,capabilities:show.capabilities,warmMs,requestMs,response,residency:await modelPlacement(config),gpu};
await mkdir('reports',{recursive:true});await writeFile('reports/gemma-readiness.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
