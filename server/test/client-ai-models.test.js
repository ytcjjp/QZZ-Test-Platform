import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelReasoningEfforts, normalizeModelCatalog, resolveModelSelection, resolveReasoningSelection } from '../../client/src/ai-models.js';

test('model selection keeps supported xhigh and ultra choices and falls back when switching models', () => {
  const catalog = normalizeModelCatalog({ defaultModel: 'gpt-6.1-sol', models: [
    { id: 'gpt-6.1-sol', reasoningEfforts: ['xhigh', 'ultra'] },
    { id: 'gpt-xhigh-sol', reasoningEfforts: ['xhigh'] },
  ] }, 'gpt-6.1-sol', 'ultra');
  assert.deepEqual(modelReasoningEfforts('gpt-6.1-sol', catalog, 'ultra'), ['xhigh', 'ultra']);
  assert.equal(resolveReasoningSelection('ultra', 'gpt-xhigh-sol', catalog, 'ultra'), 'xhigh');
  assert.equal(resolveReasoningSelection('xhigh', 'gpt-6.1-sol', catalog, 'ultra'), 'xhigh');
  assert.equal(resolveModelSelection('not-available', catalog), 'gpt-6.1-sol');
  assert.deepEqual(normalizeModelCatalog(null, 'gpt-6.1-sol', 'ultra').models[0].reasoningEfforts, ['ultra']);
});
