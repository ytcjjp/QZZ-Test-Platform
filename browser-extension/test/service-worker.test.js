import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeishuBridge } from '../service-worker.js';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const token = 'local-only-fixture-pairing-token';
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) { for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await flush(); } assert.fail('mock action did not finish'); }
const event = () => { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), fire: (...args) => [...listeners].forEach((fn) => fn(...args)) }; };

function fixture(options = {}) {
  const sockets = []; const packets = []; const updates = []; const tabs = new Map(); const removed = []; const fetches = [];
  const timers = { callbacks: new Map(), count: 0, setTimeout(fn, ms) { const id = ++this.count; this.callbacks.set(id, { fn, ms }); return id; }, setInterval(fn, ms) { return this.setTimeout(fn, ms); }, clearTimeout(id) { this.callbacks.delete(id); }, clearInterval(id) { this.callbacks.delete(id); } };
  class MockSocket {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { packets.push(JSON.parse(value)); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let stored = options.stored;
  const chrome = {
    storage: { local: { get: async () => ({ qzzFeishuBridge: stored }), set: async (value) => { await options.beforeStore?.(value); stored = structuredClone(value.qzzFeishuBridge); } } },
    alarms: { create: async () => {} }, runtime: { sendMessage: async (value) => { updates.push(value); } }, action: { setBadgeText: async () => {} },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      create: async (value) => { assert.equal(value.active, false); const tab = { ...value, id: tabs.size + 1, status: options.loading ? 'loading' : 'complete' }; tabs.set(tab.id, tab); return tab; },
      get: async (id) => { if (!tabs.has(id)) throw new Error('missing tab'); return tabs.get(id); },
      remove: async (id) => { if (tabs.has(id)) { removed.push(id); tabs.delete(id); chrome.tabs.onRemoved.fire(id); } },
    },
    scripting: { executeScript: async (request) => {
      assert.equal(request.world, 'ISOLATED');
      if (request.files) { assert.deepEqual(request.files, ['content-extractor.js']); return []; }
      return [{ result: await options.extract?.() || { url: 'https://team.feishu.cn/docx/Doc123', title: '活动策划', text: '活动开启后展示入口。[file#1]', completeness: 'complete', warnings: [], loadedBlocks: 1, images: [{ id: 'file-1', src: 'https://img.feishucdn.com/a?signature=private', loaded: true }] } }];
    } },
  };
  const bridge = new FeishuBridge({ chrome, WebSocket: MockSocket, timers, imageOptions: { decode: async () => ({ width: 1, height: 1, close() {} }) }, fetcher: async (url, request) => { fetches.push({ url, request }); return new Response(image, { headers: { 'content-type': 'image/png' } }); } });
  return { bridge, sockets, packets, updates, removed, tabs, timers, fetches, stored: () => stored };
}

async function paired(value) {
  await value.bridge.initialize();
  const pending = value.bridge.pair(3210, 'a1b2c3d4e5f6');
  await until(() => value.sockets.length === 1); value.sockets[0].open();
  value.sockets[0].receive({ type: 'paired', token }); await pending;
  return value.sockets[0];
}

test('pairs over fixed loopback WS, keeps credentials local, heartbeats and reconnects with persisted token', async () => {
  const value = fixture(); const socket = await paired(value);
  assert.equal(socket.url, 'ws://127.0.0.1:3210/api/feishu-browser/events');
  assert.equal(value.packets[0].type, 'pair'); assert.equal(value.packets[0].code, 'A1B2C3D4E5F6');
  assert.equal(value.stored().token, token); assert.equal(Object.hasOwn(value.stored(), 'code'), false);
  assert.equal(value.bridge.status.state, 'ready'); assert.equal(JSON.stringify(value.updates).includes(token), false);
  socket.receive({ type: 'ping' }); assert.equal(value.packets.at(-1).type, 'pong');
  [...value.timers.callbacks.values()].find((item) => item.ms === 20000).fn(); assert.equal(value.packets.at(-1).type, 'ping');
  socket.close(); assert.equal(value.bridge.authenticated, false);
  [...value.timers.callbacks.values()].find((item) => item.ms === 1000).fn(); value.sockets[1].open();
  assert.deepEqual(value.packets.at(-1), { type: 'auth', token });
  value.sockets[1].receive({ type: 'ready' }); await flush(); assert.equal(value.bridge.status.state, 'ready');
  await value.bridge.disconnect(); assert.equal(value.stored().enabled, false);
});

test('imports only a background document tab and returns actual images without private asset URLs or session metadata', async () => {
  const value = fixture(); const socket = await paired(value);
  socket.receive({ type: 'import', taskId: 'task_one', url: 'https://team.feishu.cn/docx/Doc123?from=share' });
  await until(() => value.packets.some((packet) => packet.type === 'result'));
  const result = value.packets.find((packet) => packet.type === 'result');
  assert.equal(result.ok, true); assert.equal(result.document.completeness, 'complete'); assert.equal(result.document.loadedBlocks, 1);
  assert.equal(result.document.imagesDetected, 1); assert.equal(result.document.imagesIncluded, 1);
  assert.deepEqual(Buffer.from(result.document.images[0].data, 'base64'), image);
  assert.equal(result.document.images[0].name, 'file-1.png');
  assert.equal(value.fetches[0].request.credentials, 'include'); assert.equal(value.fetches[0].request.redirect, 'error');
  for (const secret of ['signature', token, 'Cookie', 'authorization', 'headers']) assert.equal(JSON.stringify(result).includes(secret), false);
  await until(() => value.bridge.jobs.size === 0); assert.deepEqual(value.removed, [1]); assert.equal(value.tabs.size, 0);
  await value.bridge.disconnect();
});

test('marks missing or forbidden images partial and rejects unsupported URLs before creating tabs', async () => {
  const value = fixture({ extract: async () => ({ url: 'https://team.feishu.cn/docx/Doc123', title: '图片不全', text: '正文。[file#1]', completeness: 'complete', warnings: [], loadedBlocks: 1, images: [{ id: 'file-1', src: 'https://evil.test/private', loaded: true }] }) });
  const socket = await paired(value);
  socket.receive({ type: 'import', taskId: 'bad_url', url: 'http://127.0.0.1/private' });
  await until(() => value.packets.some((packet) => packet.taskId === 'bad_url')); assert.equal(value.tabs.size, 0);
  socket.receive({ type: 'import', taskId: 'partial', url: 'https://team.feishu.cn/docx/Doc123' });
  await until(() => value.packets.some((packet) => packet.taskId === 'partial'));
  const result = value.packets.find((packet) => packet.taskId === 'partial');
  assert.equal(result.ok, true); assert.equal(result.document.completeness, 'partial'); assert.ok(result.document.warnings.length);
  assert.equal(result.document.imagesDetected, 1); assert.equal(result.document.imagesIncluded, 0); assert.equal(value.fetches.length, 0);
  assert.equal(JSON.stringify(result).includes('evil.test'), false); await value.bridge.disconnect();
});

test('cancels reading without returning late content and cleans its own tab', async () => {
  let finish; const reading = new Promise((resolve) => { finish = resolve; });
  const value = fixture({ extract: () => reading }); const socket = await paired(value);
  socket.receive({ type: 'import', taskId: 'cancel_me', url: 'https://team.feishu.cn/docx/Doc123' });
  await until(() => value.bridge.jobs.get('cancel_me')?.tabId === 1); await flush();
  socket.receive({ type: 'cancel', taskId: 'cancel_me' });
  finish({ url: 'https://team.feishu.cn/docx/Doc123', title: 'late', text: '不得返回的迟到正文', images: [], warnings: [], completeness: 'complete' });
  await until(() => value.packets.some((packet) => packet.taskId === 'cancel_me'));
  const result = value.packets.find((packet) => packet.taskId === 'cancel_me');
  assert.equal(result.ok, false); assert.equal(result.error.code, 'CANCELLED'); assert.equal(JSON.stringify(result).includes('迟到正文'), false);
  await until(() => value.bridge.jobs.size === 0); assert.equal(value.tabs.size, 0); await value.bridge.disconnect();
});

test('a delayed pairing response cannot reconnect or overwrite state after disconnect', async () => {
  let release; let hold = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  const value = fixture({ beforeStore: async () => { if (hold) await blocked; } }); await value.bridge.initialize();
  const pending = value.bridge.pair(3210, 'A1B2C3D4E5F6'); const rejected = assert.rejects(pending);
  await until(() => value.sockets.length); value.sockets[0].open(); hold = true;
  value.sockets[0].receive({ type: 'paired', token }); await flush();
  const disconnected = value.bridge.disconnect(); release(); await disconnected; await rejected; await flush();
  assert.equal(value.bridge.config.enabled, false); assert.equal(value.stored().enabled, false); assert.equal(value.bridge.authenticated, false); assert.notEqual(value.bridge.status.state, 'ready');
});

test('a late old job cannot report content or replace status on a new connection', async () => {
  let finish; const reading = new Promise((resolve) => { finish = resolve; });
  const value = fixture({ extract: () => reading }); const socket = await paired(value);
  socket.receive({ type: 'import', taskId: 'old_task', url: 'https://team.feishu.cn/docx/Doc123' });
  await until(() => value.bridge.jobs.get('old_task')?.tabId === 1); await flush();
  await value.bridge.disconnect(); await value.bridge.reconnect(); value.sockets[1].open(); value.sockets[1].receive({ type: 'ready' }); await flush();
  finish({ url: 'https://team.feishu.cn/docx/Doc123', title: 'old', text: '旧会话不得转发', images: [], warnings: [], completeness: 'complete' });
  await until(() => value.bridge.jobs.size === 0);
  assert.equal(value.packets.some((packet) => packet.type === 'result' && packet.taskId === 'old_task'), false);
  assert.equal(value.bridge.status.state, 'ready'); await value.bridge.disconnect();
});

test('restores a custom disconnected port and reports a manually closed reading tab', async () => {
  let finish; const reading = new Promise((resolve) => { finish = resolve; });
  const value = fixture({ stored: { port: 4321, token, enabled: false }, extract: () => reading }); await value.bridge.initialize();
  assert.equal(value.bridge.status.port, 4321); assert.equal(value.bridge.status.state, 'disconnected');
  await value.bridge.reconnect(); value.sockets[0].open(); value.sockets[0].receive({ type: 'ready' }); await flush();
  value.sockets[0].receive({ type: 'import', taskId: 'closed_tab', url: 'https://team.feishu.cn/docx/Doc123' });
  await until(() => value.bridge.jobs.get('closed_tab')?.tabId === 1); await flush();
  await value.bridge.chrome.tabs.remove(1); finish({ url: 'https://team.feishu.cn/docx/Doc123', text: 'late' });
  await until(() => value.packets.some((packet) => packet.taskId === 'closed_tab'));
  assert.equal(value.packets.find((packet) => packet.taskId === 'closed_tab').error.code, 'TAB_CLOSED'); await value.bridge.disconnect();
});
