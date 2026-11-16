import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadAiProvider, publicAiProvider, saveAiProvider } from '../ai-provider.js';

test('saved AI providers encrypt secrets, override legacy environment and survive a new process', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-ai-provider-'));
  try {
    const fixture = { mode: 'codex', apiKey: 'fixture-company-key', model: 'gpt-6.1-sol', reasoningEffort: 'ultra', baseUrl: 'https://gateway.example/v1/', wireApi: 'responses', projectRoot: directory };
    const publicValue = saveAiProvider(directory, fixture);
    assert.equal(publicValue.aiConfigured, true);
    assert.equal(publicValue.aiModel, 'gpt-6.1-sol');
    assert.equal(publicValue.aiReasoningEffort, 'ultra');
    assert.equal(publicValue.aiMode, 'codex');
    assert.equal(JSON.stringify(publicValue).includes(fixture.apiKey), false);
    const persisted = await fs.readFile(path.join(directory, 'ai-provider.json'), 'utf8');
    assert.equal(persisted.includes(fixture.apiKey), false);
    assert.equal(typeof JSON.parse(persisted).encryptedApiKey, 'string');
    assert.equal((await fs.readFile(path.join(directory, 'password-key'))).length, 32);
    const restored = loadAiProvider(directory, { AI_API_KEY: 'stale-key', AI_MODEL: 'stale-model', AI_BASE_URL: 'https://stale.example/v1/' });
    assert.equal(restored.apiKey, fixture.apiKey);
    assert.equal(restored.model, fixture.model);
    assert.equal(restored.baseUrl, fixture.baseUrl);
    assert.equal(JSON.stringify(publicAiProvider(restored)).includes(fixture.apiKey), false);
    const moduleUrl = new URL('../ai-provider.js', import.meta.url).href;
    const code = `import assert from 'node:assert/strict'; import {loadAiProvider,publicAiProvider} from ${JSON.stringify(moduleUrl)}; const provider=loadAiProvider(process.argv[1],{}); assert.equal(provider.apiKey,'fixture-company-key'); console.log(JSON.stringify(publicAiProvider(provider)));`;
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], { encoding: 'utf8', timeout: 10000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(restarted.stdout.includes(fixture.apiKey), false);
    assert.equal(JSON.parse(restarted.stdout).aiMode, 'codex');
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('environment-only providers keep legacy chat compatibility and expose no keys', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-ai-env-'));
  try {
    const provider = loadAiProvider(directory, { AI_API_KEY: 'env-fixture', AI_MODEL: 'legacy-model', AI_BASE_URL: 'https://gateway.example/v1/' });
    assert.equal(provider.mode, 'api');
    assert.equal(provider.wireApi, 'chat');
    assert.equal(provider.apiKey, 'env-fixture');
    assert.equal(provider.model, 'legacy-model');
    assert.equal(JSON.stringify(publicAiProvider(provider)).includes('env-fixture'), false);
    assert.equal(publicAiProvider(loadAiProvider(directory, {})).aiConfigured, false);
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
