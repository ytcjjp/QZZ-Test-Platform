import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importXmind } from '../mindmap-formats.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-backend-audit-'));
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], { cwd: os.tmpdir(), env: { ...process.env, PORT: '0', QZZ_DATA_DIR: directory, ADMIN_PASSWORD: 'AuditAdminPassword123', MAX_UPLOAD_MB: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Audit server startup timeout')), 10000);
      child.stdout.on('data', (data) => { output += data; const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
      child.stderr.on('data', (data) => { output += data; });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Audit server exited: ${code}`)); });
    });
    async function call(url, body, method = 'POST', cookie) {
      const response = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      return { status: response.status, response, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    }
    async function login(username, password) { const result = await call('/api/session', { username, password }); assert.equal(result.status, 200); return result.response.headers.get('set-cookie').split(';')[0]; }
    const admin = await login('admin', 'AuditAdminPassword123');
    const project = (await call('/api/projects', undefined, 'GET', admin)).body.projects[0];
    async function reader() {
      const registered = await call('/api/users', { username: 'audit-reader', password: 'AuditReaderPassword123' }, 'POST', admin);
      const permissions = Object.fromEntries(['cases', 'defects', 'ai', 'files', 'requirements', 'knowledge'].map((module) => [module, { view: true, write: false }]));
      assert.equal((await call('/api/users/' + registered.body.user.id, { permissions }, 'PUT', admin)).status, 200);
      return { cookie: await login('audit-reader', 'AuditReaderPassword123'), id: registered.body.user.id };
    }
    await run({ directory, base, call, login, admin, project, reader });
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('cloud disk preserves UTF-8 multipart names and original content', async () => fixture(async ({ call, admin }) => {
  const content = '内部测试工具\n保持中文文件名与内容。';
  const form = new FormData(); form.append('file', new Blob([content], { type: 'text/plain' }), '中文测试工具.txt');
  const uploaded = await call('/api/files', form, 'POST', admin);
  assert.equal(uploaded.status, 201); const file = uploaded.body.file;
  assert.equal(file.name, '中文测试工具.txt');
  const downloaded = await call(file.downloadUrl, undefined, 'GET', admin);
  assert.equal(downloaded.status, 200); assert.equal(downloaded.body.toString('utf8'), content);
  assert.ok(downloaded.response.headers.get('content-disposition').includes(encodeURIComponent(file.name)));
}));

test('cloud disk enforces file permissions and cleans oversized uploads and deleted originals', async () => fixture(async ({ directory, call, login, admin, reader }) => {
  const content = Buffer.from([0, 1, 255, 24, 128]);
  const form = new FormData(); form.append('file', new Blob([content]), 'audit-tool.bin');
  const uploaded = await call('/api/files', form, 'POST', admin);
  assert.equal(uploaded.status, 201); const file = uploaded.body.file;
  const readOnly = await reader();
  const downloaded = await call(file.downloadUrl, undefined, 'GET', readOnly.cookie);
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, content);
  const deniedForm = new FormData(); deniedForm.append('file', new Blob(['not allowed']), 'denied.txt');
  assert.equal((await call('/api/files', deniedForm, 'POST', readOnly.cookie)).status, 403);
  assert.equal((await call('/api/files/' + file.id, undefined, 'DELETE', readOnly.cookie)).status, 403);
  assert.equal((await call(file.downloadUrl, undefined, 'GET')).status, 401);
  const before = await fs.readdir(path.join(directory, 'uploads'));
  const oversized = new FormData(); oversized.append('file', new Blob([Buffer.alloc(3 * 1024 * 1024)]), 'oversized.bin');
  assert.equal((await call('/api/files', oversized, 'POST', admin)).status, 413);
  assert.deepEqual(await fs.readdir(path.join(directory, 'uploads')), before);
  assert.equal((await call('/api/users/' + readOnly.id, { permissions: { files: { view: false } } }, 'PUT', admin)).status, 200);
  const denied = await login('audit-reader', 'AuditReaderPassword123');
  assert.equal((await call(file.downloadUrl, undefined, 'GET', denied)).status, 403);
  assert.equal((await call('/api/files/' + file.id, undefined, 'DELETE', admin)).status, 200);
  assert.equal((await call(file.downloadUrl, undefined, 'GET', admin)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(directory, 'uploads')), []);
}));

test('all six defect states persist atomically, while stale, invalid, cross-project and readonly batches leave records unchanged', async () => fixture(async ({ call, admin, project, reader }) => {
  const projectId = project.id;
  const other = (await call('/api/projects', { name: '隔离项目' }, 'POST', admin)).body.project;
  const first = (await call('/api/defects', { projectId, title: '缺陷一', status: '待处理' }, 'POST', admin)).body.defect;
  const second = (await call('/api/defects', { projectId, title: '缺陷二', status: '待处理' }, 'POST', admin)).body.defect;
  const list = async () => (await call('/api/defects?projectId=' + projectId, undefined, 'GET', admin)).body.defects;
  let records = await list();
  for (const status of ['待处理', '处理中', '待验证', '搁置', '已解决', '已关闭']) {
    const items = records.map(({ id, revision }) => ({ id, revision }));
    const result = await call('/api/defects/batch', { projectId, items, action: 'status', status }, 'POST', admin);
    assert.equal(result.status, 200); assert.equal(result.body.count, 2);
    const current = await list();
    assert.ok(current.every((record) => record.status === status && record.revision === records.find((item) => item.id === record.id).revision + 1));
    records = current;
  }
  const items = records.map(({ id, revision }) => ({ id, revision }));
  assert.equal((await call('/api/defects/batch', { projectId, items: [items[0], { ...items[1], revision: 1 }], action: 'status', status: '待处理' }, 'POST', admin)).status, 409);
  assert.equal((await call('/api/defects/batch', { projectId: other.id, items, action: 'status', status: '待处理' }, 'POST', admin)).status, 404);
  assert.equal((await call('/api/defects/batch', { projectId, items, action: 'status', status: '未知状态' }, 'POST', admin)).status, 400);
  const readOnly = await reader();
  assert.equal((await call('/api/defects/batch', { projectId, items, action: 'delete' }, 'POST', readOnly.cookie)).status, 403);
  assert.deepEqual(await list(), records);
  assert.equal((await call('/api/defects/batch', { projectId, items, action: 'delete' }, 'POST', admin)).status, 200);
  assert.deepEqual(await list(), []);
  assert.notEqual(first.id, second.id);
}));

test('archiving a project hides requirements, plans, knowledge and attachments, and restore preserves content and format exports', async () => fixture(async ({ call, login, admin, project, reader }) => {
  const projectId = project.id;
  const form = new FormData(); form.append('projectId', projectId); form.append('title', '归档保留需求'); form.append('file', new Blob(['# 活动\n奖励进入背包。']), '来源.md');
  const requirement = (await call('/api/requirements', form, 'POST', admin)).body.requirement;
  const plan = (await call('/api/test-plans', { projectId, requirementId: requirement.id, title: '归档保留计划', content: '# 范围\n奖励和背包。' }, 'POST', admin)).body.plan;
  const kb = (await call('/api/knowledge-bases', { projectId, name: '归档知识' }, 'POST', admin)).body.knowledgeBase;
  const document = (await call(`/api/knowledge-bases/${kb.id}/documents`, { projectId, title: '技术规则', body: '背包奖励数量增加。' }, 'POST', admin)).body.document;
  const tree = { id: 'archive-root', title: '归档导图', style: { fontSize: '24px', fontWeight: 'bold', color: '#112233' }, children: [{ id: 'archive-child', title: '奖励校验', children: [] }] };
  const set = (await call('/api/cases', { projectId, requirementId: requirement.id, title: '归档导图', tree }, 'POST', admin)).body.case;
  const archived = await call('/api/projects/' + projectId, { revision: project.revision, confirmationName: project.name }, 'DELETE', admin);
  assert.equal(archived.status, 200);
  for (const route of [`/api/requirements/${requirement.id}?projectId=${projectId}`, `/api/test-plans/${plan.id}?projectId=${projectId}`, `/api/knowledge-bases/${kb.id}/documents/${document.id}/chunks?projectId=${projectId}`, requirement.attachments[0].downloadUrl]) assert.equal((await call(route, undefined, 'GET', admin)).status, 400);
  const restored = await call('/api/projects/' + projectId + '/restore', { revision: archived.body.project.revision }, 'POST', admin);
  assert.equal(restored.status, 200);
  assert.equal((await call(`/api/requirements/${requirement.id}?projectId=${projectId}`, undefined, 'GET', admin)).body.requirement.body, requirement.body);
  assert.equal((await call(`/api/test-plans/${plan.id}?projectId=${projectId}`, undefined, 'GET', admin)).body.plan.content, plan.content);
  assert.equal((await call(requirement.attachments[0].downloadUrl, undefined, 'GET', admin)).body.toString('utf8'), '# 活动\n奖励进入背包。');
  const xmind = await call('/api/cases/export', { projectId, items: [{ id: set.id, revision: set.revision }], format: 'xmind' }, 'POST', admin);
  assert.equal(xmind.status, 200); assert.deepEqual(importXmind(xmind.body)[0].tree.style, tree.style);
  const markdown = await call('/api/cases/export', { projectId, items: [{ id: set.id, revision: set.revision }], format: 'md' }, 'POST', admin);
  assert.match(markdown.body.toString('utf8'), /奖励校验/);
  const importForm = (requirementId) => { const body = new FormData(); body.append('projectId', projectId); body.append('requirementId', requirementId); body.append('file', new Blob([xmind.body]), '关联用例.xmind'); return body; };
  const imported = await call('/api/cases/import', importForm(requirement.id), 'POST', admin);
  assert.equal(imported.status, 201); assert.equal(imported.body.cases[0].requirementId, requirement.id);
  const filtered = (await call(`/api/cases?projectId=${projectId}&requirementId=${requirement.id}`, undefined, 'GET', admin)).body.cases;
  assert.ok(filtered.some((item) => item.id === imported.body.cases[0].id));
  const other = (await call('/api/projects', { name: '其他关联范围' }, 'POST', admin)).body.project;
  const wrongRequirement = (await call('/api/requirements', { projectId: other.id, title: '其他需求', body: '其他范围' }, 'POST', admin)).body.requirement;
  assert.equal((await call('/api/cases/import', importForm(wrongRequirement.id), 'POST', admin)).status, 400);
  const readOnly = await reader();
  assert.equal((await call('/api/users/' + readOnly.id, { permissions: { cases: { view: true, write: true }, requirements: { view: false } } }, 'PUT', admin)).status, 200);
  const casesWriterWithoutRequirements = await login('audit-reader', 'AuditReaderPassword123');
  assert.equal((await call('/api/cases/import', importForm(requirement.id), 'POST', casesWriterWithoutRequirements)).status, 403);
}));
