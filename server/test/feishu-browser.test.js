import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import sharp from 'sharp';
import WebSocket from 'ws';
import { createFeishuBrowserService, registerFeishuBrowserRoutes, normalizeFeishuBrowserUrl, FEISHU_BROWSER_WS_PATH } from '../feishu-browser.js';

const extensionId = 'a'.repeat(32); const otherExtensionId = 'b'.repeat(32);
const url = 'https://team.feishu.cn/wiki/Document123';
function inbox(ws) {
  const queued = []; const waiting = [];
  ws.on('message', (data) => { const value = JSON.parse(data.toString()); if (waiting.length) waiting.shift()(value); else queued.push(value); });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
}
async function fixture(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-feishu-browser-'));
  const service = createFeishuBrowserService({ dataDir: directory, timeoutMs: 3000, ...options });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers['x-user']) req.user = { id: req.headers['x-user'], role: req.headers['x-user'] === 'admin' ? 'admin' : 'member' }; next(); });
  registerFeishuBrowserRoutes(app, { service });
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => { if (!service.handleUpgrade(req, socket, head)) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  async function connect(origin = `chrome-extension://${extensionId}`, extraHeaders = {}) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + FEISHU_BROWSER_WS_PATH, { origin, headers: extraHeaders });
    sockets.push(ws); const next = inbox(ws); await once(ws, 'open'); return { ws, next };
  }
  async function paired() { const { pairingCode } = service.pair(); const client = await connect(); client.ws.send(JSON.stringify({ type: 'pair', code: pairingCode, client: { name: 'test', version: '1' } })); const result = await client.next(); assert.equal(result.type, 'paired'); return { ...client, token: result.token }; }
  async function call(route, method = 'GET', user = 'admin') { const response = await fetch(base + route, { method, headers: user ? { 'x-user': user } : {} }); return { response, status: response.status, body: await response.json() }; }
  const result = (client, task, changes = {}) => client.ws.send(JSON.stringify({ type: 'result', taskId: task.taskId, ok: true, document: { url: 'https://team.feishu.cn/docx/Resolved123', title: '飞书资料', text: '奖励领取后进入背包。', completeness: 'complete', warnings: [], ...changes } }));
  try { await run({ service, directory, base, connect, paired, call, result }); }
  finally { service.close(); for (const ws of sockets) ws.terminate(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('browser pairing is admin-only, one-use and origin-bound, stores only a hash, and disconnect revokes persisted access', async () => fixture(async ({ service, directory, connect, call }) => {
  assert.equal((await call('/api/feishu-browser/status', 'GET', null)).status, 401);
  assert.equal((await call('/api/feishu-browser/pair', 'POST', 'member')).status, 403);
  const pairing = await call('/api/feishu-browser/pair', 'POST');
  assert.equal(pairing.status, 200); assert.match(pairing.body.pairingCode, /^[A-F0-9]{12}$/); assert.equal(pairing.response.headers.get('cache-control'), 'no-store');
  const client = await connect(); client.ws.send(JSON.stringify({ type: 'pair', code: pairing.body.pairingCode.toLowerCase() }));
  const paired = await client.next(); assert.equal(paired.type, 'paired'); assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
  const config = await fs.readFile(path.join(directory, 'feishu-browser.json'), 'utf8');
  assert.ok(!config.includes(paired.token)); assert.ok(!config.includes(pairing.body.pairingCode)); assert.equal(JSON.parse(config).extensionId, extensionId);
  const status = (await call('/api/feishu-browser/status', 'GET', 'member')).body;
  assert.equal(status.connected, true); assert.equal(status.paired, true); assert.equal(status.pairingPending, false);
  assert.ok(!JSON.stringify(status).includes(paired.token)); assert.ok(!('tokenHash' in status)); assert.ok(!('pairingCode' in status));
  const retry = await connect(); retry.ws.send(JSON.stringify({ type: 'pair', code: pairing.body.pairingCode })); assert.equal((await retry.next()).code, 'PAIRING_INVALID');
  const reconnect = await connect(); reconnect.ws.send(JSON.stringify({ type: 'auth', token: paired.token })); assert.equal((await reconnect.next()).type, 'ready');
  reconnect.ws.send(JSON.stringify({ type: 'ping' })); assert.equal((await reconnect.next()).type, 'pong');
  const loaded = createFeishuBrowserService({ dataDir: directory }); assert.equal(loaded.status().paired, true); assert.equal(loaded.status().connected, false); loaded.close();
  assert.equal((await call('/api/feishu-browser/disconnect', 'DELETE', 'member')).status, 403);
  assert.equal((await call('/api/feishu-browser/disconnect', 'DELETE')).body.paired, false);
  const afterDisconnect = createFeishuBrowserService({ dataDir: directory }); assert.equal(afterDisconnect.status().paired, false); afterDisconnect.close();
  assert.ok(!JSON.stringify(service.status()).includes('Document123'));
}));

test('browser websocket rejects LAN sockets, non-loopback Host, unpaired or web origins and stale tokens', async () => fixture(async ({ service, base, connect, paired }) => {
  const rejected = async (origin, headers = {}) => {
    const client = new WebSocket(base.replace('http:', 'ws:') + FEISHU_BROWSER_WS_PATH, { origin, headers });
    const response = await new Promise((resolve, reject) => { client.on('unexpected-response', (req, res) => { resolve(res.statusCode); res.resume(); client.terminate(); }); client.on('error', () => {}); client.on('open', () => { client.terminate(); reject(new Error('Unexpected upgrade')); }); });
    assert.equal(response, 403);
  };
  service.pair();
  await rejected('https://team.feishu.cn');
  await rejected('chrome-extension://' + 'z'.repeat(32));
  await rejected(`chrome-extension://${extensionId}`, { host: 'company-lan.invalid:3210' });
  const socket = { wrote: '', destroyed: false, write(value) { this.wrote += value; }, destroy() { this.destroyed = true; } };
  assert.equal(service.handleUpgrade({ url: FEISHU_BROWSER_WS_PATH, socket: { remoteAddress: '192.0.2.25' }, headers: { host: '127.0.0.1:3210', origin: `chrome-extension://${extensionId}` } }, socket, Buffer.alloc(0)), true);
  assert.equal(socket.destroyed, true); assert.match(socket.wrote, /403/);
  const client = await paired();
  await rejected(`chrome-extension://${otherExtensionId}`);
  const oldToken = client.token; service.pair();
  const old = await connect(); old.ws.send(JSON.stringify({ type: 'auth', token: oldToken })); assert.equal((await old.next()).code, 'AUTH_INVALID');
}));

test('browser pair codes expire, idle sockets must authenticate, and re-pair cancels active work', async () => {
  await fixture(async ({ service, connect, base }) => {
    service.pair();
    const unauthenticated = await connect(); assert.equal((await unauthenticated.next()).code, 'AUTH_REQUIRED');
    const pair = service.pair();
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(pair.expiresAt) - Date.now() + 10)));
    const client = new WebSocket(base.replace('http:', 'ws:') + FEISHU_BROWSER_WS_PATH, { origin: `chrome-extension://${extensionId}` });
    client.on('error', () => {});
    const status = await new Promise((resolve) => client.once('unexpected-response', (req, res) => { resolve(res.statusCode); res.resume(); client.terminate(); }));
    assert.equal(status, 403); assert.equal(service.status().pairingPending, false);
  }, { pairingTtlMs: 120, authTimeoutMs: 30 });
  await fixture(async ({ service, paired }) => {
    const client = await paired();
    const promise = service.read(url, { requester: 're-pair' }); const rejected = assert.rejects(promise, (error) => error.status === 503);
    await client.next(); const pair = service.pair(); await rejected;
    assert.equal(service.status().paired, false); assert.equal(service.status().connected, false); assert.equal(service.status().pending, 0); assert.match(pair.pairingCode, /^[A-F0-9]{12}$/);
  });
});

