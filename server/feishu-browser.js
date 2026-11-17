import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';

export const FEISHU_BROWSER_WS_PATH = '/api/feishu-browser/events';
export const FEISHU_BROWSER_LIMITS = Object.freeze({ text: 100000, images: 64, imageBytes: 64 * 1024 * 1024, imagePixels: 40000000, pending: 2 });
const EXTENSION_ID = /^[a-p]{32}$/;
const PARTIAL_WARNING = '浏览器仅采集到部分文档内容；未读取的图片、折叠块或未加载区域不属于本次分析依据，请补充原件或正文。';
const controlledFailures = {
  ACCESS_DENIED: ['服务器 Chrome 当前账号没有此文档的访问权限，请先在浏览器中确认授权。', 403],
  LOGIN_REQUIRED: ['服务器 Chrome 尚未登录飞书，请在服务器浏览器中登录后重试。', 422],
  UNSUPPORTED: ['此飞书页面暂不支持浏览器采集，请下载原件或补充正文。', 422],
  PARTIAL: ['未能采集到可用的完整文档内容，请下载原件或补充正文。', 422],
  TIMEOUT: ['浏览器读取飞书文档超时，请稍后重试或下载原件。', 504],
  CANCELLED: ['浏览器读取已取消。', 499],
  NETWORK_ERROR: ['飞书页面网络异常，请稍后重试或下载原件。', 502],
  TAB_CLOSED: ['浏览器读取标签页已关闭，请重新导入。', 422],
};

export class FeishuBrowserError extends Error {
  constructor(message, status = 422, code = 'browser_import_error') { super(message); this.name = 'FeishuBrowserError'; this.status = status; this.code = code; this.publicMessage = message; }
}
const failure = (message, status = 422, code) => new FeishuBrowserError(message, status, code);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function sameSecret(value, expected) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(expected || '') && crypto.timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex')); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return plain(value) && Object.keys(value).every((key) => allowed.includes(key)); }

export function normalizeFeishuBrowserUrl(value) {
  let url;
  if (typeof value !== 'string' || value.length > 2048) throw failure('请输入有效的飞书文档地址。', 400);
  try { url = new URL(value); } catch { throw failure('请输入有效的飞书文档地址。', 400); }
  const host = url.hostname.toLowerCase();
  const family = host === 'feishu.cn' || host.endsWith('.feishu.cn') ? 'feishu' : host === 'larksuite.com' || host.endsWith('.larksuite.com') ? 'lark' : null;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !family || !/^\/(docx|docs|wiki)\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname)) throw failure('只支持 HTTPS 飞书 / Lark 的 docx、docs 或 wiki 文档地址。', 400);
  // Tracking parameters and fragments are not required to read a document.
  url.search = ''; url.hash = '';
  return { url: url.href, family };
}

function localHost(value) {
  const match = typeof value === 'string' && value.match(/^(?:127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/);
  return Boolean(match && (!match[1] || Number(match[1]) <= 65535));
}
const localAddress = (value) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
function warnings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80 || value.some((item) => typeof item !== 'string' || item.length > 1000)) throw failure('浏览器返回的提示格式不正确。');
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

