import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelCatalog, resolveModelSelection } from '../src/ai-models.js';

test('model catalog keeps available choices and a saved per-demand selection', () => {
  const catalog = normalizeModelCatalog({
    defaultModel: 'gpt-6.1-sol',
    models: [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }, { id: 'gpt-6-sol', label: 'gpt-6-sol' }],
  }, 'gpt-6.1-sol');
  assert.equal(resolveModelSelection('gpt-6-sol', catalog), 'gpt-6-sol');
  assert.equal(resolveModelSelection('removed-model', catalog), 'gpt-6.1-sol');
});

test('unavailable discovery falls back to the configured model without unsafe IDs', () => {
  assert.deepEqual(normalizeModelCatalog(null, 'gpt-6.1-sol'), {
    models: [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', reasoningEfforts: ['ultra'] }], defaultModel: 'gpt-6.1-sol',
  });
  const catalog = normalizeModelCatalog({ models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-sol' }, { id: 'bad model\nkey' }] }, 'gpt-6.1-sol');
  assert.deepEqual(catalog.models, [{ id: 'gpt-6-sol', label: 'gpt-6-sol', reasoningEfforts: ['ultra'] }]);
  assert.equal(catalog.defaultModel, 'gpt-6-sol');
});