test('browser import limits concurrency, cancels per-user work and cleans pending jobs on timeout, re-pair and disconnect', async () => fixture(async ({ service, paired, result }) => {
  const client = await paired();
  const controller = new AbortController();
  const first = service.read(url + '?tracking=drop#view', { requester: 'first', signal: controller.signal }); const aborted = assert.rejects(first, { name: 'AbortError' });
  const task = await client.next(); assert.equal(task.url, url); assert.equal(task.type, 'import');
  await assert.rejects(service.read(url, { requester: 'first' }), (error) => error.status === 429);
  const second = service.read(url, { requester: 'second' }); const secondTask = await client.next();
  await assert.rejects(service.read(url, { requester: 'third' }), (error) => error.status === 429);
  await assert.rejects(service.read(url, { requester: { id: 'denied', role: 'member', permissions: { requirements: { write: false } } } }), (error) => error.status === 403);
  controller.abort(); await aborted; assert.deepEqual(await client.next(), { type: 'cancel', taskId: task.taskId });
  result(client, task, { text: '已取消任务的旧资料' });
  result(client, secondTask); assert.equal((await second).text, '奖励领取后进入背包。'); assert.equal(service.status().pending, 0);
  const timeout = service.read(url, { requester: 'timeout' }); const timeoutTask = await client.next();
  await assert.rejects(timeout, (error) => error.status === 504); assert.deepEqual(await client.next(), { type: 'cancel', taskId: timeoutTask.taskId }); assert.equal(service.status().pending, 0);
  const pending = service.read(url, { requester: 'disconnect' }); const rejected = assert.rejects(pending, (error) => error.status === 503); await client.next();
  const pending2 = service.read(url, { requester: 'disconnect2' }); const rejected2 = assert.rejects(pending2, (error) => error.status === 503); await client.next();
  service.disconnect(); await Promise.all([rejected, rejected2]); assert.equal(service.status().pending, 0);
  await assert.rejects(service.read(url, { requester: 'new' }), (error) => error.status === 503);
}, { timeoutMs: 100 }));

