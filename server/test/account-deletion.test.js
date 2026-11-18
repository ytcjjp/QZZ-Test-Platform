import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function launch(directory) {
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
    cwd: os.tmpdir(),
    env: { ...process.env, PORT: '0', QZZ_DATA_DIR: directory, ADMIN_PASSWORD: 'AccountAdminPassword123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
  return { child, url };
}

async function request(url, route, cookie, method = 'GET', body) {
  const response = await fetch(url + route, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('admin removes a member without orphaning records and revokes live access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qzz-account-deletion-'));
  let child;
  try {
    const started = await launch(directory);
    child = started.child;
    const { url } = started;
    const admin = await request(url, '/api/session', null, 'POST', { username: 'admin', password: 'AccountAdminPassword123' });
    const adminCookie = admin.cookie;
    assert.equal(admin.status, 200);
    const adminId = admin.body.user.id;
    assert.equal((await request(url, `/api/users/${adminId}`, adminCookie, 'DELETE')).status, 400);
    const otherAdmin = await request(url, '/api/users', adminCookie, 'POST', { username: 'other-admin', password: 'OtherAdminPassword123' });
    assert.equal((await request(url, `/api/users/${otherAdmin.body.user.id}`, adminCookie, 'PUT', { role: 'admin' })).status, 200);
    assert.equal((await request(url, `/api/users/${otherAdmin.body.user.id}`, adminCookie, 'DELETE')).status, 400);

    const created = await request(url, '/api/users', adminCookie, 'POST', { username: 'qa-member', password: 'MemberPassword123' });
    assert.equal(created.status, 201);
    const memberId = created.body.user.id;
    const member = await request(url, '/api/session', null, 'POST', { username: 'qa-member', password: 'MemberPassword123' });
    const memberCookie = member.cookie;
    const projectId = (await request(url, '/api/projects', adminCookie)).body.projects[0].id;
    const existingCase = await request(url, '/api/cases', memberCookie, 'POST', { projectId, title: '保留的用例' });
    const existingDefect = await request(url, '/api/defects', memberCookie, 'POST', { projectId, title: '保留的缺陷' });
    assert.equal(existingCase.status, 201);
    assert.equal(existingDefect.status, 201);
    assert.equal((await request(url, `/api/users/${adminId}`, memberCookie, 'DELETE')).status, 403);
    assert.equal((await request(url, `/api/users/${memberId}`, memberCookie, 'DELETE')).status, 403);

    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/events`, { headers: { cookie: memberCookie, origin: url } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    assert.equal((await request(url, `/api/users/${memberId}`, adminCookie, 'DELETE')).status, 200);
    await closed;
    assert.equal((await request(url, '/api/account', memberCookie)).status, 401);
    assert.equal((await request(url, '/api/session', null, 'POST', { username: 'qa-member', password: 'MemberPassword123' })).status, 401);
    assert.equal((await request(url, `/api/users/${memberId}`, adminCookie, 'DELETE')).status, 404);
    assert.equal((await request(url, `/api/users/${memberId}`, adminCookie, 'PUT', { disabled: false })).status, 404);
    assert.equal((await request(url, `/api/users/${memberId}/reveal-password`, adminCookie, 'POST', { currentPassword: 'AccountAdminPassword123' })).status, 404);
    assert.equal((await request(url, '/api/users', adminCookie)).body.users.some((user) => user.id === memberId), false);

    const cases = (await request(url, `/api/cases?projectId=${projectId}`, adminCookie)).body.cases;
    const defects = (await request(url, `/api/defects?projectId=${projectId}`, adminCookie)).body.defects;
    assert.equal(cases.some((item) => item.id === existingCase.body.case.id), true);
    assert.equal(defects.some((item) => item.id === existingDefect.body.defect.id), true);
    const recreated = await request(url, '/api/users', adminCookie, 'POST', { username: 'qa-member', password: 'AnotherPassword123' });
    assert.equal(recreated.status, 201);
    assert.notEqual(recreated.body.user.id, memberId);

    const db = new Database(path.join(directory, 'platform.db'));
    try {
      const tombstone = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
      assert.equal(tombstone.disabled, 1);
      assert.ok(tombstone.deleted_at);
      assert.equal(tombstone.username, `已删除成员-${memberId}`);
      assert.equal(tombstone.password_encrypted, null);
      assert.equal(db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?').get(memberId).count, 0);
      assert.equal(db.prepare('SELECT count(*) AS count FROM account_audit WHERE target_id = ? AND action = ?').get(memberId, 'user.deleted').count, 1);
      assert.equal(db.pragma('foreign_key_check').length, 0);
    } finally { db.close(); }
  } finally {
    if (child?.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
