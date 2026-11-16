import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { initializeProjects } from '../projects.js';
import { hashPassword, encryptPassword, decryptPassword, loadPasswordKey } from '../passwords.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('legacy hashes migrate safely and stdin maintenance reset restores a recoverable admin password', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-legacy-test-'));
  let child;
  try {
    const db = new Database(path.join(dataDir, 'platform.db'));
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, created_at TEXT)');
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)')
      .run('legacy-admin', 'admin', hashPassword('legacy-pass'), 'admin', new Date().toISOString());
    db.close();
    let started = await launch(dataDir);
    child = started.child;
    const login = await request(started.url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password: 'legacy-pass' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.passwordAvailable, false);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const projectId = (await request(started.url, '/api/projects', cookie)).body.projects[0].id;
    assert.equal((await request(started.url, `/api/cases?projectId=${projectId}`, cookie)).status, 200);
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    child = null;
    const reset = spawn(process.execPath, [path.join(serverDir, 'reset-admin-password.js')], {
      cwd: os.tmpdir(), env: { ...process.env, QZZ_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    reset.stdout.on('data', (data) => { output += data; });
    reset.stderr.on('data', (data) => { output += data; });
    reset.stdin.end('new-local-password\n');
    assert.equal(await new Promise((resolve) => reset.once('exit', resolve)), 0, output);
    assert.equal(output.includes('new-local-password'), false);
    started = await launch(dataDir);
    child = started.child;
    assert.equal((await request(started.url, '/api/account', cookie)).status, 401);
    assert.equal((await request(started.url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password: 'new-local-password' },
    })).body.user.passwordAvailable, true);
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    child = null;
    await unlink(path.join(dataDir, 'password-key'));
    assert.throws(() => loadPasswordKey(dataDir, true), /missing/);
  } finally {
    if (child) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('registration, own password, admin recovery and module permissions enforce account boundaries', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-accounts-test-'));
  let child;
  try {
    const started = await launch(dataDir);
    child = started.child;
    const { url } = started;
    const login = await request(url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password: 'AdminPassword123456', remember: true },
    });
    const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.match(login.response.headers.get('set-cookie'), /Max-Age=2592000/);
    assert.equal(login.response.headers.get('cache-control'), 'no-store');
    const adminId = login.body.user.id;
    const registered = await request(url, '/api/register', null, {
      method: 'POST', body: { username: 'newtester', password: '1234567', role: 'admin', permissions: {} },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.role, 'member');
    assert.equal(registered.body.user.permissions.cases.write, true);
    assert.doesNotMatch(registered.response.headers.get('set-cookie'), /Max-Age=/);
    let memberCookie = registered.response.headers.get('set-cookie').split(';')[0];
    const memberId = registered.body.user.id;
    assert.equal((await request(url, '/api/register', null, {
      method: 'POST', body: { username: 'newtester', password: '1234567' },
    })).status, 409);
    for (const [route, method, body] of [
      ['/api/users', 'GET'], [`/api/users/${adminId}`, 'PUT', { password: 'invalid-access' }],
      [`/api/users/${adminId}/reveal-password`, 'POST', { currentPassword: '1234567' }],
    ]) assert.equal((await request(url, route, memberCookie, { method, body })).status, 403);
    assert.equal((await request(url, '/api/account/password', memberCookie, {
      method: 'POST', body: { currentPassword: 'wrong-password', newPassword: '7654321' },
    })).status, 403);
    assert.equal((await request(url, '/api/account/password', memberCookie, {
      method: 'POST', body: { currentPassword: '1234567', newPassword: '7654321' },
    })).status, 200);
    assert.equal((await request(url, '/api/account', memberCookie)).status, 200);
    assert.equal((await request(url, `/api/users/${memberId}/reveal-password`, adminCookie, {
      method: 'POST', body: { currentPassword: 'wrong-password' },
    })).status, 403);
    const reveal = await request(url, `/api/users/${memberId}/reveal-password`, adminCookie, {
      method: 'POST', body: { currentPassword: 'AdminPassword123456' },
    });
    assert.deepEqual(reveal.body, { available: true, password: '7654321' });
    assert.equal((await request(url, `/api/users/${adminId}`, adminCookie, {
      method: 'PUT', body: { role: 'member' },
    })).status, 400);
    assert.equal((await request(url, `/api/users/${memberId}`, adminCookie, {
      method: 'PUT', body: { password: 'reset123', permissions: { cases: { view: false, write: false }, files: { view: true, write: false } } },
    })).status, 200);
    assert.equal((await request(url, '/api/account', memberCookie)).status, 401);
    const memberLogin = await request(url, '/api/session', null, {
      method: 'POST', body: { username: 'newtester', password: 'reset123' },
    });
    memberCookie = memberLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(url, '/api/cases', memberCookie)).status, 403);
    assert.equal((await request(url, '/api/files', memberCookie)).status, 200);
    assert.equal((await request(url, '/api/files', memberCookie, { method: 'POST', body: {} })).status, 403);
    const users = await request(url, '/api/users', adminCookie);
    assert.equal(JSON.stringify(users.body).includes('reset123'), false);
    assert.equal(JSON.stringify(users.body).includes('password_encrypted'), false);
    const db = new Database(path.join(dataDir, 'platform.db'));
    const stored = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
    assert.notEqual(stored.password_encrypted, 'reset123');
    assert.equal(decryptPassword(stored.password_encrypted, loadPasswordKey(dataDir, true)), 'reset123');
    assert.equal(db.prepare('SELECT count(*) AS count FROM account_audit').get().count >= 4, true);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM account_audit').all()).includes('reset123'), false);
    db.prepare('UPDATE users SET password_encrypted = NULL WHERE id = ?').run(memberId);
    db.close();
    assert.deepEqual((await request(url, `/api/users/${memberId}/reveal-password`, adminCookie, {
      method: 'POST', body: { currentPassword: 'AdminPassword123456' },
    })).body, { available: false, password: null });
    for (let i = 0; i < 10; i++) {
      const result = await request(url, `/api/users/${memberId}/reveal-password`, adminCookie, {
        method: 'POST', body: { currentPassword: 'wrong-password' },
      });
      if (i === 9) assert.equal(result.status, 429);
    }
    const key = loadPasswordKey(dataDir, true);
    const encrypted = encryptPassword('roundtrip', key);
    assert.equal(decryptPassword(encrypted, key), 'roundtrip');
  } finally {
    if (child) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function launch(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
    cwd: os.tmpdir(),
    env: { ...process.env, PORT: '0', QZZ_DATA_DIR: dataDir, ADMIN_PASSWORD: 'AdminPassword123456', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
  return { child, url };
}

async function request(url, route, cookie, options = {}) {
  const headers = { ...options.headers };
  if (cookie) headers.cookie = cookie;
  if (options.body && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(`${url}${route}`, {
    ...options, headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, body: contentType.includes('json') ? await response.json() : await response.text(), response };
}

test('authenticated LAN APIs persist records and reject stale revisions', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-server-test-'));
  let child;
  try {
    const started = await launch(dataDir);
    child = started.child;
    const { url } = started;
    assert.equal((await request(url, '/api/health')).body.ok, true);
    assert.equal((await request(url, '/api/cases')).status, 401);
    assert.equal((await request(url, '/api/session')).body.user, null);

    const login = await request(url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password: 'AdminPassword123456' },
    });
    assert.equal(login.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.equal(login.body.user.role, 'admin');
    assert.equal((await request(url, '/api/session', cookie)).body.user.username, 'admin');
    const projectId = (await request(url, '/api/projects', cookie)).body.projects[0].id;
    assert.equal((await request(url, '/api/cases', cookie, {
      method: 'POST', headers: { origin: 'http://not-the-platform.invalid' }, body: { title: 'blocked' },
    })).status, 403);

    const createdUser = await request(url, '/api/users', cookie, {
      method: 'POST', body: { username: 'tester', password: 'MemberPassword123' },
    });
    assert.equal(createdUser.status, 201);

    const createdCase = await request(url, '/api/cases', cookie, {
      method: 'POST', body: { projectId, title: 'Login with invalid password', tags: ['auth'] },
    });
    assert.equal(createdCase.status, 201);
    assert.equal(createdCase.body.case.createdBy, 'admin');
    assert.deepEqual(createdCase.body.case.tags, ['auth']);
    const caseId = createdCase.body.case.id;

    const updatedCase = await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'PUT', body: { projectId, revision: 1, status: 'ready' },
    });
    assert.equal(updatedCase.status, 200);
    assert.equal(updatedCase.body.case.revision, 2);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'PUT', body: { projectId, revision: 1, title: 'stale' },
    })).status, 409);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, { method: 'DELETE' })).status, 400);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'DELETE', body: { projectId, revision: 1 },
    })).status, 409);
    assert.equal((await request(url, `/api/cases?projectId=${projectId}`, cookie)).body.cases[0].title, 'Login with invalid password');

    const createdDefect = await request(url, '/api/defects', cookie, {
      method: 'POST', body: { projectId, title: 'Crash on login', version: '1.0.0' },
    });
    assert.equal(createdDefect.status, 201);
    const defectId = createdDefect.body.defect.id;
    assert.equal(createdDefect.body.defect.version, '1.0.0');
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'PUT', body: { projectId, revision: 1, status: 'fixed' },
    })).body.defect.revision, 2);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'PUT', body: { projectId, revision: 1, status: 'closed' },
    })).status, 409);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, { method: 'DELETE' })).status, 400);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'DELETE', body: { projectId, revision: 1 },
    })).status, 409);
    assert.equal((await request(url, `/api/defects?projectId=${projectId}`, cookie)).body.defects[0].status, 'fixed');

    const form = new FormData();
    form.append('file', new Blob(['test artifact'], { type: 'text/plain' }), 'artifact.txt');
    const upload = await request(url, '/api/files', cookie, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.file.name, 'artifact.txt');
    assert.equal(upload.body.file.uploadedBy, 'admin');
    assert.equal((await request(url, '/api/files', cookie)).body.files.length, 1);
    const download = await fetch(`${url}${upload.body.file.downloadUrl}`, { headers: { cookie } });
    assert.equal(await download.text(), 'test artifact');
    assert.equal((await request(url, `/api/files/${upload.body.file.id}`, cookie, { method: 'DELETE' })).status, 200);

    assert.equal((await request(url, '/api/config', cookie)).body.aiConfigured, false);
    assert.equal((await request(url, '/api/ai/generate', cookie, {
      method: 'POST', body: { requirements: 'login' },
    })).status, 503);

    const memberLogin = await request(url, '/api/session', null, {
      method: 'POST', body: { username: 'tester', password: 'MemberPassword123' },
    });
    const memberCookie = memberLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(url, '/api/users', memberCookie)).status, 403);
    assert.equal((await request(url, `/api/defects?projectId=${projectId}`, memberCookie)).body.defects.length, 1);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'DELETE', body: { projectId, revision: 2 },
    })).status, 200);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'DELETE', body: { projectId, revision: 2 },
    })).status, 200);
    assert.equal((await request(url, '/api/session', cookie, { method: 'DELETE' })).status, 200);
    assert.equal((await request(url, '/api/cases', cookie)).status, 401);
  } finally {
    if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('first-run generated password survives a restart until login and WebSocket broadcasts changes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-server-bootstrap-'));
  let child;
  try {
    let started = await launch(dataDir, { ADMIN_PASSWORD: '' });
    child = started.child;
    const credentials = await readFile(path.join(dataDir, 'initial-admin.txt'), 'utf8');
    const password = credentials.match(/^password=(.+)$/m)[1];
    assert.ok(password.length >= 12);
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    started = await launch(dataDir, { ADMIN_PASSWORD: '' });
    child = started.child;
    assert.equal(await readFile(path.join(dataDir, 'initial-admin.txt'), 'utf8'), credentials);
    const login = await request(started.url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password },
    });
    assert.equal(login.status, 200);
    await assert.rejects(access(path.join(dataDir, 'initial-admin.txt')));
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const projectId = (await request(started.url, '/api/projects', cookie)).body.projects[0].id;
    const ws = new WebSocket(`${started.url.replace('http:', 'ws:')}/api/events`, {
      headers: { cookie, origin: started.url },
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const event = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    await request(started.url, '/api/defects', cookie, { method: 'POST', body: { projectId, title: 'sync' } });
    const received = await event;
    assert.equal(received.type, 'defect.created');
    assert.equal(received.projectId, projectId);
    const disconnected = new Promise((resolve) => ws.once('close', resolve));
    await request(started.url, '/api/session', cookie, { method: 'DELETE' });
    await disconnected;
  } finally {
    if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('project migration preserves legacy records and stable renamed project identity on restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-project-migration-'));
  const db = new Database(path.join(dataDir, 'platform.db'));
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT, revision INTEGER, updated_at TEXT);
      CREATE TABLE defects (id TEXT PRIMARY KEY, title TEXT, revision INTEGER, updated_at TEXT);
      INSERT INTO cases VALUES ('legacy-case', 'Original case', 7, '2026-01-01');
      INSERT INTO defects VALUES ('legacy-defect', 'Original defect', 4, '2026-01-02');`);
    initializeProjects(db, dataDir);
    const original = db.prepare('SELECT * FROM projects').get();
    assert.equal(original.name, '默认项目组');
    assert.deepEqual(db.prepare('SELECT * FROM cases').get(), {
      id: 'legacy-case', title: 'Original case', revision: 7, updated_at: '2026-01-01', project_id: original.id,
    });
    assert.deepEqual(db.prepare('SELECT * FROM defects').get(), {
      id: 'legacy-defect', title: 'Original defect', revision: 4, updated_at: '2026-01-02', project_id: original.id,
    });
    db.prepare('UPDATE projects SET name = ?, name_key = ?, revision = 2 WHERE id = ?').run('正式项目', '正式项目', original.id);
    initializeProjects(db, dataDir);
    assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get().count, 1);
    assert.equal(db.prepare('SELECT name FROM projects WHERE id = ?').get(original.id).name, '正式项目');
    assert.equal(db.prepare('SELECT revision FROM cases').get().revision, 7);
    assert.equal(db.prepare('SELECT revision FROM defects').get().revision, 4);
    assert.throws(() => db.prepare('INSERT INTO cases VALUES (?, ?, ?, ?, ?)').run('invalid', 'Bad', 1, '', 'unknown'), /FOREIGN KEY/);
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('projects isolate both modules, validate icons and enforce shared-group permissions', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-projects-test-'));
  let child;
  let ws;
  try {
    const started = await launch(dataDir);
    child = started.child;
    const { url } = started;
    const login = await request(url, '/api/session', null, {
      method: 'POST', body: { username: 'admin', password: 'AdminPassword123456' },
    });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const defaultProject = (await request(url, '/api/projects', cookie)).body.projects[0];
    assert.equal(defaultProject.caseCount, 0);
    assert.equal(defaultProject.defectCount, 0);
    assert.equal((await request(url, '/api/projects')).status, 401);
    for (const name of ['', '   ', 'x'.repeat(61), 'bad\nname']) {
      assert.equal((await request(url, '/api/projects', cookie, { method: 'POST', body: { name } })).status, 400);
    }
    const created = await request(url, '/api/projects', cookie, { method: 'POST', body: { name: '  Game A  ' } });
    assert.equal(created.status, 201);
    let project = created.body.project;
    assert.equal(project.name, 'Game A');
    assert.equal((await request(url, '/api/projects', cookie, { method: 'POST', body: { name: 'game a' } })).status, 409);
    const renamed = await request(url, `/api/projects/${project.id}`, cookie, { method: 'PUT', body: { name: 'Game B', revision: 1 } });
    assert.equal(renamed.status, 200);
    project = renamed.body.project;
    assert.equal(project.revision, 2);
    assert.equal(project.name, 'Game B');
    assert.equal((await request(url, `/api/projects/${project.id}`, cookie, { method: 'PUT', body: { name: 'Lost update', revision: 1 } })).status, 409);
    assert.equal((await request(url, `/api/projects/${project.id}`, cookie, { method: 'PUT', body: { name: defaultProject.name, revision: 2 } })).status, 409);

    for (const module of ['cases', 'defects']) {
      assert.equal((await request(url, `/api/${module}`, cookie)).status, 400);
      assert.equal((await request(url, `/api/${module}?projectId=missing`, cookie)).status, 400);
      assert.equal((await request(url, `/api/${module}`, cookie, { method: 'POST', body: { title: 'Missing group' } })).status, 400);
      const createdRecord = await request(url, `/api/${module}`, cookie, { method: 'POST', body: { projectId: project.id, title: `Isolated ${module}` } });
      assert.equal(createdRecord.status, 201);
      const record = createdRecord.body[module === 'cases' ? 'case' : 'defect'];
      assert.equal(record.projectId, project.id);
      assert.equal((await request(url, `/api/${module}?projectId=${defaultProject.id}`, cookie)).body[module].length, 0);
      assert.equal((await request(url, `/api/${module}?projectId=${project.id}`, cookie)).body[module].length, 1);
      for (const method of ['PUT', 'DELETE']) {
        assert.equal((await request(url, `/api/${module}/${record.id}`, cookie, { method, body: { revision: 1 } })).status, 400);
        const denied = await request(url, `/api/${module}/${record.id}`, cookie, { method, body: { projectId: defaultProject.id, revision: 1, title: 'Moved' } });
        assert.equal(denied.status, 404);
        assert.equal(JSON.stringify(denied.body).includes('Isolated'), false);
      }
      assert.equal((await request(url, `/api/${module}?projectId=${project.id}`, cookie)).body[module][0].revision, 1);
    }
    const counts = (await request(url, '/api/projects', cookie)).body.projects.find((item) => item.id === project.id);
    assert.equal(counts.caseCount, 1);
    assert.equal(counts.defectCount, 1);

    const uploadIcon = (buffer, revision, name = 'icon.png', type = 'image/png', auth = cookie) => {
      const form = new FormData();
      form.append('revision', String(revision));
      form.append('file', new Blob([buffer], { type }), name);
      return request(url, `/api/projects/${project.id}/icon`, auth, { method: 'POST', body: form });
    };
    const png = await sharp({ create: { width: 400, height: 300, channels: 4, background: '#39a974' } }).png().toBuffer();
    assert.equal((await uploadIcon(Buffer.from('not an image'), project.revision)).status, 400);
    assert.equal((await uploadIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'), project.revision, 'unsafe.svg', 'image/svg+xml')).status, 400);
    assert.equal((await uploadIcon(Buffer.alloc(2 * 1024 * 1024 + 1), project.revision)).status, 413);
    const valid = await uploadIcon(png, project.revision);
    assert.equal(valid.status, 200);
    project = valid.body.project;
    assert.equal(project.revision, 3);
    assert.ok(project.iconUrl);
    const iconResponse = await fetch(`${url}${project.iconUrl}`, { headers: { cookie } });
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get('content-type'), 'image/webp');
    assert.equal(iconResponse.headers.get('x-content-type-options'), 'nosniff');
    const metadata = await sharp(Buffer.from(await iconResponse.arrayBuffer())).metadata();
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 256);
    assert.equal((await fetch(`${url}${project.iconUrl}`)).status, 401);
    assert.equal((await uploadIcon(png, 2)).status, 409);
    assert.equal((await uploadIcon(png, project.revision)).status, 200);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(path.join(dataDir, 'project-icons'))).length, 1);

    const registered = await request(url, '/api/register', null, { method: 'POST', body: { username: 'viewer', password: 'viewer123' } });
    const viewerId = registered.body.user.id;
    await request(url, `/api/users/${viewerId}`, cookie, {
      method: 'PUT', body: { permissions: { cases: { view: true, write: false }, defects: { view: false, write: false } } },
    });
    const viewerLogin = await request(url, '/api/session', null, { method: 'POST', body: { username: 'viewer', password: 'viewer123' } });
    const viewerCookie = viewerLogin.response.headers.get('set-cookie').split(';')[0];
    const viewerProjects = await request(url, '/api/projects', viewerCookie);
    assert.equal(viewerProjects.status, 200);
    const viewerProject = viewerProjects.body.projects.find((item) => item.id === project.id);
    assert.equal(viewerProject.caseCount, 1);
    assert.equal(viewerProject.defectCount, null);
    assert.equal((await request(url, `/api/cases?projectId=${project.id}`, viewerCookie)).status, 200);
    assert.equal((await request(url, `/api/defects?projectId=${project.id}`, viewerCookie)).status, 403);
    assert.equal((await request(url, '/api/cases', viewerCookie, { method: 'POST', body: { projectId: project.id, title: 'No write' } })).status, 403);
    assert.equal((await request(url, '/api/projects', viewerCookie, { method: 'POST', body: { name: 'No group write' } })).status, 403);
    assert.equal((await request(url, `/api/projects/${project.id}`, viewerCookie, { method: 'PUT', body: { revision: 4, name: 'No rename' } })).status, 403);
    assert.equal((await uploadIcon(png, 4, 'icon.png', 'image/png', viewerCookie)).status, 403);
    assert.equal((await fetch(`${url}${viewerProject.iconUrl}`, { headers: { cookie: viewerCookie } })).status, 200);

    ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { cookie: viewerCookie, origin: url } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const event = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    await request(url, '/api/projects', cookie, { method: 'POST', body: { name: 'Shared notification' } });
    const received = await event;
    assert.equal(received.type, 'project.created');
    assert.equal(received.project.caseCount, 0);
    assert.equal(received.project.defectCount, null);
    ws.close();
    await new Promise((resolve) => ws.once('close', resolve));
    ws = null;

    await request(url, `/api/users/${viewerId}`, cookie, { method: 'PUT', body: { permissions: { cases: { view: false }, defects: { view: false } } } });
    const deniedLogin = await request(url, '/api/session', null, { method: 'POST', body: { username: 'viewer', password: 'viewer123' } });
    const deniedCookie = deniedLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(url, '/api/projects', deniedCookie)).status, 403);
    assert.equal((await fetch(`${url}${viewerProject.iconUrl}`, { headers: { cookie: deniedCookie } })).status, 403);
  } finally {
    if (ws) ws.terminate();
    if (child) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
