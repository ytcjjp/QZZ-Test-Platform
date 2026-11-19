export const DEFECT_TYPES = Object.freeze(['版本问题', '线上问题']);

export function defectTypeClass(value) {
  return value === '线上问题' ? 'defect-type-online' : 'defect-type-version';
}

export function matchesDefectType(value, selected) {
  return !selected || (value || '版本问题') === selected;
}
