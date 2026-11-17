import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { initializeCaseExecutions, registerCaseExecutionRoutes } from '../case-executions.js';

const leaf = (id, title = id) => ({ id, title, children: [] });
const tree = { id: 'root', title: '活动用例', children: [leaf('first'), leaf('second'), leaf('__proto__')] };
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-case-executions-'));
  const file = path.join(directory, 'platform.db'); const db = new Database(file);
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES('admin','admin'),('writer','测试人员'),('reader','只读人员'),('denied','无权限');
    CREATE TABLE projects(id TEXT PRIMARY KEY,deleted_at TEXT); INSERT INTO projects VALUES('a',NULL),('b',NULL),('archived','2026-01-01');
    CREATE TABLE cases(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),tree TEXT,revision INTEGER,title TEXT,notes TEXT,updated_at TEXT);`);
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?,?,?)').run('set-a', 'a', JSON.stringify(tree), 7, '历史用例集', '保留原始备注', '2026-01-01');
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?,?,?)').run('set-b', 'b', JSON.stringify(tree), 1, '另一个项目', '', '2026-01-01');
  const users = {
    admin: { id: 'admin', role: 'admin', permissions: {} },
    writer: { id: 'writer', role: 'member', permissions: { cases: { view: true, write: true } } },
    reader: { id: 'reader', role: 'member', permissions: { cases: { view: true, write: false } } },
    denied: { id: 'denied', role: 'member', permissions: { cases: { view: false, write: false } } },
  };
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = users[req.headers['x-user']]; next(); });
  const events = [];
  const projects = { requireProject(id) { if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('invalid project'); return id; } };
  const service = registerCaseExecutionRoutes(app, { db, projects, broadcast: (type, details) => events.push({ type, ...details }) });
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, body, method = body === undefined ? 'GET' : 'PUT', user = 'writer') {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, response, body: await response.json() };
  }
  try { await run({ db, file, service, call, users, events }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test('node execution statuses persist all three states and independent revisions without modifying the case tree or legacy data', async () => fixture(async ({ db, file, call, events }) => {
  const before = db.prepare('SELECT * FROM cases WHERE id=?').get('set-a');
  const route = '/api/cases/set-a/node-statuses';
  const initial = await call(route + '?projectId=a');
  assert.equal(initial.status, 200); assert.deepEqual(initial.body.statuses, []); assert.equal(initial.body.caseRevision, 7); assert.equal(initial.response.headers.get('cache-control'), 'no-store');
  let status = (await call(route + '/first', { projectId: 'a', status: '测试通过', revision: 0 })).body.nodeStatus;
  assert.deepEqual({ ...status, updatedAt: '' }, { nodeId: 'first', status: '测试通过', revision: 1, updatedAt: '', updatedBy: '测试人员' });
  const conflict = await call(route + '/first', { projectId: 'a', status: '跳过', revision: 0 });
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.body.nodeStatus, status);
  status = (await call(route + '/first', { projectId: 'a', status: '跳过', revision: status.revision })).body.nodeStatus;
  assert.equal(status.revision, 2);
  const unchanged = await call(route + '/first', { projectId: 'a', status: '跳过', revision: 2 });
  assert.deepEqual(unchanged.body.nodeStatus, status); assert.equal(events.length, 2);
  status = (await call(route + '/first', { projectId: 'a', status: '待测试' })).body.nodeStatus;
  assert.equal(status.revision, 3); assert.equal(status.status, '待测试');
  assert.deepEqual(db.prepare('SELECT * FROM cases WHERE id=?').get('set-a'), before);
  initializeCaseExecutions(db); initializeCaseExecutions(db);
  const reopened = new Database(file);
  try { initializeCaseExecutions(reopened); assert.deepEqual(reopened.prepare('SELECT node_id,status,revision FROM case_node_statuses').all(), [{ node_id: 'first', status: '待测试', revision: 3 }]); }
  finally { reopened.close(); }
  assert.deepEqual(events[0], { type: 'case.node-status-updated', projectId: 'a', caseId: 'set-a', nodeStatus: { ...events[0].nodeStatus, nodeId: 'first', status: '测试通过', revision: 1, updatedBy: '测试人员' } });
  assert.ok(!Object.hasOwn(events[0], 'tree'));
}));

test('node status APIs enforce account, project, node and write permissions and reject invalid states or stale CAS without side effects', async () => fixture(async ({ db, call, users, events }) => {
  const route = '/api/cases/set-a/node-statuses';
  assert.equal((await call(route + '?projectId=a', undefined, 'GET', null)).status, 401);
  assert.equal((await call(route + '?projectId=a', undefined, 'GET', 'reader')).status, 200);
  assert.equal((await call(route + '?projectId=a', undefined, 'GET', 'denied')).status, 403);
  assert.equal((await call(route + '/first', { projectId: 'a', status: '测试通过' }, 'PUT', 'reader')).status, 403);
  users.writer.permissions.cases.view = false;
  assert.equal((await call(route + '/first', { projectId: 'a', status: '测试通过' })).status, 403);
  users.writer.permissions.cases.view = true;
  for (const suffix of ['', '?projectId=missing', '?projectId=archived']) assert.equal((await call(route + suffix)).status, 400);
  assert.equal((await call(route + '?projectId=b')).status, 404);
  assert.equal((await call('/api/cases/unknown/node-statuses?projectId=a')).status, 404);
  assert.equal((await call(route + '/missing', { projectId: 'a', status: '测试通过' })).status, 404);
  assert.equal((await call(route + '/first', { projectId: 'b', status: '测试通过' })).status, 404);
  for (const status of ['测试失败', 'passed', '', null, {}, ['跳过']]) assert.equal((await call(route + '/first', { projectId: 'a', status })).status, 400);
  for (const revision of [-1, null, '0', 1.5]) assert.equal((await call(route + '/first', { projectId: 'a', status: '跳过', revision })).status, 400);
  assert.equal((await call(route + '/first', { projectId: 'a', status: '跳过', revision: 2 })).status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM case_node_statuses').get().n, 0); assert.deepEqual(events, []);
  const safeId = await call(route + '/__proto__', { projectId: 'a', status: '跳过' }, 'PUT', 'admin');
  assert.equal(safeId.status, 200); assert.equal(safeId.body.nodeStatus.nodeId, '__proto__');
  assert.equal((await call(route + '?projectId=a')).body.statuses[0].nodeId, '__proto__');
}));

test('removed nodes cannot retain visible states, pruning preserves existing IDs, archive restore retains records and deleting a case cascades', async () => fixture(async ({ db, service, call }) => {
  const route = '/api/cases/set-a/node-statuses';
  await call(route + '/first', { projectId: 'a', status: '测试通过' });
  await call(route + '/second', { projectId: 'a', status: '跳过' });
  const edited = { ...tree, children: [leaf('second', '重命名但节点 ID 保留')] };
  db.prepare('UPDATE cases SET tree=?,revision=revision+1 WHERE id=?').run(JSON.stringify(edited), 'set-a');
  const visible = await call(route + '?projectId=a');
  assert.deepEqual(visible.body.statuses.map(({ nodeId }) => nodeId), ['second']); assert.equal(visible.body.caseRevision, 8);
  assert.equal((await call(route + '/first', { projectId: 'a', status: '待测试' })).status, 404);
  assert.deepEqual(service.prune('set-a', edited), { deleted: 1 }); assert.deepEqual(service.prune('set-a', edited), { deleted: 0 });
  assert.equal(db.prepare('SELECT count(*) n FROM case_node_statuses').get().n, 1);
  db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run('2026-11-17', 'a');
  assert.equal((await call(route + '?projectId=a')).status, 400);
  assert.equal((await call(route + '/second', { projectId: 'a', status: '待测试' })).status, 400);
  db.prepare('UPDATE projects SET deleted_at=NULL WHERE id=?').run('a');
  assert.equal((await call(route + '?projectId=a')).body.statuses[0].status, '跳过');
  db.prepare('DELETE FROM cases WHERE id=?').run('set-a');
  assert.equal(db.prepare('SELECT count(*) n FROM case_node_statuses').get().n, 0);
  assert.equal((await call(route + '?projectId=a')).status, 404);
}));
