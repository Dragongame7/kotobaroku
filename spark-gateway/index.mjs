import { createSparkGateway } from './app.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const gateway = createSparkGateway({ apiKey: process.env.GATEWAY_API_KEY, asrUrl: process.env.GATEWAY_ASR_URL, llmUrl: process.env.GATEWAY_LLM_URL, asrApiKey: process.env.GATEWAY_ASR_API_KEY, llmApiKey: process.env.GATEWAY_LLM_API_KEY, diarization: process.env.GATEWAY_DIARIZATION !== 'false', runtime: { llmModel: process.env.MODEL_ID, llmRevision: process.env.MODEL_REVISION, speech: 'NeMo-Speech.cpp 0.2.0' } });
gateway.server.listen(Number(process.env.GATEWAY_PORT || 8001), process.env.GATEWAY_HOST || '127.0.0.1', () => console.log('ことば録 Sparkゲートウェイを起動しました。'));
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { void gateway.close().then(() => process.exit()); });
