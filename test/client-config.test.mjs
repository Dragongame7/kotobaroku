import test from 'node:test';
import assert from 'node:assert/strict';
import { clientConfig, applyClientDefaults } from '../scripts/client-config.mjs';

test('shared client configuration preserves a gateway prefix for both speech and LLM', () => {
  const config = clientConfig({ gatewayUrl: 'https://dgx.example/kotoba/', model: 'team-model' });
  const env = {}; applyClientDefaults(config, env);
  assert.equal(env.SPEECH_MODE, 'spark'); assert.equal(env.SPEECH_URL, 'https://dgx.example/kotoba/speech');
  assert.equal(env.LLM_BASE_URL, 'https://dgx.example/kotoba/v1'); assert.equal(env.LLM_MODEL, 'team-model');
  assert.equal(env.SPEAKER_DIARIZATION, 'true'); assert.equal(env.LLM_DISABLE_THINKING, 'false');
});
test('shared distribution configuration rejects credentials and invalid addresses', () => {
  for (const invalid of [{ apiKey: 'must-not-be-distributed' }, { gatewayUrl: 'https://user:password@host' }, { gatewayUrl: 'https://host?key=secret' }, { gatewayUrl: 'file:///C:/data' }, { port: 80 }, { inputProfile: 'invalid' }, { disableThinking: 'false' }]) assert.throws(() => clientConfig(invalid));
});
test('personal startup overrides are retained and no API key is generated', () => {
  const env = { PORT: '3212', LLM_MODEL: 'personal-model', LLM_API_KEY: 'personal-key' };
  applyClientDefaults(clientConfig(), env);
  assert.equal(env.PORT, '3212'); assert.equal(env.LLM_MODEL, 'personal-model'); assert.equal(env.LLM_API_KEY, 'personal-key');
  assert.equal(env.SPEECH_API_KEY, undefined);
});
