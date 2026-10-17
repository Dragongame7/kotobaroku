import { createApplication } from './app.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const { server } = createApplication();
const port = Number(process.env.PORT || 3210);
server.listen(port, '127.0.0.1', () => console.log(`ことば録: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
