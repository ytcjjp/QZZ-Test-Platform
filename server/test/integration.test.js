import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
