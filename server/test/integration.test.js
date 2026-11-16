import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
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
    assert.equal((await request(started.url, '/api/cases', cookie)).status, 200);
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
    assert.equal((await request(url, '/api/cases', cookie, {
      method: 'POST', headers: { origin: 'http://not-the-platform.invalid' }, body: { title: 'blocked' },
    })).status, 403);

    const createdUser = await request(url, '/api/users', cookie, {
      method: 'POST', body: { username: 'tester', password: 'MemberPassword123' },
    });
    assert.equal(createdUser.status, 201);

    const createdCase = await request(url, '/api/cases', cookie, {
      method: 'POST', body: { title: 'Login with invalid password', tags: ['auth'] },
    });
    assert.equal(createdCase.status, 201);
    assert.equal(createdCase.body.case.createdBy, 'admin');
    assert.deepEqual(createdCase.body.case.tags, ['auth']);
    const caseId = createdCase.body.case.id;

    const updatedCase = await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'PUT', body: { revision: 1, status: 'ready' },
    });
    assert.equal(updatedCase.status, 200);
    assert.equal(updatedCase.body.case.revision, 2);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'PUT', body: { revision: 1, title: 'stale' },
    })).status, 409);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, { method: 'DELETE' })).status, 400);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'DELETE', body: { revision: 1 },
    })).status, 409);
    assert.equal((await request(url, '/api/cases', cookie)).body.cases[0].title, 'Login with invalid password');

    const createdDefect = await request(url, '/api/defects', cookie, {
      method: 'POST', body: { title: 'Crash on login', version: '1.0.0' },
    });
    assert.equal(createdDefect.status, 201);
    const defectId = createdDefect.body.defect.id;
    assert.equal(createdDefect.body.defect.version, '1.0.0');
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'PUT', body: { revision: 1, status: 'fixed' },
    })).body.defect.revision, 2);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'PUT', body: { revision: 1, status: 'closed' },
    })).status, 409);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, { method: 'DELETE' })).status, 400);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'DELETE', body: { revision: 1 },
    })).status, 409);
    assert.equal((await request(url, '/api/defects', cookie)).body.defects[0].status, 'fixed');

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
    assert.equal((await request(url, '/api/defects', memberCookie)).body.defects.length, 1);
    assert.equal((await request(url, `/api/cases/${caseId}`, cookie, {
      method: 'DELETE', body: { revision: 2 },
    })).status, 200);
    assert.equal((await request(url, `/api/defects/${defectId}`, cookie, {
      method: 'DELETE', body: { revision: 2 },
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
    const ws = new WebSocket(`${started.url.replace('http:', 'ws:')}/api/events`, {
      headers: { cookie, origin: started.url },
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const event = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    await request(started.url, '/api/defects', cookie, { method: 'POST', body: { title: 'sync' } });
    assert.equal((await event).type, 'defect.created');
    const disconnected = new Promise((resolve) => ws.once('close', resolve));
    await request(started.url, '/api/session', cookie, { method: 'DELETE' });
    await disconnected;
  } finally {
    if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