async function checkedDocument(value, source, isActive = () => true) {
  const active = () => { if (!isActive()) throw new DOMException('读取已取消', 'AbortError'); };
  active();
  if (!keys(value, ['url', 'title', 'text', 'completeness', 'warnings', 'loadedBlocks', 'images', 'imagesDetected', 'imagesIncluded'])) throw failure('浏览器返回了不支持的文档数据。');
  const final = normalizeFeishuBrowserUrl(value.url);
  if (final.family !== source.family) throw failure('文档跳转到不同的飞书服务，已停止读取。');
  if (typeof value.text !== 'string' || value.text.length > FEISHU_BROWSER_LIMITS.text) throw failure('浏览器文档文字超过 10 万字符或格式无效，请拆分后导入。', 413);
  if (typeof value.title !== 'string' || value.title.length > 300 || !['complete', 'partial'].includes(value.completeness)) throw failure('浏览器未明确报告文档名称或采集完整性。');
  const notes = warnings(value.warnings);
  for (const key of ['loadedBlocks', 'imagesDetected', 'imagesIncluded']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1000000)) throw failure('浏览器返回的采集数量无效。');
  const images = value.images ?? [];
  if (!Array.isArray(images) || images.length > FEISHU_BROWSER_LIMITS.images) throw failure('文档图片超过单轮 64 张限制，请拆分后导入。', 413);
  let bytes = 0;
  const checkedImages = [];
  for (const image of images) {
    active();
    if (!keys(image, ['name', 'mimeType', 'data']) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || typeof image.data !== 'string' || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw failure('浏览器返回的图片数据无效。');
    if ((bytes += Buffer.byteLength(image.data, 'base64')) > FEISHU_BROWSER_LIMITS.imageBytes) throw failure('文档图片总量超过 64 MiB，请拆分后导入。', 413);
    if (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 200)) throw failure('浏览器返回的图片名称无效。');
    const buffer = Buffer.from(image.data, 'base64');
    try {
      const metadata = await sharp(buffer, { limitInputPixels: FEISHU_BROWSER_LIMITS.imagePixels, failOn: 'warning', pages: 1 }).metadata();
      if ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[metadata.format] !== image.mimeType) throw new Error('format');
    } catch { throw failure('文档图片损坏、格式不符或超过 4000 万像素，请改用原件导入。'); }
    active();
    checkedImages.push({ name: image.name || `文档图片-${checkedImages.length + 1}`, mimeType: image.mimeType, buffer });
  }
  if (!value.text.trim() && !checkedImages.length) throw failure('未从文档采集到可读正文或图片；请确认登录、访问权限和页面是否加载完成。');
  const incomplete = value.completeness === 'partial' || value.imagesDetected !== undefined && value.imagesDetected > checkedImages.length || value.imagesIncluded !== undefined && value.imagesIncluded !== checkedImages.length;
  if (incomplete) notes.push(PARTIAL_WARNING);
  return { name: value.title.trim().replace(/[\x00-\x1f]/g, '').slice(0, 200) || '飞书文档', text: value.text.trim(), warnings: [...new Set(notes)], completeness: incomplete ? 'partial' : 'complete', images: checkedImages };
}

