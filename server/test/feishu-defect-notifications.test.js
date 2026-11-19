import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { createFeishuDefectNotifier, createFeishuDefectSender,
  formatFeishuDefectNotice, loadFeishuDefectTarget } from '../feishu-defect-notifications.js';

const projectId = '11111111-2222-4333-8444-555555555555';
const chatId = 'oc_0123456789abcdef0123456789abcdef';
const target = { projectId, chatId };
const defect = { id: '281e78cd-39ac-4662-ae70-a41bd71612b5', projectId, title: '活动规则显示异常',
  issueType: '版本问题', version: '1.2.3', module: '活动', status: '待处理', assignee: '测试负责人',
  reproSteps: '不应出现在群里的详细重现步骤', actual: '不应出现在群里的实际结果', notes: '不应出现在群里的备注' };

function createTables(db) {
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE defect_images (id TEXT PRIMARY KEY, defect_id TEXT NOT NULL, project_id TEXT NOT NULL,
      stored_name TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.prepare('INSERT INTO projects VALUES (?, ?, NULL)').run(projectId, '甜点项目组');
}

test('group target is explicit, validated, and no sensitive defect body is sent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-target-'));
  try {
    assert.equal(loadFeishuDefectTarget(directory), null);
    fs.writeFileSync(path.join(directory, 'feishu-defect-notifications.json'), JSON.stringify(target));
    assert.deepEqual(loadFeishuDefectTarget(directory), target);
    const text = formatFeishuDefectNotice('created', defect);
    assert.equal(text, [
      '问题类型：版本问题', '标题：活动规则显示异常', '发现版本：1.2.3',
      '模块：活动', '状态：待处理', '负责人：测试负责人', '缺陷编号：281e78cd',
    ].join('\n'));
    assert.doesNotMatch(text, /QZZ|甜点项目组|新建缺陷|重现步骤|实际结果|备注|39ac-4662/);
    assert.equal(formatFeishuDefectNotice('closed', { ...defect, title: '', assignee: '' }), [
      '问题类型：版本问题', '标题：未填写', '发现版本：1.2.3',
      '模块：活动', '状态：待处理', '负责人：', '缺陷编号：281e78cd',
    ].join('\n'));
    assert.equal(formatFeishuDefectNotice('created', {
      ...defect, id: 'fbe1a572-0000-4000-8000-000000000000', title: 'test',
      version: '166.0', module: '绚烂挑战', assignee: '',
    }), [
      '问题类型：版本问题', '标题：test', '发现版本：166.0',
      '模块：绚烂挑战', '状态：待处理', '负责人：', '缺陷编号：fbe1a572',
    ].join('\n'));
    fs.writeFileSync(path.join(directory, 'feishu-defect-notifications.json'), JSON.stringify({ ...target, chatId: 'not-a-chat' }));
    assert.throws(() => loadFeishuDefectTarget(directory), /配置无效/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('queued notices survive restart, retry with stable idempotency key, and only target one project', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-notices-'));
  const db = new Database(path.join(directory, 'notices.db'));
  let clock = 1_800_000_000_000;
  try {
    createTables(db);
    let notifier = createFeishuDefectNotifier({ db, target, now: () => clock, logger: { warn() {} } });
    assert.equal(notifier.enqueue('created', { ...defect, projectId: '00000000-0000-4000-8000-000000000000' }), false);
    assert.equal(notifier.enqueue('created', defect), true);
    assert.equal(db.prepare('SELECT count(*) AS total FROM feishu_defect_notifications').get().total, 1);
    const before = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    notifier.start(async () => { throw new Error('simulated temporary failure'); });
    assert.equal(await notifier.flush(), 0);
    const afterFailure = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    assert.equal(afterFailure.id, before.id);
    assert.equal(afterFailure.attempts, 1);
    assert.equal(afterFailure.next_attempt_at, clock + 30_000);
    notifier.close();

    clock += 30_000;
    const newChatId = 'oc_abcdef0123456789abcdef0123456789';
    const oldProjectId = '00000000-0000-4000-8000-000000000000';
    db.prepare(`INSERT INTO feishu_defect_notifications
      (id, defect_id, project_id, chat_id, content, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('old-project-event', defect.id, oldProjectId, chatId,
      '旧项目内容', clock, new Date(clock).toISOString());
    notifier = createFeishuDefectNotifier({ db, target: { ...target, chatId: newChatId }, now: () => clock, logger: { warn() {} } });
    const calls = [];
    notifier.start(async (payload) => calls.push(payload));
    assert.equal(await notifier.flush(), 1);
    assert.deepEqual(calls.map((item) => [item.id, item.chatId]), [[before.id, chatId]]);
    assert.equal(db.prepare('SELECT count(*) AS total FROM feishu_defect_notifications').get().total, 0);
    notifier.close();
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Feishu send API receives a stable uuid and the exact group chat id', async () => {
  const requests = [];
  const send = createFeishuDefectSender({ im: { v1: { message: { create: async (request) => { requests.push(request); return { code: 0 }; } } } } });
  await send({ chatId, text: '通知内容', id: 'stable-queue-id' });
  assert.deepEqual(requests, [{
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: '通知内容' }), uuid: 'stable-queue-id' },
  }]);
  await assert.rejects(createFeishuDefectSender({ im: { v1: { message: { create: async () => ({ code: 999 }) } } } })({ chatId, text: 'x', id: 'x' }), /发送失败/);
});

test('image sender compresses a local defect image, uploads it, and never reads an unsafe path', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-image-'));
  const storedName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
  try {
    await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#37a49b' } })
      .png().toFile(path.join(directory, storedName));
    const uploads = []; const messages = [];
    const client = { im: { v1: {
      image: { create: async (request) => { uploads.push(request); return { image_key: 'img_test_key' }; } },
      message: { create: async (request) => { messages.push(request); return { code: 0 }; } },
    } } };
    const send = createFeishuDefectSender(client, { imageDir: directory });
    assert.deepEqual(await send({ chatId, image: { id: 'image-1', storedName }, id: 'stable-image-id' }), { skipped: false });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].data.image_type, 'message');
    assert.ok(Buffer.isBuffer(uploads[0].data.image));
    assert.ok(uploads[0].data.image.length <= 9 * 1024 * 1024);
    assert.equal((await sharp(uploads[0].data.image).metadata()).format, 'webp');
    assert.deepEqual(messages, [{
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: 'img_test_key' }), uuid: 'stable-image-id' },
    }]);
    assert.deepEqual(await send({ chatId, image: { storedName: '../outside.png' }, id: 'unsafe' }), { skipped: true });
    assert.deepEqual(await send({ chatId, image: { storedName: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png' }, id: 'missing' }), { skipped: true });
    assert.equal(uploads.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('image snapshot and delivery progress survive failure, deletion and restart without resending text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-image-queue-'));
  const db = new Database(path.join(directory, 'notices.db'));
  let clock = 1_800_000_000_000;
  try {
    createTables(db);
    const imageIds = ['image-1', 'image-2'];
    for (const [index, id] of imageIds.entries()) {
      db.prepare('INSERT INTO defect_images VALUES (?, ?, ?, ?, ?)').run(id, defect.id, projectId,
        `${index + 1}1111111-1111-4111-8111-111111111111.png`, new Date(clock + index).toISOString());
    }
    let notifier = createFeishuDefectNotifier({ db, target, now: () => clock, logger: { warn() {} } });
    assert.equal(notifier.enqueue('created', defect), true);
    let row = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    assert.deepEqual(JSON.parse(row.images_json).map((item) => item.id), imageIds);
    db.prepare('DELETE FROM defect_images').run();
    const calls = []; let failSecond = true;
    const send = async (payload) => {
      calls.push(payload);
      if (payload.image?.id === 'image-2' && failSecond) { failSecond = false; throw new Error('temporary image failure'); }
    };
    notifier.start(send);
    assert.equal(await notifier.flush(), 0);
    row = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    assert.equal(row.text_sent, 1);
    assert.equal(row.next_image_index, 1);
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, clock + 30_000);
    notifier.close();

    clock += 30_000;
    notifier = createFeishuDefectNotifier({ db, target, now: () => clock, logger: { warn() {} } });
    notifier.start(send);
    assert.equal(await notifier.flush(), 1);
    assert.deepEqual(calls.map((call) => call.image?.id || 'text'), ['text', 'image-1', 'image-2', 'image-2']);
    assert.deepEqual(calls.map((call) => call.id), [row.id, `${row.id}-img-0`, `${row.id}-img-1`, `${row.id}-img-1`]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM feishu_defect_notifications').get().count, 0);
    notifier.close();
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('queued image snapshot survives original deletion, network failure and service restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-image-snapshot-'));
  const imageDir = path.join(directory, 'defect-images');
  fs.mkdirSync(imageDir);
  const db = new Database(path.join(directory, 'notices.db'));
  let clock = 1_800_000_000_000;
  const storedName = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
  try {
    createTables(db);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#37a49b' } })
      .png().toFile(path.join(imageDir, storedName));
    db.prepare('INSERT INTO defect_images VALUES (?, ?, ?, ?, ?)').run('image-1', defect.id, projectId,
      storedName, new Date(clock).toISOString());
    let notifier = createFeishuDefectNotifier({ db, target, imageDir, now: () => clock, logger: { warn() {} } });
    assert.equal(notifier.enqueue('created', defect), true);
    const queued = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    const [image] = JSON.parse(queued.images_json);
    const snapshot = path.join(imageDir, 'notification-snapshots', image.snapshotName);
    assert.ok(fs.existsSync(snapshot));
    fs.rmSync(path.join(imageDir, storedName));
    db.prepare('DELETE FROM defect_images').run();

    notifier.start(async () => { throw new Error('network down'); });
    assert.equal(await notifier.flush(), 0);
    assert.ok(fs.existsSync(snapshot));
    notifier.close();

    const messages = [];
    const send = createFeishuDefectSender({ im: { v1: {
      image: { create: async ({ data }) => {
        assert.equal((await sharp(data.image).metadata()).format, 'webp');
        return { image_key: 'img_test_key' };
      } },
      message: { create: async (request) => { messages.push(request); return { code: 0 }; } },
    } } }, { imageDir });
    clock += 30_000;
    notifier = createFeishuDefectNotifier({ db, target, imageDir, now: () => clock, logger: { warn() {} } });
    notifier.start(send);
    assert.equal(await notifier.flush(), 1);
    assert.deepEqual(messages.map((message) => message.data.msg_type), ['text', 'image']);
    assert.deepEqual(messages.map((message) => message.data.receive_id), [chatId, chatId]);
    assert.equal(fs.existsSync(snapshot), false);
    notifier.close();
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing notification snapshot retries instead of silently marking image delivered', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-image-retry-'));
  const imageDir = path.join(directory, 'defect-images');
  fs.mkdirSync(path.join(imageDir, 'notification-snapshots'), { recursive: true });
  const db = new Database(path.join(directory, 'notices.db'));
  try {
    createTables(db);
    const notifier = createFeishuDefectNotifier({ db, target, imageDir, logger: { warn() {} } });
    const image = { storedName: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
      snapshotName: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png' };
    db.prepare(`INSERT INTO feishu_defect_notifications
      (id, defect_id, project_id, chat_id, content, next_attempt_at, created_at, images_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('queued-image', defect.id, projectId, chatId,
      '缺陷内容', 1, new Date(1).toISOString(), JSON.stringify([image]));
    const send = createFeishuDefectSender({ im: { v1: {
      message: { create: async () => ({ code: 0 }) },
    } } }, { imageDir });
    notifier.start(send);
    assert.equal(await notifier.flush(), 0);
    const row = db.prepare('SELECT * FROM feishu_defect_notifications WHERE id = ?').get('queued-image');
    assert.equal(row.text_sent, 1);
    assert.equal(row.next_image_index, 0);
    assert.equal(row.attempts, 1);
    notifier.close();
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('preexisting text-only queue rows migrate without images or duplicate messages', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-queue-upgrade-'));
  const db = new Database(path.join(directory, 'notices.db'));
  try {
    createTables(db);
    db.exec(`CREATE TABLE feishu_defect_notifications (
      id TEXT PRIMARY KEY, defect_id TEXT NOT NULL, project_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, content TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, created_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO feishu_defect_notifications
      (id, defect_id, project_id, chat_id, content, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('old-notice', defect.id, projectId, chatId, '旧通知', 1, new Date(1).toISOString());
    const notifier = createFeishuDefectNotifier({ db, target, logger: { warn() {} } });
    const row = db.prepare('SELECT * FROM feishu_defect_notifications').get();
    assert.equal(row.images_json, '[]');
    assert.equal(row.text_sent, 0);
    assert.equal(row.next_image_index, 0);
    const calls = [];
    notifier.start(async (payload) => calls.push(payload));
    assert.equal(await notifier.flush(), 1);
    assert.deepEqual(calls.map((call) => call.text), ['旧通知']);
    notifier.close();
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('closing while a message is in flight leaves its queued row for restart without touching closed DB', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-notices-close-'));
  const db = new Database(path.join(directory, 'notices.db'));
  let finish;
  try {
    createTables(db);
    const notifier = createFeishuDefectNotifier({ db, target, logger: { warn() {} } });
    notifier.enqueue('created', defect);
    notifier.start(() => new Promise((resolve) => { finish = resolve; }));
    const pending = notifier.flush();
    notifier.close();
    db.close();
    finish();
    assert.equal(await pending, 0);
    const reopened = new Database(path.join(directory, 'notices.db'));
    assert.equal(reopened.prepare('SELECT count(*) AS total FROM feishu_defect_notifications').get().total, 1);
    reopened.close();
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
