import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createFeishuDefectNotifier, createFeishuDefectSender,
  formatFeishuDefectNotice, loadFeishuDefectTarget } from '../feishu-defect-notifications.js';

const projectId = '11111111-2222-4333-8444-555555555555';
const chatId = 'oc_0123456789abcdef0123456789abcdef';
const target = { projectId, chatId };
const defect = { id: '281e78cd-39ac-4662-ae70-a41bd71612b5', projectId, title: '活动规则显示异常',
  issueType: '版本问题', version: '1.2.3', module: '活动', status: '待处理',
  reproSteps: '不应出现在群里的详细重现步骤', actual: '不应出现在群里的实际结果', notes: '不应出现在群里的备注' };

test('group target is explicit, validated, and no sensitive defect body is sent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-target-'));
  try {
    assert.equal(loadFeishuDefectTarget(directory), null);
    fs.writeFileSync(path.join(directory, 'feishu-defect-notifications.json'), JSON.stringify(target));
    assert.deepEqual(loadFeishuDefectTarget(directory), target);
    const text = formatFeishuDefectNotice('created', defect, '甜点项目组');
    assert.match(text, /新建缺陷/);
    assert.match(text, /281e78cd/);
    assert.match(text, /活动规则显示异常/);
    assert.doesNotMatch(text, /重现步骤|实际结果|备注|39ac-4662/);
    assert.match(formatFeishuDefectNotice('closed', { ...defect, title: '' }, '甜点项目组'), /标题：未填写/);
    fs.writeFileSync(path.join(directory, 'feishu-defect-notifications.json'), JSON.stringify({ ...target, chatId: 'not-a-chat' }));
    assert.throws(() => loadFeishuDefectTarget(directory), /配置无效/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('queued notices survive restart, retry with stable idempotency key, and only target one project', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-notices-'));
  const db = new Database(path.join(directory, 'notices.db'));
  let clock = 1_800_000_000_000;
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT)');
    db.prepare('INSERT INTO projects VALUES (?, ?, NULL)').run(projectId, '甜点项目组');
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
    assert.deepEqual(calls.map((item) => [item.id, item.chatId]), [[before.id, newChatId]]);
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

test('closing while a message is in flight leaves its queued row for restart without touching closed DB', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-notices-close-'));
  const db = new Database(path.join(directory, 'notices.db'));
  let finish;
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT)');
    db.prepare('INSERT INTO projects VALUES (?, ?, NULL)').run(projectId, '示例项目组');
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
