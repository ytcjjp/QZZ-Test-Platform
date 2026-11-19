import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { createDefectImageStore } from '../defect-images.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function launch(dataDir) {
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
    cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', QZZ_DATA_DIR: dataDir, ADMIN_PASSWORD: 'AdminPassword123456', FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' },
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

async function request(url, route, cookie, method = 'GET', body) {
  const headers = cookie ? { cookie } : {};
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(`${url}${route}`, {
    method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  return { response, status: response.status, body: type.includes('json') ? await response.json() : await response.arrayBuffer() };
}

function multipart(payload, images) {
  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  for (const [name, buffer] of images) form.append('image', new Blob([buffer], { type: 'image/png' }), name);
  return form;
}

test('startup removes only expired defect upload temp files', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-defect-image-temp-'));
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE defects (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY);');
    const temporary = path.join(dataDir, 'defect-images', 'tmp');
    await mkdir(temporary, { recursive: true });
    const staleUpload = path.join(temporary, '11111111-1111-4111-8111-111111111111.tmp');
    const recentUpload = path.join(temporary, '22222222-2222-4222-8222-222222222222.tmp');
    const unrelated = path.join(temporary, 'unrelated.tmp');
    const namedDirectory = path.join(temporary, '33333333-3333-4333-8333-333333333333.tmp');
    await Promise.all([writeFile(staleUpload, 'old'), writeFile(recentUpload, 'new'), writeFile(unrelated, 'keep'), mkdir(namedDirectory)]);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await Promise.all([utimes(staleUpload, old, old), utimes(unrelated, old, old), utimes(namedDirectory, old, old)]);
    createDefectImageStore({ db, dataDir });
    assert.deepEqual((await readdir(temporary)).sort(), [path.basename(namedDirectory), path.basename(recentUpload), path.basename(unrelated)].sort());
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('defect images persist, stay project-private, and support thumbnail, edits, delete, and member names', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qzz-defect-image-api-'));
  let child;
  try {
    let started = await launch(dataDir); child = started.child;
    let { url } = started;
    const login = await request(url, '/api/session', null, 'POST', { username: 'admin', password: 'AdminPassword123456' });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const projectId = (await request(url, '/api/projects', cookie)).body.projects[0].id;
    const other = await request(url, '/api/projects', cookie, 'POST', { name: '其他项目' });
    const otherId = other.body.project.id;
    assert.equal((await request(url, '/api/members', null)).status, 401);
    const member = await request(url, '/api/register', null, 'POST', { username: 'imageqa', password: 'password123' });
    const memberCookie = member.response.headers.get('set-cookie').split(';')[0];
    const members = await request(url, '/api/members', memberCookie);
    assert.equal(members.status, 200);
    assert.deepEqual(members.body.members.map(({ username }) => username).sort(), ['admin', 'imageqa']);
    assert.equal(Object.keys(members.body.members[0]).sort().join(','), 'id,username');

    const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#55aaee' } }).png().toBuffer();
    let result = await request(url, '/api/defects', memberCookie, 'POST', multipart({ projectId, title: '支持图片的缺陷', assignee: 'imageqa' }, [
      ['截图一.png', png], ['截图二.png', png],
    ]));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    let defect = result.body.defect;
    assert.equal(defect.images.length, 2);
    assert.equal(defect.assignee, 'imageqa');
    assert.ok(defect.images.every(({ name, mimeType, url: original, thumbnailUrl }) =>
      name.startsWith('截图') && mimeType === 'image/png' && original.includes(`projectId=${projectId}`) && thumbnailUrl.includes('thumbnail')));
    const first = defect.images[0];
    assert.equal((await request(url, first.url, null)).status, 401);
    assert.equal((await request(url, first.url.replace(projectId, otherId), cookie)).status, 404);
    const full = await request(url, first.url, memberCookie);
    assert.equal(full.status, 200);
    assert.match(full.response.headers.get('content-type'), /^image\/png/);
    assert.equal((await sharp(Buffer.from(full.body)).metadata()).width, 24);
    const thumbnail = await request(url, first.thumbnailUrl, memberCookie);
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.response.headers.get('content-type'), /^image\/webp/);
    assert.equal(thumbnail.response.headers.get('x-content-type-options'), 'nosniff');

    const imageDir = path.join(dataDir, 'defect-images');
    const filesBeforeBadUpload = (await readdir(imageDir)).sort();
    let failed = await request(url, '/api/defects', memberCookie, 'POST', multipart({ projectId, title: '部分失败' }, [
      ['有效.png', png], ['坏图.png', Buffer.from('not a png')],
    ]));
    assert.equal(failed.status, 400);
    assert.deepEqual((await readdir(imageDir)).sort(), filesBeforeBadUpload);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);
    const malformed = new FormData();
    malformed.set('payload', '{invalid');
    malformed.append('image', new Blob([png], { type: 'image/png' }), '截图.png');
    failed = await request(url, '/api/defects', memberCookie, 'POST', malformed);
    assert.equal(failed.status, 400);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);
    failed = await request(url, '/api/defects', memberCookie, 'POST', multipart({ projectId },
      Array.from({ length: 13 }, (_, i) => [`${i}.png`, png])));
    assert.equal(failed.status, 400);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);
    failed = await request(url, '/api/defects', memberCookie, 'POST', multipart({ projectId },
      [['过大.png', Buffer.alloc(20 * 1024 * 1024 + 1)]]));
    assert.equal(failed.status, 413);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);

    result = await request(url, `/api/defects/${defect.id}`, memberCookie, 'PUT', multipart({ projectId, revision: defect.revision, status: '已解决' }, [['追加.png', png]]));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    defect = result.body.defect;
    assert.equal(defect.images.length, 3);
    const filesBeforeConflict = (await readdir(imageDir)).sort();
    const stale = await request(url, `/api/defects/${defect.id}`, memberCookie, 'PUT', multipart({ projectId, revision: 1 }, [['冲突.png', png]]));
    assert.equal(stale.status, 409);
    assert.deepEqual((await readdir(imageDir)).sort(), filesBeforeConflict);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);
    assert.equal((await request(url, `/api/defects/${defect.id}/images/${first.id}`, memberCookie, 'DELETE', { projectId, revision: 1 })).status, 409);
    result = await request(url, `/api/defects/${defect.id}/images/${first.id}`, memberCookie, 'DELETE', { projectId, revision: defect.revision });
    assert.equal(result.status, 200);
    defect = result.body.defect;
    assert.equal(defect.images.length, 2);
    assert.equal((await request(url, first.url, memberCookie)).status, 404);

    const bad = await request(url, '/api/defects', memberCookie, 'POST', multipart({ projectId, title: '损坏图片' }, [['bad.png', Buffer.from('not a png')]]));
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.deepEqual(await readdir(path.join(dataDir, 'defect-images', 'tmp')), []);
    assert.equal((await request(url, `/api/defects?projectId=${projectId}`, memberCookie)).body.defects.length, 1);

    assert.equal((await request(url, `/api/users/${member.body.user.id}`, cookie, 'PUT', {
      permissions: { defects: { view: true, write: false } },
    })).status, 200);
    let relogin = await request(url, '/api/session', null, 'POST', { username: 'imageqa', password: 'password123' });
    let viewerCookie = relogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(url, defect.images[0].thumbnailUrl, viewerCookie)).status, 200);
    assert.equal((await request(url, '/api/members', viewerCookie)).status, 200);
    assert.equal((await request(url, '/api/defects', viewerCookie, 'POST', multipart({ projectId }, [['无权.png', png]]))).status, 403);
    assert.deepEqual(await readdir(path.join(imageDir, 'tmp')), []);
    assert.equal((await request(url, `/api/users/${member.body.user.id}`, cookie, 'PUT', {
      permissions: { defects: { view: false, write: false } },
    })).status, 200);
    relogin = await request(url, '/api/session', null, 'POST', { username: 'imageqa', password: 'password123' });
    viewerCookie = relogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(url, defect.images[0].thumbnailUrl, viewerCookie)).status, 403);
    assert.equal((await request(url, '/api/members', viewerCookie)).status, 403);
    assert.equal((await request(url, `/api/users/${member.body.user.id}`, cookie, 'PUT', { disabled: true })).status, 200);
    assert.equal((await request(url, '/api/members', cookie)).body.members.some(({ username }) => username === 'imageqa'), false);

    child.kill(); await new Promise((resolve) => child.once('exit', resolve)); child = null;
    started = await launch(dataDir); child = started.child; url = started.url;
    const loginAgain = await request(url, '/api/session', null, 'POST', { username: 'admin', password: 'AdminPassword123456' });
    const adminCookie = loginAgain.response.headers.get('set-cookie').split(';')[0];
    const persisted = (await request(url, `/api/defects?projectId=${projectId}`, adminCookie)).body.defects[0];
    assert.equal(persisted.images.length, 2);
    assert.equal((await request(url, persisted.images[0].thumbnailUrl, adminCookie)).status, 200);
    assert.ok((await stat(path.join(dataDir, 'defect-images', `${persisted.images[0].id}.png`))).size > 0);
    const deleted = await request(url, `/api/defects/${persisted.id}`, adminCookie, 'DELETE', { projectId, revision: persisted.revision });
    assert.equal(deleted.status, 200);
    assert.equal((await request(url, persisted.images[0].url, adminCookie)).status, 404);
    for (const image of persisted.images) {
      await assert.rejects(stat(path.join(imageDir, `${image.id}.png`)), { code: 'ENOENT' });
      await assert.rejects(stat(path.join(imageDir, `${image.id}.webp`)), { code: 'ENOENT' });
    }
    assert.deepEqual((await request(url, `/api/defects?projectId=${projectId}`, adminCookie)).body.defects, []);
  } finally {
    if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