test('browser evidence validates final URLs, actual image bytes, text budgets and explicit partial content without returning raw errors', async () => fixture(async ({ service, paired, result }) => {
  const client = await paired();
  async function read(changes) { const promise = service.read(url, { requester: 'reader' }); const task = await client.next(); result(client, task, changes); return promise; }
  const partial = await read({ completeness: 'partial', warnings: ['部分内容折叠，尚未加载。'] });
  assert.equal(partial.completeness, 'partial'); assert.ok(partial.warnings.some((text) => text.includes('未读取')));
  const imageWarnings = await read({ completeness: 'partial', warnings: Array.from({ length: 64 }, (_, index) => `[file#${index + 1}] 图片尚未加载。`) });
  assert.equal(imageWarnings.warnings.length, 65);
  const mismatched = await read({ imagesDetected: 1 }); assert.equal(mismatched.completeness, 'partial'); assert.ok(mismatched.warnings.length);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const image = await read({ images: [{ name: '流程图', mimeType: 'image/png', data: png.toString('base64') }] });
  assert.deepEqual(image.images[0].buffer, png); assert.equal(image.images[0].mimeType, 'image/png');
  await assert.rejects(read({ url: 'https://evil.invalid/docx/Document123' }), (error) => error.status === 400);
  await assert.rejects(read({ url: 'https://tenant.larksuite.com/docx/Document123' }), /不同的飞书服务/);
  await assert.rejects(read({ text: 'x'.repeat(100001) }), (error) => error.status === 413);
  await assert.rejects(read({ text: ' ', images: [] }), /未从文档采集/);
  await assert.rejects(read({ completeness: undefined }), /采集完整性/);
  await assert.rejects(read({ cookies: 'private-cookie' }), /不支持的文档数据/);
  await assert.rejects(read({ images: Array.from({ length: 65 }, () => ({})) }), (error) => error.status === 413);
  await assert.rejects(read({ images: [{ mimeType: 'image/png', data: Buffer.from('fake image').toString('base64') }] }), /图片损坏/);
  const rejected = service.read(url, { requester: 'reader' }); const task = await client.next();
  client.ws.send(JSON.stringify({ type: 'result', taskId: task.taskId, ok: false, error: { code: '__proto__', message: 'private-cookie-and-page-text' } }));
  await assert.rejects(rejected, (error) => !error.message.includes('private') && error.code === 'browser_read_failed');
  const denied = service.read(url, { requester: 'reader' }); const deniedTask = await client.next();
  client.ws.send(JSON.stringify({ type: 'result', taskId: deniedTask.taskId, ok: false, error: { code: 'ACCESS_DENIED', message: 'private cookie' } }));
  await assert.rejects(denied, (error) => error.status === 403 && !error.message.includes('cookie'));
}));

test('browser source allowlist never accepts cookie URLs, non-document pages or lookalike hosts', () => {
  for (const value of ['http://team.feishu.cn/docx/abc', 'https://team.feishu.cn:444/docx/abc', 'https://team.feishu.cn.evil.invalid/docx/abc', 'https://team.feishu.cn@evil.invalid/docx/abc', 'https://team.feishu.cn/accounts/login', 'file:///docx/abc', 'https://team.feishu.cn/docx/a/b', 'https://team.feishu.cn/docx/%2e%2e']) assert.throws(() => normalizeFeishuBrowserUrl(value));
  assert.equal(normalizeFeishuBrowserUrl('https://tenant.larksuite.com/docs/abc?from=share').url, 'https://tenant.larksuite.com/docs/abc');
});
