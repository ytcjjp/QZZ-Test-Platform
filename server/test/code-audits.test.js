import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { registerCodeAuditRoutes } from '../code-audits.js';
import { inspectCodeSource } from '../code-audit-sources.js';

const projectId = '11111111-2222-4333-8444-555555555555';
const otherProjectId = 'aaaaaaaa-2222-4333-8444-555555555555';
const caseId = 'case-1';
const nodeId = 'node-1';
const file = { path: 'assets/Activity.prefab', content: 'resource: missing-guid\nif (flag) enableBonus();', truncated: false };
const verified = { id: 'a'.repeat(24), caseId: nodeId, title: '活动图片引用缺失',
  rule: 'missing-resource', expected: '资源引用应存在。', actual: '资源 GUID 没有匹配的资源。',
  evidence: [{ path: file.path, line: 1, excerpt: 'missing-guid' }] };
const candidate = { caseId: nodeId, title: '奖励按钮可能重复提交', rule: 'double-submit',
  expected: '连续点击只提交一次。', actual: '目前代码路径未见防重入保护。',
  evidence: [{ path: file.path, line: 2, excerpt: 'enableBonus()' }] };
const tree = { id: 'root', title: '活动用例', children: [{ id: 'branch', title: 'UI', children: [
  { id: nodeId, title: '资源与奖励按钮', children: [
    { id: 'pre', title: '前置条件：进入活动界面。', children: [] },
    { id: 'step', title: '执行步骤：检查图片并连续点击奖励按钮。', children: [] },
    { id: 'expected', title: '预期结果：图片显示且奖励只提交一次。', children: [] },
  ] },
] }] };

