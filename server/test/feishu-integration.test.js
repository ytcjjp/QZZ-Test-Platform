import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminPassword = 'IsolatedBridgeAdmin123';

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-feishu-integration-'));
  let child; let base; const sockets = new Set();
  async function start() {
    const processChild = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
      cwd: os.tmpdir(), env: { ...process.env, QZZ_DATA_DIR: directory, QZZ_CLIENT_DIST: path.join(directory, 'empty-client'), PORT: '0', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: adminPassword, AI_API_KEY: '', AI_MODEL: '', FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = processChild;
    base = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Isolated integration server startup timed out')), 15000);
      processChild.stdout.on('data', (data) => { output = (output + data).slice(-4000); const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      processChild.stderr.on('data', (data) => { output = (output + data).slice(-4000); });
      processChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Isolated integration server exited (${code})`)); });
    });
  }
  async function stop() {
    for (const ws of sockets) ws.terminate(); sockets.clear();
    if (child?.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    child = null;
  }
  async function call(route, cookie, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  async function login(username = 'admin', password = adminPassword) {
    const response = await call('/api/session', null, { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200); return response.response.headers.get('set-cookie').split(';')[0];
  }
  async function connect(route, { cookie, extension = false } = {}) {
    const origin = extension ? `chrome-extension://${'c'.repeat(32)}` : base;
    const ws = new WebSocket(base.replace('http:', 'ws:') + route, { origin, headers: { host: new URL(base).host, ...(cookie ? { cookie } : {}) } });
    sockets.add(ws); const events = []; const queued = []; const waiting = [];
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()); events.push(event);
      const index = waiting.findIndex((entry) => entry.match(event));
      if (index < 0) queued.push(event); else { const [entry] = waiting.splice(index, 1); clearTimeout(entry.timer); entry.resolve(event); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { sockets.delete(ws); for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(new Error('Isolated websocket closed before expected event')); } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return {
      ws, events,
      next(match = () => true) {
        const index = queued.findIndex(match); if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
        return new Promise((resolve, reject) => { const entry = { match, resolve, reject }; entry.timer = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error('Expected isolated websocket event was not received')); }, 5000); waiting.push(entry); });
      },
    };
  }
  try { await start(); await run({ directory, call, login, connect, stop, start }); }
  finally { await stop(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('real server bridges paired browser imports into persistent requirements and images, then serves node execution statuses and filtered events', { timeout: 30000 }, async () => fixture(async ({ directory, call, login, connect, stop, start }) => {
  let admin = await login();
  const project = (await call('/api/projects', admin)).body.projects[0]; const projectId = project.id;
  const sourceUrl = 'https://integration.feishu.cn/wiki/MockRequirement';
  const draftBody = '# 活动规则\n领取后奖励进入背包。'; const warning = '折叠内容尚未展开，请人工补充原件。';
  for (const method of ['GET', 'PUT']) assert.equal((await call('/api/ai/feishu-config', admin, { method, ...(method === 'PUT' ? { body: {} } : {}) })).status, 404);
  const notPaired = await call('/api/requirements', admin, { method: 'POST', body: { projectId, title: '尚未连接的来源', sourceUrl } });
  assert.equal(notPaired.status, 503); assert.match(notPaired.body.message, /Chrome/);
  assert.deepEqual((await call(`/api/requirements?projectId=${projectId}`, admin)).body.requirements, []);

  async function createMember(username, allowed) {
    const created = await call('/api/users', admin, { method: 'POST', body: { username, password: 'IntegrationMember123' } }); assert.equal(created.status, 201);
    const permissions = Object.fromEntries(['cases', 'defects', 'requirements', 'knowledge', 'ai', 'files'].map((name) => [name, { view: name === 'defects' || allowed && ['cases', 'requirements'].includes(name), write: false }]));
    assert.equal((await call('/api/users/' + created.body.user.id, admin, { method: 'PUT', body: { permissions } })).status, 200);
    return login(username, 'IntegrationMember123');
  }
  const reader = await createMember('bridge-reader', true); const denied = await createMember('bridge-denied', false);
  assert.equal((await call('/api/feishu-browser/status')).status, 401);
  assert.equal((await call('/api/feishu-browser/status', reader)).status, 200); // Requires no AI permission.
  for (const [route, method] of [['/api/feishu-browser/pair', 'POST'], ['/api/feishu-browser/disconnect', 'DELETE'], ['/api/feishu-browser/extension.zip', 'GET']]) assert.equal((await call(route, reader, { method })).status, 403);
  assert.equal((await call('/api/requirements', reader, { method: 'POST', body: { projectId, sourceUrl } })).status, 403);
  const readerEvents = await connect('/api/events', { cookie: reader }); const deniedEvents = await connect('/api/events', { cookie: denied });

  const paired = await call('/api/feishu-browser/pair', admin, { method: 'POST' });
  assert.equal(paired.status, 200); assert.match(paired.body.pairingCode, /^[A-F0-9]{12}$/);
  const browser = await connect('/api/feishu-browser/events', { extension: true });
  browser.ws.send(JSON.stringify({ type: 'pair', code: paired.body.pairingCode, client: { name: 'Integration fake extension', version: '1' } }));
  const pairedMessage = await browser.next((event) => event.type === 'paired'); assert.equal(typeof pairedMessage.token, 'string');
  const browserStatus = (await call('/api/feishu-browser/status', reader)).body;
  assert.equal(browserStatus.connected, true); assert.equal(browserStatus.paired, true); assert.ok(!JSON.stringify(browserStatus).includes(pairedMessage.token));
  const pairingFile = await fs.readFile(path.join(directory, 'feishu-browser.json'), 'utf8');
  assert.ok(!pairingFile.includes(pairedMessage.token)); assert.ok(!pairingFile.includes(paired.body.pairingCode));

  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#28a17c' } }).png().toBuffer();
  const creating = call('/api/requirements', admin, { method: 'POST', body: { projectId, sourceUrl } });
  const importTask = await browser.next((event) => event.type === 'import'); assert.equal(importTask.url, sourceUrl);
  browser.ws.send(JSON.stringify({ type: 'result', taskId: importTask.taskId, ok: true, document: { url: 'https://integration.feishu.cn/docx/ResolvedRequirement', title: '浏览器导入验证资料', text: draftBody, completeness: 'partial', warnings: [warning], loadedBlocks: 2, imagesDetected: 1, imagesIncluded: 1, images: [{ name: '原始流程图.png', mimeType: 'image/png', data: png.toString('base64') }] } }));
  const imported = await creating; assert.equal(imported.status, 201);
  const requirement = imported.body.requirement;
  assert.equal(requirement.title, '浏览器导入验证资料'); assert.equal(requirement.body, draftBody); assert.equal(requirement.sourceUrl, sourceUrl);
  assert.equal(requirement.sourceCompleteness, 'partial'); assert.ok(requirement.sourceWarnings.includes(warning)); assert.ok(requirement.sourceWarnings.some((item) => item.includes('未读取')));
  assert.equal(requirement.attachments.length, 1); const attachment = requirement.attachments[0]; assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.name, '原始流程图.png'); assert.equal(attachment.width, 5); assert.equal(attachment.height, 4);
  assert.deepEqual((await call(attachment.downloadUrl, reader)).body, png);
  const preview = await call(attachment.previewUrl, reader); assert.equal(preview.status, 200); assert.equal((await sharp(preview.body).metadata()).format, 'png');
  assert.equal((await call(attachment.downloadUrl, denied)).status, 403);
  await readerEvents.next((event) => event.type === 'requirement.created' && event.id === requirement.id);

  const tree = { id: 'root', title: '浏览器来源用例', children: [{ id: 'scenario-1', title: '奖励领取', children: [{ id: 'precondition', title: '前置条件：具备领取资格', children: [] }, { id: 'steps', title: '执行步骤：点击领取', children: [] }, { id: 'expected', title: '预期结果：奖励进入背包', children: [] }] }] };
  const setResponse = await call('/api/cases', admin, { method: 'POST', body: { projectId, requirementId: requirement.id, title: tree.title, tree } }); assert.equal(setResponse.status, 201);
  let set = setResponse.body.case; const statusesUrl = `/api/cases/${set.id}/node-statuses`;
  assert.deepEqual((await call(statusesUrl + `?projectId=${projectId}`, reader)).body.statuses, []);
  const changed = await call(statusesUrl + '/scenario-1', admin, { method: 'PUT', body: { projectId, status: '测试通过', revision: 0 } });
  assert.equal(changed.status, 200); assert.equal(changed.body.nodeStatus.revision, 1); assert.equal(changed.body.caseRevision, set.revision);
  const notification = await readerEvents.next((event) => event.type === 'case.node-status-updated' && event.caseId === set.id);
  assert.deepEqual(notification.nodeStatus, changed.body.nodeStatus); assert.equal(notification.projectId, projectId); assert.ok(!Object.hasOwn(notification, 'tree'));
  assert.equal((await call(statusesUrl + '/scenario-1', reader, { method: 'PUT', body: { projectId, status: '跳过' } })).status, 403);
  assert.equal((await call(statusesUrl + `?projectId=${projectId}`, denied)).status, 403);
  assert.equal((await call(statusesUrl + '/scenario-1', admin, { method: 'PUT', body: { projectId, status: '跳过', revision: 0 } })).status, 409);
  const savedSet = (await call(`/api/cases?projectId=${projectId}`, admin)).body.cases.find((item) => item.id === set.id);
  assert.equal(savedSet.revision, set.revision); assert.deepEqual(savedSet.tree, tree);
  const marker = await call('/api/defects', admin, { method: 'POST', body: { projectId, title: '事件同步屏障' } }); assert.equal(marker.status, 201);
  await Promise.all([readerEvents, deniedEvents].map((observer) => observer.next((event) => event.type === 'defect.created' && event.defect.id === marker.body.defect.id)));
  assert.ok(!deniedEvents.events.some((event) => event.type.startsWith('case.') || event.type.startsWith('requirement.')));
  assert.ok(!JSON.stringify(readerEvents.events).includes(pairedMessage.token)); assert.ok(!JSON.stringify(readerEvents.events).includes(paired.body.pairingCode));

  await stop(); await start(); admin = await login();
  const persisted = (await call(`/api/requirements/${requirement.id}?projectId=${projectId}`, admin)).body.requirement;
  assert.equal(persisted.body, draftBody); assert.deepEqual(persisted.sourceWarnings, requirement.sourceWarnings); assert.equal(persisted.sourceCompleteness, 'partial');
  assert.deepEqual((await call(persisted.attachments[0].downloadUrl, admin)).body, png);
  assert.deepEqual((await call(statusesUrl + `?projectId=${projectId}`, admin)).body.statuses, [changed.body.nodeStatus]);
  const afterRestart = (await call('/api/feishu-browser/status', admin)).body; assert.equal(afterRestart.paired, true); assert.equal(afterRestart.connected, false);
  const reconnected = await connect('/api/feishu-browser/events', { extension: true }); reconnected.ws.send(JSON.stringify({ type: 'auth', token: pairedMessage.token })); assert.equal((await reconnected.next()).type, 'ready');
  set = (await call('/api/cases/' + set.id, admin, { method: 'PUT', body: { projectId, revision: set.revision, tree: { ...tree, children: [] } } })).body.case;
  assert.equal(set.revision, savedSet.revision + 1); assert.deepEqual((await call(statusesUrl + `?projectId=${projectId}`, admin)).body.statuses, []);
  assert.equal((await call(statusesUrl + '/scenario-1', admin, { method: 'PUT', body: { projectId, status: '待测试' } })).status, 404);
  assert.equal((await call('/api/feishu-browser/disconnect', admin, { method: 'DELETE' })).body.paired, false);
  assert.equal((await call('/api/requirements', admin, { method: 'POST', body: { projectId, sourceUrl } })).status, 503);
  assert.equal((await call(`/api/requirements?projectId=${projectId}`, admin)).body.requirements.length, 1);
}));