export function createFeishuBrowserService({ dataDir, timeoutMs = 180000, pairingTtlMs = 300000, authTimeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(dataDir || '') || ![timeoutMs, pairingTtlMs, authTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid browser service configuration');
  fs.mkdirSync(dataDir, { recursive: true });
  const credentialsFile = path.join(dataDir, 'feishu-browser.json');
  let credentials = null; let configError = false; let pairing = null; let bridge = null; let closed = false; let lastSeen = null;
  try {
    if (fs.existsSync(credentialsFile)) {
      const saved = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      if (saved.disconnectedAt) credentials = null;
      else if (saved.version === 1 && EXTENSION_ID.test(saved.extensionId) && /^[a-f0-9]{64}$/.test(saved.tokenHash) && typeof saved.pairedAt === 'string') credentials = saved;
      else configError = true;
    }
  } catch { configError = true; }
  const jobs = new Map(); const byUser = new Map(); const unauthenticated = new Set(); const attempts = [];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 92 * 1024 * 1024, perMessageDeflate: false });
  function persist(value) {
    const temporary = `${credentialsFile}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, credentialsFile); }
    catch { throw failure('浏览器配对记录无法保存，请检查服务器数据目录权限。', 503); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function send(ws, data) { if (ws?.readyState === 1) ws.send(JSON.stringify(data)); }
  function settle(job, error, result) {
    if (!jobs.delete(job.id)) return;
    byUser.delete(job.userId); clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  }
  function rejectPending(error) { for (const job of [...jobs.values()]) settle(job, error); }
  function deny(ws, code, message) { send(ws, { type: 'error', code, message }); ws.close(1008, 'Browser authentication failed'); }
  function authenticate(ws) {
    const old = bridge; bridge = ws; lastSeen = new Date().toISOString();
    if (old && old !== ws) { rejectPending(failure('浏览器连接已被新连接替换，请重新导入。', 503)); old.close(1000, 'Browser replaced'); }
    unauthenticated.delete(ws); clearTimeout(ws.authTimer); ws.authenticated = true;
  }
  wss.on('connection', (ws, req, extensionId) => {
    ws.extensionId = extensionId; unauthenticated.add(ws);
    ws.authTimer = setTimeout(() => deny(ws, 'AUTH_REQUIRED', '请先完成浏览器配对。'), authTimeoutMs); ws.authTimer.unref?.();
    ws.on('message', async (raw, binary) => {
      try {
        if (binary || !ws.authenticated && raw.length > 4096) return deny(ws, 'PROTOCOL_ERROR', '浏览器消息格式不正确。');
        let value; try { value = JSON.parse(raw.toString('utf8')); } catch { return deny(ws, 'PROTOCOL_ERROR', '浏览器消息格式不正确。'); }
        if (!plain(value)) return deny(ws, 'PROTOCOL_ERROR', '浏览器消息格式不正确。');
        if (!ws.authenticated) {
          const now = Date.now(); while (attempts.length && attempts[0] < now - 60000) attempts.shift();
          if (attempts.length >= 30) return deny(ws, 'AUTH_INVALID', '配对尝试过多，请稍后重试。');
          if (value.type === 'pair' && keys(value, ['type', 'code', 'client'])) {
            const code = typeof value.code === 'string' ? value.code.trim().toUpperCase() : '';
            if (!pairing || pairing.expiresAt <= now || !/^[A-F0-9]{12}$/.test(code) || !sameSecret(code, pairing.hash)) { attempts.push(now); return deny(ws, 'PAIRING_INVALID', '配对码无效或已过期，请管理员重新生成。'); }
            const token = crypto.randomBytes(32).toString('base64url');
            const saved = { version: 1, extensionId, tokenHash: digest(token), pairedAt: new Date().toISOString() };
            persist(saved); credentials = saved; configError = false; pairing = null;
            authenticate(ws); send(ws, { type: 'paired', token }); return;
          }
          if (value.type === 'auth' && keys(value, ['type', 'token']) && credentials?.extensionId === extensionId && typeof value.token === 'string' && value.token.length <= 200 && sameSecret(value.token, credentials.tokenHash)) { authenticate(ws); send(ws, { type: 'ready' }); return; }
          attempts.push(now); return deny(ws, 'AUTH_INVALID', '浏览器凭据无效，请重新配对。');
        }
        if (ws !== bridge) return deny(ws, 'AUTH_INVALID', '此浏览器连接已失效。');
        lastSeen = new Date().toISOString();
        if (value.type === 'ping' && keys(value, ['type'])) { send(ws, { type: 'pong' }); return; }
        if (value.type === 'pong' && keys(value, ['type'])) return;
        if (value.type !== 'result' || !keys(value, ['type', 'taskId', 'ok', 'document', 'error']) || typeof value.taskId !== 'string') return deny(ws, 'PROTOCOL_ERROR', '浏览器消息格式不正确。');
        const job = jobs.get(value.taskId);
        if (!job || job.receiving) return;
        job.receiving = true;
        if (value.ok !== true) {
          const known = Object.hasOwn(controlledFailures, value.error?.code);
          const details = known ? controlledFailures[value.error.code] : ['浏览器未能读取文档，请确认登录和权限，或下载原件导入。', 422];
          settle(job, failure(details[0], details[1], known ? value.error.code : 'browser_read_failed')); return;
        }
        try { settle(job, null, await checkedDocument(value.document, job.source, () => jobs.get(job.id) === job)); }
        catch (error) { settle(job, error instanceof FeishuBrowserError ? error : failure('浏览器返回的文档数据无效。')); }
      } catch (error) { deny(ws, 'PROTOCOL_ERROR', error instanceof FeishuBrowserError ? error.publicMessage : '浏览器连接处理失败，请重新配对。'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(ws.authTimer); unauthenticated.delete(ws);
      if (bridge === ws) { bridge = null; rejectPending(failure('服务器浏览器连接已断开，请重新连接后导入。', 503)); }
    });
  });
  function pair() {
    if (closed) throw failure('浏览器连接服务已关闭。', 503);
    if (credentials || bridge || jobs.size || unauthenticated.size) disconnect();
    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    pairing = { hash: digest(code), expiresAt: Date.now() + pairingTtlMs };
    return { pairingCode: code, expiresAt: new Date(pairing.expiresAt).toISOString(), expiresInSeconds: Math.ceil(pairingTtlMs / 1000), webSocketPath: FEISHU_BROWSER_WS_PATH };
  }
  function status() { return { paired: Boolean(credentials), connected: Boolean(bridge?.readyState === 1), pairingPending: Boolean(pairing && pairing.expiresAt > Date.now()), pending: jobs.size, pairedAt: credentials?.pairedAt || null, lastSeen, configError, browser: 'Chrome', localOnly: true }; }
  function handleUpgrade(req, socket, head) {
    let pathname; try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return false; }
    if (pathname !== FEISHU_BROWSER_WS_PATH) return false;
    const extensionId = typeof req.headers.origin === 'string' && req.headers.origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
    const pairingOpen = pairing && pairing.expiresAt > Date.now();
    if (closed || req.url !== FEISHU_BROWSER_WS_PATH || !localAddress(req.socket.remoteAddress) || !localHost(req.headers.host) || !extensionId || !pairingOpen && credentials?.extensionId !== extensionId || unauthenticated.size >= 4) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, extensionId)); return true;
  }
  function read(value, { signal, requester } = {}) {
    let source;
    try {
      source = normalizeFeishuBrowserUrl(value);
      const userId = typeof requester === 'string' ? requester : requester?.id;
      if (typeof userId !== 'string' || !userId || userId.length > 100) throw failure('浏览器导入缺少有效的请求账号。', 401);
      if (plain(requester) && requester.role !== 'admin' && !['ai', 'requirements', 'knowledge'].some((module) => requester.permissions?.[module]?.write)) throw failure('当前账号没有导入文档的写入权限。', 403);
      if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
      if (closed || !bridge || bridge.readyState !== 1) throw failure('请管理员先连接服务器 Chrome 浏览器扩展，再导入飞书文档。', 503);
      if (byUser.has(userId)) throw failure('当前账号已有飞书文档读取任务，请等待或取消后重试。', 429);
      if (jobs.size >= FEISHU_BROWSER_LIMITS.pending) throw failure('浏览器当前读取任务较多，请稍后再试。', 429);
      return new Promise((resolve, reject) => {
        const job = { id: crypto.randomUUID(), userId, source, resolve, reject, signal, receiving: false };
        job.abort = () => { send(bridge, { type: 'cancel', taskId: job.id }); settle(job, new DOMException('读取已取消', 'AbortError')); };
        job.timer = setTimeout(() => { send(bridge, { type: 'cancel', taskId: job.id }); settle(job, failure('浏览器读取文档超过 180 秒，请重试或下载原件。', 504, 'browser_timeout')); }, timeoutMs); job.timer.unref?.();
        jobs.set(job.id, job); byUser.set(userId, job.id); signal?.addEventListener('abort', job.abort, { once: true });
        send(bridge, { type: 'import', taskId: job.id, url: source.url });
      });
    } catch (error) { return Promise.reject(error); }
  }
  function disconnect() {
    pairing = null; credentials = null; rejectPending(failure('管理员已断开浏览器连接，请重新配对。', 503));
    for (const ws of wss.clients) ws.close(1000, 'Browser disconnected'); bridge = null;
    try { persist({ version: 1, disconnectedAt: new Date().toISOString() }); configError = false; } catch (error) { configError = true; throw error; }
    return status();
  }
  function close() {
    closed = true; pairing = null; rejectPending(failure('浏览器连接服务已关闭。', 503));
    for (const ws of wss.clients) { clearTimeout(ws.authTimer); ws.terminate(); } bridge = null; wss.close();
  }
  return { pair, status, handleUpgrade, read, disconnect, close };
}

export function registerFeishuBrowserRoutes(app, { service, requireAdmin, sendError } = {}) {
  if (!service) throw new Error('Missing browser service');
  const errorResponse = (res, error) => sendError ? sendError(res, error.status || 503, error.code || 'browser_error', error.publicMessage || '浏览器连接暂时不可用。') : res.status(error.status || 503).json({ error: error.code || 'browser_error', message: error.publicMessage || '浏览器连接暂时不可用。' });
  const admin = requireAdmin || ((req, res, next) => req.user?.role === 'admin' ? next() : errorResponse(res, failure('仅管理员可配置浏览器连接。', 403)));
  const route = (handler) => (req, res) => { try { handler(req, res); } catch (error) { errorResponse(res, error); } };
  app.get('/api/feishu-browser/status', route((req, res) => { if (!req.user) throw failure('请先登录。', 401); res.set('Cache-Control', 'no-store'); res.json(service.status()); }));
  app.post('/api/feishu-browser/pair', admin, route((req, res) => { res.set('Cache-Control', 'no-store'); res.json(service.pair()); }));
  const disconnect = route((req, res) => res.json(service.disconnect()));
  app.delete('/api/feishu-browser/disconnect', admin, disconnect);
  app.delete('/api/feishu-browser', admin, disconnect);
  return service;
}
