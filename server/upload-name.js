import path from 'node:path';

export function uploadFilename(value, fallback = '上传文档') {
  let name = typeof value === 'string' && value ? value : fallback;
  if ([...name].every((character) => character.codePointAt(0) <= 255)) {
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')); }
    catch { /* Keep valid names supplied with a different header encoding. */ }
  }
  return path.win32.basename(path.posix.basename(name)).replace(/[\x00-\x1f]/g, '').slice(0, 200) || fallback;
}
