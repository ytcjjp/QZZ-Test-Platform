import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { initializeCaseSets } from '../case-sets.js';
import { initializeProjects } from '../projects.js';
import { uploadFilename } from '../upload-name.js';
import { blankTree, normalizeTree, importMarkdown, importXmind, exportMarkdown, exportXmind, FORMAT_LIMITS } from '../mindmap-formats.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const titles = (node) => ({ title: node.title, children: node.children.map(titles) });

test('upload names decode UTF-8 multipart headers while preserving Unicode and other valid names', () => {
  assert.equal(uploadFilename(Buffer.from('中文用例集.md').toString('latin1')), '中文用例集.md');
  assert.equal(uploadFilename('中文用例集.md'), '中文用例集.md');
  assert.equal(uploadFilename('résumé.md'), 'résumé.md');
  assert.equal(uploadFilename('C:\\docs\\用例.md'), '用例.md');
});

test('case set migration preserves legacy identity, revision and text and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT, module TEXT, priority TEXT, status TEXT,
      preconditions TEXT, steps TEXT, expected TEXT, notes TEXT, tags TEXT, revision INTEGER, updated_at TEXT);
      INSERT INTO cases VALUES ('old', '奖励校验', '活动', 'P1', '通过', '已参与', '领取', '奖励到账', '保留备注', '["回归"]', 7, '2026-01-01');`);
    const before = db.prepare('SELECT * FROM cases').get();
    initializeCaseSets(db);
    const { tree, ...after } = db.prepare('SELECT * FROM cases').get();
    assert.deepEqual(after, before);
    assert.match(tree, /前置条件：已参与/);
    assert.match(tree, /执行步骤：领取/);
    assert.match(tree, /预期结果：奖励到账/);
    assert.match(tree, /备注：保留备注/);
    initializeCaseSets(db);
    assert.equal(db.prepare('SELECT tree FROM cases').get().tree, tree);
  } finally { db.close(); }
});

test('Markdown and real multi-sheet XMind roundtrip nested titles and reject invalid archives/maps', () => {
  const tree = blankTree('奖励 & A_[B]');
  const branch = blankTree('主流程');
  tree.children.push(branch, blankTree('UI'));
  const child = blankTree('TC-01 标题 *保留*');
  child.children.push(blankTree('前置条件：已开启\n次行'), blankTree('执行步骤：领取 <奖励>'), blankTree('预期结果：到账'));
  branch.children.push(child);
  const md = exportMarkdown(tree);
  assert.deepEqual(titles(importMarkdown(md)[0].tree), titles(tree));
  const xmind = exportXmind([{ title: '奖励', tree }, { title: '空白', tree: blankTree('空白') }]);
  const sheets = importXmind(xmind);
  assert.equal(sheets.length, 2);
  assert.deepEqual(titles(sheets[0].tree), titles(tree));
  assert.ok(unzipSync(xmind)['manifest.json']);
  const xml = '<?xml version="1.0"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet id="s"><title>旧版画布</title><topic id="r"><title>中心</title><children><topics type="attached"><topic id="t"><title>分支</title></topic></topics></children></topic></sheet></xmap-content>';
  const legacy = importXmind(zipSync({ 'content.xml': strToU8(xml) }));
  assert.equal(legacy[0].tree.children[0].title, '分支');
  assert.throws(() => importXmind(strToU8('not a zip')));
  assert.throws(() => importXmind(zipSync({ 'content.json': strToU8('{}') })));
  assert.throws(() => importXmind(zipSync({ 'content.xml': strToU8('<!DOCTYPE x><x/>') })));
  assert.throws(() => normalizeTree({ id: 'same', title: 'a', children: [{ id: 'same', title: 'b' }] }));
  let deep = blankTree('root'); const over = deep;
  for (let i = 0; i < 66; i++) { const next = blankTree('child'); deep.children.push(next); deep = next; }
  assert.throws(() => normalizeTree(over));
});

test('export budgets reject highly compressed multi-sheet maps before producing files that cannot be reimported', () => {
  const tree = blankTree('大用例集');
  tree.children = Array.from({ length: 17 }, () => blankTree('a'.repeat(29400)));
  normalizeTree(tree);
  const sets = Array.from({ length: 18 }, (_, index) => ({ title: `集合${index}`, tree }));
  const bytes = sets.reduce((sum, set) => sum + Buffer.byteLength(JSON.stringify(set.tree)), 0);
  assert.ok(bytes > FORMAT_LIMITS.contentBytes && bytes < 16 * 1024 * 1024);
  assert.throws(() => exportXmind(sets), (error) => error.status === 413 && /分批/.test(error.message));
  const accepted = sets.slice(0, 16);
  const output = exportXmind(accepted);
  assert.ok(output.byteLength < 100000);
  assert.equal(importXmind(output).length, accepted.length);

  const crowded = blankTree('多节点');
  crowded.children = Array.from({ length: 2499 }, () => ({ ...blankTree('p'), children: [blankTree('c')] }));
  normalizeTree(crowded);
  const size = Buffer.byteLength(JSON.stringify(crowded));
  const copies = Array.from({ length: Math.floor(FORMAT_LIMITS.contentBytes / size) }, (_, index) => ({ title: String(index), tree: crowded }));
  assert.ok(copies.reduce((sum, set) => sum + Buffer.byteLength(JSON.stringify(set.tree)), 0) <= FORMAT_LIMITS.contentBytes);
  assert.throws(() => exportXmind(copies), (error) => error.status === 413 && /主题内容/.test(error.message));
  assert.throws(() => exportXmind(Array.from({ length: 101 }, () => ({ title: 'x', tree: blankTree('x') }))), /100 个画布/);

  const escaped = blankTree('转义文本');
  escaped.children = Array.from({ length: 17 }, () => blankTree('&'.repeat(29400)));
  assert.throws(() => exportMarkdown(escaped), (error) => error.status === 413 && /2 MB/.test(error.message));
  const emptyBranch = { ...blankTree('空主题'), children: [blankTree(''), { ...blankTree('分支'), children: [blankTree('内容')] }] };
  assert.deepEqual(titles(importMarkdown(exportMarkdown(emptyBranch))[0].tree), titles(emptyBranch));
  const deep = blankTree('根'); let cursor = deep;
  for (let index = 0; index < 64; index++) { const child = blankTree('深层'); cursor.children.push(child); cursor = child; }
  assert.deepEqual(titles(importMarkdown(exportMarkdown(deep))[0].tree), titles(deep));
});

async function launch(dataDir) {
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], { cwd: os.tmpdir(), env: { ...process.env, PORT: '0', QZZ_DATA_DIR: dataDir, ADMIN_PASSWORD: 'SetTestPassword123' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || 'server timeout')); }, 10000);
    child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  return { child, url };
}

test('set CRUD/import/export, atomic batches, read-only export and project delete/restore preserve access boundaries', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-case-sets-'));
  let child;
  try {
    const started = await launch(dataDir); child = started.child;
    const base = started.url;
    let cookie;
    async function call(route, body, method = 'POST', auth = cookie) {
      const response = await fetch(base + route, { method, headers: { ...(auth ? { cookie: auth } : {}), ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), response };
    }
    const login = await call('/api/session', { username: 'admin', password: 'SetTestPassword123' });
    cookie = login.response.headers.get('set-cookie').split(';')[0];
    const project = (await call('/api/projects', undefined, 'GET')).body.projects[0];
    const projectId = project.id;
    const projectB = (await call('/api/projects', { name: '另一项目' })).body.project;
    const created = await call('/api/cases', { projectId, title: '空白用例集' });
    assert.equal(created.status, 201);
    let set = created.body.case;
    assert.equal(set.tree.title, '空白用例集'); assert.deepEqual(set.tree.children, []);
    assert.equal((await call('/api/cases', { title: '无项目' })).status, 400);
    const tree = { ...set.tree, children: [blankTree('主流程')] };
    const edited = await call('/api/cases/' + set.id, { projectId, revision: set.revision, tree }, 'PUT');
    assert.equal(edited.status, 200); set = edited.body.case;
    assert.equal((await call('/api/cases/' + set.id, { projectId, revision: 1, title: '丢失更新' }, 'PUT')).status, 409);
    assert.equal((await call('/api/cases/' + set.id, { projectId: projectB.id, revision: set.revision, tree }, 'PUT')).status, 404);
    const selected = [{ id: set.id, revision: set.revision }];
    const exported = await call('/api/cases/export', { projectId, items: selected, format: 'xmind' });
    assert.equal(exported.status, 200); assert.equal(importXmind(exported.body)[0].tree.children[0].title, '主流程');
    const form = new FormData(); form.append('projectId', projectId); form.append('file', new Blob([exported.body]), 'roundtrip.xmind');
    const imported = await call('/api/cases/import', form);
    assert.equal(imported.status, 201); assert.equal(imported.body.cases.length, 1);
    assert.deepEqual(titles(imported.body.cases[0].tree), titles(set.tree));
    const malformed = new FormData(); malformed.append('projectId', projectId); malformed.append('file', new Blob(['bad']), 'bad.xmind');
    assert.equal((await call('/api/cases/import', malformed)).status, 400);
    const mdform = new FormData(); mdform.append('projectId', projectId); mdform.append('file', new Blob(['- 主流程\n  - 展示\n    - 预期结果：正确']), '中文用例集.md');
    const importedMd = await call('/api/cases/import', mdform);
    assert.equal(importedMd.status, 201);
    assert.equal(importedMd.body.cases[0].title, '中文用例集');
    assert.equal(importedMd.body.cases[0].tree.title, '中文用例集');
    const defect = (await call('/api/defects', { projectId, title: '崩溃问题' })).body.defect;
    const defect2 = (await call('/api/defects', { projectId, title: '显示问题' })).body.defect;
    assert.equal((await call('/api/defects/batch', { projectId, items: [{ id: defect.id, revision: defect.revision }, { id: defect2.id, revision: 99 }], action: 'status', status: '处理中' })).status, 409);
    let defects = (await call('/api/defects?projectId=' + projectId, undefined, 'GET')).body.defects;
    assert.equal(defects.find((item) => item.id === defect.id).revision, 1);
    assert.equal((await call('/api/defects/batch', { projectId, items: defects.map(({ id, revision }) => ({ id, revision })), action: 'status', status: '处理中' })).status, 200);
    defects = (await call('/api/defects?projectId=' + projectId, undefined, 'GET')).body.defects;
    assert.ok(defects.every((item) => item.status === '处理中' && item.revision === 2));
    assert.equal((await call('/api/defects/batch', { projectId, items: [{ id: defect.id, revision: 2 }], action: 'status', status: 'unknown' })).status, 400);
    assert.equal((await call('/api/cases/batch', { projectId: projectB.id, items: selected, action: 'delete' })).status, 404);
    assert.equal((await call('/api/cases/batch', { projectId, items: [selected[0], { id: imported.body.cases[0].id, revision: 99 }], action: 'delete' })).status, 409);
    assert.equal((await call('/api/cases?projectId=' + projectId, undefined, 'GET')).body.cases.length, 3);
    const registration = await call('/api/register', { username: 'viewonly', password: 'ViewerPassword123' });
    const viewerCookie = registration.response.headers.get('set-cookie').split(';')[0];
    await call('/api/users/' + registration.body.user.id, { permissions: { cases: { view: true, write: false }, defects: { view: true, write: false } } }, 'PUT');
    const viewerLogin = await call('/api/session', { username: 'viewonly', password: 'ViewerPassword123' });
    const viewer = viewerLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/cases/export', { projectId, items: selected, format: 'md' }, 'POST', viewer)).status, 200);
    assert.equal((await call('/api/cases/batch', { projectId, items: selected, action: 'delete' }, 'POST', viewer)).status, 403);
    assert.equal((await call('/api/projects/' + projectId, { revision: project.revision, confirmationName: project.name }, 'DELETE', viewer)).status, 403);
    assert.equal((await call('/api/projects/' + projectId, { revision: project.revision, confirmationName: 'wrong' }, 'DELETE')).status, 400);
    const deleted = await call('/api/projects/' + projectId, { revision: project.revision, confirmationName: project.name }, 'DELETE');
    assert.equal(deleted.status, 200); assert.ok(deleted.body.project.deletedAt);
    assert.equal((await call('/api/projects', undefined, 'GET')).body.projects.length, 1);
    assert.equal((await call('/api/cases?projectId=' + projectId, undefined, 'GET')).status, 400);
    assert.equal((await call('/api/projects?archived=1', undefined, 'GET', viewer)).status, 403);
    const archived = (await call('/api/projects?archived=1', undefined, 'GET')).body.projects;
    assert.equal(archived.length, 1); assert.equal(archived[0].caseCount, 3);
    assert.equal((await call('/api/projects', { name: project.name })).status, 409);
    const restored = await call('/api/projects/' + projectId + '/restore', { revision: deleted.body.project.revision });
    assert.equal(restored.status, 200); assert.equal(restored.body.project.deletedAt, null);
    assert.equal((await call('/api/cases?projectId=' + projectId, undefined, 'GET')).body.cases.length, 3);
    assert.equal((await call('/api/cases/batch', { projectId, items: selected, action: 'delete' })).status, 200);
    assert.equal((await call('/api/cases?projectId=' + projectId, undefined, 'GET')).body.cases.length, 2);
    assert.equal((await call('/api/defects/batch', { projectId, items: defects.map(({ id, revision }) => ({ id, revision })), action: 'delete' })).status, 200);
    assert.equal((await call('/api/defects?projectId=' + projectId, undefined, 'GET')).body.defects.length, 0);
  } finally {
    if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('deleting all project groups does not silently recreate a default on restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-project-archive-'));
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cases(id TEXT,updated_at TEXT); CREATE TABLE defects(id TEXT,updated_at TEXT)');
    initializeProjects(db, dataDir);
    db.prepare('UPDATE projects SET deleted_at = ?').run(new Date().toISOString());
    initializeProjects(db, dataDir);
    assert.equal(db.prepare('SELECT count(*) n FROM projects').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM projects WHERE deleted_at IS NULL').get().n, 0);
  } finally { db.close(); await rm(dataDir, { recursive: true, force: true }); }
});