function setup({ inspect, realScan = false, legacySchema = false, runCodex = async () => ({ findings: [candidate] }) } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-code-audit-'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-code-source-'));
  const db = new Database(path.join(dataDir, 'audit.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE cases(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, tree TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE defects(id TEXT PRIMARY KEY, title TEXT, issue_type TEXT, module TEXT, severity TEXT,
      status TEXT, assignee TEXT, version TEXT, repro_steps TEXT, expected TEXT, actual TEXT, notes TEXT,
      revision INTEGER, created_by TEXT REFERENCES users(id), created_at TEXT, updated_at TEXT, project_id TEXT REFERENCES projects(id));`);
  for (const id of ['admin', 'member']) db.prepare('INSERT INTO users VALUES (?)').run(id);
  for (const id of [projectId, otherProjectId]) db.prepare('INSERT INTO projects VALUES (?)').run(id);
  db.prepare('INSERT INTO cases VALUES (?,?,?,?,?)').run(caseId, projectId, '活动用例集', JSON.stringify(tree), 1);
  if (legacySchema) {
    db.exec(`CREATE TABLE code_audit_sources (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), label TEXT NOT NULL,
      kind TEXT NOT NULL, location TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, deleted_at TEXT
    ); CREATE TABLE code_audit_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      source_id TEXT NOT NULL REFERENCES code_audit_sources(id), case_id TEXT NOT NULL ${legacySchema === 'linkOnly' ? '' : 'REFERENCES cases(id)'},
      case_revision INTEGER NOT NULL, revision TEXT, base_revision TEXT, state TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', changed_paths_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]', coverage_json TEXT NOT NULL DEFAULT '{}',
      findings_json TEXT NOT NULL DEFAULT '[]', error TEXT, auto_create_verified INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL REFERENCES users(id), started_at TEXT NOT NULL, finished_at TEXT
    ); CREATE TABLE code_audit_defects (
      run_id TEXT NOT NULL REFERENCES code_audit_runs(id),
      project_id TEXT NOT NULL REFERENCES projects(id), source_id TEXT NOT NULL REFERENCES code_audit_sources(id),
      case_id TEXT NOT NULL REFERENCES cases(id), fingerprint TEXT NOT NULL,
      defect_id TEXT NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (run_id, fingerprint)
    )`);
    db.prepare('INSERT INTO code_audit_sources VALUES (?,?,?,?,?,?,?,NULL)').run('legacy-source', projectId, '旧代码源', 'local', sourceDir, 'admin', '2026-01-01');
    db.prepare("INSERT INTO defects(id,created_by,project_id,status) VALUES ('legacy-defect','admin',?,'待处理')").run(projectId);
    db.prepare(`INSERT INTO code_audit_runs
      (id,project_id,source_id,case_id,case_revision,revision,state,findings_json,created_by,started_at)
      VALUES ('legacy-run',?,?,?,1,?,'completed',?, 'admin','2026-01-01')`)
      .run(projectId, 'legacy-source', caseId, 'a'.repeat(40), JSON.stringify([{ ...verified, kind: 'verified', id: 'v-legacy-finding', caseTitle: '活动资源 UI' }]));
    db.prepare("INSERT INTO code_audit_defects VALUES ('legacy-run',?,?,?,?,?, '2026-01-01')")
      .run(projectId, 'legacy-source', caseId, 'v-legacy-finding', 'legacy-defect');
  }
  const people = {
    admin: { id: 'admin', role: 'admin' },
    member: { id: 'member', role: 'member', permissions: { ai: { view: true, write: true },
      cases: { view: true, write: false }, defects: { view: true, write: true } } },
  };
  const events = []; const notices = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = people[req.get('x-user') || 'member'];
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const sendError = (res, status, code, message) => res.status(status).json({ error: code, message });
  const permission = (module, action) => (req, res, next) => req.user.role === 'admin' || req.user.permissions?.[module]?.[action]
    ? next() : sendError(res, 403, 'forbidden', '没有权限');
  const auditService = registerCodeAuditRoutes(app, { db, dataDir, requireProject: (value) => {
    if (![projectId, otherProjectId].includes(value)) throw Object.assign(new Error('项目组不存在'), { status: 404, publicMessage: '项目组不存在' });
    return value;
  }, authenticate: (req) => people[req.get('x-user') || 'member'], sendError, requirePermission: permission,
  requireAdmin: (req, res, next) => req.user.role === 'admin' ? next() : sendError(res, 403, 'forbidden', '仅管理员'),
  getCase: db.prepare('SELECT * FROM cases WHERE id=?'), getDefect: db.prepare('SELECT * FROM defects WHERE id=?'),
  mapDefect: (row) => ({ id: row.id, projectId: row.project_id, title: row.title, notes: row.notes, version: row.version }),
  broadcast: (type, payload) => events.push({ type, payload }), notifyDefect: (type, payload) => notices.push({ type, payload }),
  inspect: realScan ? inspectCodeSource : inspect || (async (_source, { previousRevision }) => ({ revision: previousRevision ? 'b'.repeat(40) : 'a'.repeat(40),
    changedPaths: [file.path], files: [file], verifiedFindings: [previousRevision ? { ...verified, title: '活动图片引用仍缺失' } : verified],
    warnings: [], coverage: { scanned: 1, truncated: true } })),
  runCodex, loadProvider: () => ({ mode: 'codex', apiKey: 'test-only', projectRoot: sourceDir, dataDir,
    baseUrl: 'https://test.invalid/v1/', model: 'fixture' }) });
  app.use((error, _req, res, _next) => sendError(res, error.status || 500, 'error', error.publicMessage || 'unexpected'));
  let server;
  async function start() {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function request(url, pathname, { method = 'GET', body, user = 'member' } = {}) {
    const response = await fetch(`${url}${pathname}`, { method, headers: { 'x-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function untilFinished(url, id, user = 'member') {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(url, `/api/code-audit/runs/${id}?projectId=${projectId}`, { user });
      if (result.body.run?.state !== 'running') return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('audit run did not finish');
  }
  async function close() {
    await auditService.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  return { db, sourceDir, people, notices, events, auditService, start, request, untilFinished, close };
}

async function addSource(context, url) {
  const result = await context.request(url, '/api/code-audit/sources', { method: 'POST', user: 'admin',
    body: { projectId, label: '活动工程', kind: 'local', location: context.sourceDir } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.source;
}

test('only admins register and retire sources; project boundaries and historical runs remain intact', async () => {
  const context = setup();
  try {
    const url = await context.start();
    const payload = { projectId, label: '活动工程', kind: 'local', location: context.sourceDir };
    assert.equal((await context.request(url, '/api/code-audit/sources', { method: 'POST', body: payload })).status, 403);
    const source = await addSource(context, url);
    const member = await context.request(url, `/api/code-audit/sources?projectId=${projectId}`);
    assert.equal(member.body.sources.length, 1);
    assert.equal(member.body.sources[0].location, undefined);
    assert.equal((await context.request(url, `/api/code-audit/sources?projectId=${projectId}`, { user: 'admin' })).body.sources[0].location, context.sourceDir);
    assert.deepEqual((await context.request(url, `/api/code-audit/sources?projectId=${otherProjectId}`)).body.sources, []);
    assert.equal((await context.request(url, '/api/code-audit/runs', { method: 'POST', body: { projectId: otherProjectId,
      sourceId: source.id, caseId } })).status, 404);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST', body: { projectId, sourceId: source.id, caseId } });
    assert.equal(launched.status, 202);
    await context.untilFinished(url, launched.body.run.id);
    assert.equal((await context.request(url, `/api/code-audit/sources/${source.id}`, { method: 'DELETE', body: { projectId } })).status, 403);
    assert.equal((await context.request(url, `/api/code-audit/sources/${source.id}`, { method: 'DELETE', user: 'admin', body: { projectId } })).status, 200);
    assert.deepEqual((await context.request(url, `/api/code-audit/sources?projectId=${projectId}`)).body.sources, []);
    assert.equal((await context.request(url, `/api/code-audit/runs/${launched.body.run.id}?projectId=${projectId}`)).body.run.sourceLabel, '活动工程');
    assert.equal((await context.request(url, '/api/code-audit/runs', { method: 'POST', body: { projectId, sourceId: source.id, caseId } })).status, 404);
  } finally { await context.close(); }
});

test('verified findings auto-create one defect and AI candidates require review; both deduplicate across runs', async () => {
  const context = setup();
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const requestRun = () => context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
    const first = await requestRun();
    assert.equal(first.status, 202);
    const result = (await context.untilFinished(url, first.body.run.id)).body.run;
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.sourceLabel, '活动工程');
    assert.equal(result.findings.length, 2);
    assert.deepEqual(result.coverage.caseResults.map((item) => item.result), ['静态缺陷']);
    assert.equal(result.coverage.truncated, true);
    const issue = result.findings.find((item) => item.kind === 'verified');
    const suspicion = result.findings.find((item) => item.kind === 'candidate');
    assert.ok(issue.defectId);
    assert.equal(suspicion.defectId, null);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 1);
    assert.equal(context.notices.length, 1);
    const promote = () => context.request(url, `/api/code-audit/runs/${result.id}/findings/${suspicion.id}/defect`,
      { method: 'POST', body: { projectId } });
    const created = await promote();
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.defect.notes, /未运行 Cocos、Unity 或游戏/);
    assert.equal((await promote()).status, 200);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 2);
    const second = await requestRun();
    const repeated = (await context.untilFinished(url, second.body.run.id)).body.run;
    assert.equal(repeated.state, 'completed');
    assert.equal(repeated.findings.find((item) => item.kind === 'verified').defectId, issue.defectId);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 2);
    assert.equal(context.notices.length, 2);
    context.db.prepare("UPDATE defects SET status='已关闭' WHERE id=?").run(issue.defectId);
    const third = await requestRun();
    const recurred = (await context.untilFinished(url, third.body.run.id)).body.run;
    const newIssue = recurred.findings.find((item) => item.kind === 'verified');
    assert.notEqual(newIssue.defectId, issue.defectId);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 3);
    assert.equal(context.notices.length, 3);
    assert.equal((await context.request(url, `/api/code-audit/runs/${result.id}?projectId=${projectId}`)).body.run
      .findings.find((item) => item.kind === 'verified').defectId, issue.defectId);
    assert.equal((await context.request(url, `/api/code-audit/runs?projectId=${projectId}`)).body.runs.length, 3);
  } finally { await context.close(); }
});

test('case edits and revoked permissions while scanning prevent stale results and automatic defects', async () => {
  let release;
  const context = setup({ inspect: () => new Promise((resolve) => { release = resolve; }) });
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const begin = async () => {
      const result = await context.request(url, '/api/code-audit/runs', { method: 'POST',
        body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
      assert.equal(result.status, 202);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
      return result.body.run.id;
    };
    const changed = await begin();
    context.db.prepare('UPDATE cases SET revision=revision+1 WHERE id=?').run(caseId);
    release({ revision: 'a'.repeat(40), changedPaths: [file.path], files: [file], verifiedFindings: [verified] });
    assert.equal((await context.untilFinished(url, changed)).body.run.state, 'failed');
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 0);
    release = null;
    const revoked = await begin();
    context.people.member.permissions.ai.write = false;
    release({ revision: 'b'.repeat(40), changedPaths: [file.path], files: [file], verifiedFindings: [verified] });
    assert.equal((await context.untilFinished(url, revoked)).body.run.state, 'failed');
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 0);
  } finally { await context.close(); }
});

test('source failures are persisted without calling a model or creating a defect', async () => {
  let modelCalled = false;
  const context = setup({ inspect: async () => { throw new Error('source unreachable'); },
    runCodex: async () => { modelCalled = true; return { findings: [] }; } });
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST', body: { projectId, sourceId: source.id, caseId } });
    assert.equal(launched.status, 202);
    const result = (await context.untilFinished(url, launched.body.run.id)).body.run;
    assert.equal(result.state, 'failed');
    assert.equal(modelCalled, false);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 0);
  } finally { await context.close(); }
});

test('AI claims without an exact file and line are discarded, never marked as passed or auto-created', async () => {
  const context = setup({ inspect: async () => ({ revision: 'a'.repeat(40), changedPaths: [file.path], files: [file],
    verifiedFindings: [], warnings: [], coverage: { truncated: false } }),
  runCodex: async () => ({ findings: [{ ...candidate, evidence: [{ path: file.path, line: 99, excerpt: 'not in file' }] }] }) });
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
    const result = (await context.untilFinished(url, launched.body.run.id)).body.run;
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.caseResults[0].result, '未验证');
    assert.match(result.warnings.join(' '), /缺少可核对的文件行号/);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 0);
  } finally { await context.close(); }
});

test('actual local Cocos asset scan flows through case linkage into one evidence-backed defect', async () => {
  const context = setup({ realScan: true, runCodex: async () => ({ findings: [] }) });
  try {
    const assetDir = path.join(context.sourceDir, 'code', 'assets', 'Event');
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(context.sourceDir, 'code', 'project.json'), '{"engine":"cocos-creator-js"}');
    fs.writeFileSync(path.join(assetDir, 'NewView.prefab'), '[{"__type__":"cc.Node","_name":"Root"}]\n');
    const adjusted = structuredClone(tree);
    adjusted.children[0].children[0].title = '活动资源 UI';
    context.db.prepare('UPDATE cases SET tree=? WHERE id=?').run(JSON.stringify(adjusted), caseId);
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
    const result = (await context.untilFinished(url, launched.body.run.id)).body.run;
    assert.equal(result.state, 'completed', result.error);
    const finding = result.findings.find((entry) => entry.kind === 'verified');
    assert.ok(finding, JSON.stringify(result.warnings));
    assert.equal(finding.caseId, nodeId);
    assert.equal(finding.evidence[0].path, 'code/assets/Event/NewView.prefab');
    assert.equal(finding.evidence[0].line, 1);
    assert.ok(finding.defectId);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 1);
  } finally { await context.close(); }
});

test('deleting a case set after a completed audit keeps its title, findings and linked defect', async () => {
  const context = setup();
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
    const before = (await context.untilFinished(url, launched.body.run.id)).body.run;
    const defectId = before.findings.find((item) => item.kind === 'verified').defectId;
    assert.equal(before.caseTitle, '活动用例集');
    assert.equal(context.db.prepare('DELETE FROM cases WHERE id=?').run(caseId).changes, 1);
    const after = (await context.request(url, `/api/code-audit/runs/${before.id}?projectId=${projectId}`)).body.run;
    assert.equal(after.caseTitle, '活动用例集');
    assert.equal(after.findings.find((item) => item.kind === 'verified').defectId, defectId);
    assert.deepEqual(context.db.pragma('foreign_key_check'), []);
  } finally { await context.close(); }
});

test('preexisting audit tables with case FKs migrate nonempty rows without losing history', async () => {
  const context = setup({ legacySchema: true });
  try {
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM code_audit_runs').get().n, 1);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM code_audit_defects').get().n, 1);
    assert.equal(context.db.pragma('foreign_key_list(code_audit_runs)').some((key) => key.table === 'cases'), false);
    assert.equal(context.db.pragma('foreign_key_list(code_audit_defects)').some((key) => key.table === 'cases'), false);
    const url = await context.start();
    const before = (await context.request(url, `/api/code-audit/runs/legacy-run?projectId=${projectId}`)).body.run;
    assert.equal(before.caseTitle, '活动用例集');
    assert.equal(before.findings[0].defectId, 'legacy-defect');
    assert.equal(context.db.prepare('DELETE FROM cases WHERE id=?').run(caseId).changes, 1);
    const after = (await context.request(url, `/api/code-audit/runs/legacy-run?projectId=${projectId}`)).body.run;
    assert.equal(after.caseTitle, '活动用例集');
    assert.equal(after.findings[0].defectId, 'legacy-defect');
    assert.deepEqual(context.db.pragma('foreign_key_check'), []);
  } finally { await context.close(); }
});

test('mixed legacy schema also fills the case title while removing the remaining case FK', async () => {
  const context = setup({ legacySchema: 'linkOnly' });
  try {
    assert.equal(context.db.pragma('foreign_key_list(code_audit_runs)').some((key) => key.table === 'cases'), false);
    assert.equal(context.db.pragma('foreign_key_list(code_audit_defects)').some((key) => key.table === 'cases'), false);
    const url = await context.start();
    assert.equal((await context.request(url, `/api/code-audit/runs/legacy-run?projectId=${projectId}`)).body.run.caseTitle, '活动用例集');
    assert.equal(context.db.prepare('DELETE FROM cases WHERE id=?').run(caseId).changes, 1);
    assert.deepEqual(context.db.pragma('foreign_key_check'), []);
  } finally { await context.close(); }
});

test('the owner can cancel an in-flight scan; other users cannot cancel it', async () => {
  let scanning;
  const started = new Promise((resolve) => { scanning = resolve; });
  const context = setup({ inspect: (_source, { signal }) => new Promise((_resolve, reject) => {
    scanning(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId, autoCreateVerified: true } });
    assert.equal(launched.status, 202);
    await started;
    assert.equal((await context.request(url, `/api/code-audit/runs/${launched.body.run.id}`, { method: 'DELETE',
      user: 'admin', body: { projectId } })).status, 403);
    const cancelled = await context.request(url, `/api/code-audit/runs/${launched.body.run.id}`, { method: 'DELETE', body: { projectId } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.run.state, 'interrupted');
    await context.auditService.close();
    assert.equal(context.db.prepare('SELECT state FROM code_audit_runs WHERE id=?').get(launched.body.run.id).state, 'interrupted');
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM defects').get().n, 0);
  } finally { await context.close(); }
});

test('service close aborts background work before SQLite is closed', async () => {
  let scanning;
  const started = new Promise((resolve) => { scanning = resolve; });
  const context = setup({ inspect: (_source, { signal }) => new Promise((_resolve, reject) => {
    scanning(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  try {
    const url = await context.start();
    const source = await addSource(context, url);
    const launched = await context.request(url, '/api/code-audit/runs', { method: 'POST',
      body: { projectId, sourceId: source.id, caseId } });
    await started;
    await context.auditService.close();
    assert.equal(context.db.prepare('SELECT state FROM code_audit_runs WHERE id=?').get(launched.body.run.id).state, 'interrupted');
    assert.equal((await context.request(url, '/api/code-audit/runs', { method: 'POST', body: {
      projectId, sourceId: source.id, caseId } })).status, 503);
  } finally { await context.close(); }
});
