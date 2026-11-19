import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFECT_TYPES, defectTypeClass, matchesDefectType } from '../src/defect-types.js';

test('defect type filters retain legacy version issues and switch between the two values', () => {
  assert.deepEqual([...DEFECT_TYPES], ['版本问题', '线上问题']);
  assert.equal(matchesDefectType(undefined, ''), true);
  assert.equal(matchesDefectType(undefined, '版本问题'), true);
  assert.equal(matchesDefectType(undefined, '线上问题'), false);
  assert.equal(matchesDefectType('线上问题', '线上问题'), true);
  assert.equal(matchesDefectType('线上问题', '版本问题'), false);
  assert.equal(defectTypeClass('线上问题'), 'defect-type-online');
});
