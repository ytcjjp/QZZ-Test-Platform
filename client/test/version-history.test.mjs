import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CURRENT_VERSION, VERSION_HISTORY } from '../src/version-history.js';

test('sidebar version matches package and every historical entry has release notes', () => {
  const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert.equal(CURRENT_VERSION, packageVersion);
  assert.equal(VERSION_HISTORY[0].version, CURRENT_VERSION);
  assert.deepEqual(new Set(VERSION_HISTORY.map(({ version }) => version)).size, VERSION_HISTORY.length);
  assert.ok(VERSION_HISTORY.some(({ version }) => version === '0.1.0'));
  for (const { version, date, summary } of VERSION_HISTORY) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(summary.length > 0);
  }
});
