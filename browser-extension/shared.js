export const LIMITS = Object.freeze({ text: 100000, images: 64, imageBytes: 64 * 1024 * 1024, pixels: 40000000, jobMs: 165000 });
const documents = ['feishu.cn', 'larksuite.com'];
const assets = [...documents, 'feishucdn.com', 'larksuitecdn.com'];
const matches = (host, roots) => roots.find((root) => host === root || host.endsWith(`.${root}`));

export function platformPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeError('CONFIG_INVALID');
  return port;
}

export function documentURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('UNSUPPORTED'); }
  const family = matches(url.hostname, documents);
  if (!family || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !/^\/(?:docx|docs|wiki)\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname)) throw new BridgeError('UNSUPPORTED');
  return { url: `${url.origin}${url.pathname}`, family };
}

export function assetURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('IMAGE_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !matches(url.hostname, assets)) throw new BridgeError('IMAGE_UNAVAILABLE');
  return url.href;
}

const messages = {
  CONFIG_INVALID: '请输入 1–65535 范围内的平台端口。', PAIRING_INVALID: '配对码无效或已过期，请在平台重新生成。',
  AUTH_REQUIRED: '请先完成平台配对。', AUTH_INVALID: '配对已失效，请重新生成配对码。',
  CONNECTION_FAILED: '无法连接本机平台，请确认服务器已启动且端口正确。', DISCONNECTED: '与本机平台的连接已断开，正在重新连接。',
  LOGIN_REQUIRED: '请先在此 Chrome 中登录飞书，再重新导入。', ACCESS_DENIED: '当前账号无阅读权限，或文档禁止复制，请申请权限或补充文件。',
  UNSUPPORTED: '暂未识别可读取的飞书正文，请改用文档文件导入。', NETWORK_ERROR: '飞书页面网络异常，请稍后重试。',
  TIMEOUT: '读取飞书页面超时，请稍后重试或改用文件导入。', CANCELLED: '本次读取已取消。', TAB_CLOSED: '读取标签页已关闭，请重新导入。',
  PROTOCOL_ERROR: '平台连接协议异常，请更新扩展或重新配对。', IMAGE_UNAVAILABLE: '部分图片无法正常读取，请补充图片附件。',
};
export class BridgeError extends Error {
  constructor(code) { super(messages[code] || messages.UNSUPPORTED); this.code = Object.hasOwn(messages, code) ? code : 'UNSUPPORTED'; }
}
export const publicError = (error) => ({ code: error instanceof BridgeError ? error.code : 'UNSUPPORTED', message: error instanceof BridgeError ? error.message : messages.UNSUPPORTED });

export function imageMime(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) return 'image/gif';
  throw new BridgeError('IMAGE_UNAVAILABLE');
}

export function toBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}

export async function prepareImage(entry, remaining, { signal, fetcher = fetch, decode = createImageBitmap, canvas = (w, h) => new OffscreenCanvas(w, h) } = {}) {
  let bytes;
  if (entry.data) {
    if (typeof entry.data !== 'string' || entry.data.length > Math.ceil(remaining / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) throw new BridgeError('IMAGE_UNAVAILABLE');
    bytes = Uint8Array.from(atob(entry.data), (character) => character.charCodeAt(0));
  } else {
    const url = assetURL(entry.src);
    const response = await fetcher(url, { credentials: 'include', redirect: 'error', signal });
    if (!response.ok || response.redirected || !/^image\/(?:png|jpe?g|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new BridgeError('IMAGE_UNAVAILABLE');
    const chunks = []; let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new BridgeError('IMAGE_UNAVAILABLE');
    try {
      while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        total += chunk.length;
        if (total > remaining) { await reader.cancel().catch(() => {}); throw new BridgeError('IMAGE_UNAVAILABLE'); }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  if (!bytes.length || bytes.length > remaining) throw new BridgeError('IMAGE_UNAVAILABLE');
  let mimeType = imageMime(bytes);
  const bitmap = await decode(new Blob([bytes], { type: mimeType }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > LIMITS.pixels) throw new BridgeError('IMAGE_UNAVAILABLE');
    const animated = mimeType === 'image/gif';
    if (animated) {
      const target = canvas(bitmap.width, bitmap.height); target.getContext('2d').drawImage(bitmap, 0, 0);
      bytes = new Uint8Array(await (await target.convertToBlob({ type: 'image/png' })).arrayBuffer()); mimeType = imageMime(bytes);
      if (mimeType !== 'image/png' || bytes.length > remaining) throw new BridgeError('IMAGE_UNAVAILABLE');
    }
    return { image: { name: `${entry.id || 'file'}.${mimeType.split('/')[1]}`, mimeType, data: toBase64(bytes) }, bytes: bytes.length, animated };
  } finally { bitmap.close?.(); }
}
