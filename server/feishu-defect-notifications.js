import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NOTIFICATION_TYPES = { created: '新建缺陷', resolved: '缺陷已解决', closed: '缺陷已关闭' };

export function loadFeishuDefectTarget(dataDir) {
  const filename = path.join(dataDir, 'feishu-defect-notifications.json');
  if (!fs.existsSync(filename)) return null;
  const target = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!target || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.projectId || '') ||
      !/^oc_[a-zA-Z0-9]+$/.test(target.chatId || '')) {
    throw new Error('飞书缺陷通知目标配置无效');
  }
  return { projectId: target.projectId, chatId: target.chatId };
}

function line(value, limit = 200, fallback = '未填写') {
  return String(value || '').replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) || fallback;
}

export function formatFeishuDefectNotice(type, defect) {
  if (!Object.hasOwn(NOTIFICATION_TYPES, type)) throw new Error('缺陷通知类型无效');
  return [
    `问题类型：${line(defect.issueType, 20)}`,
    `标题：${line(defect.title)}`,
    `发现版本：${line(defect.version, 100)}`,
    `模块：${line(defect.module, 100)}`,
    `状态：${line(defect.status, 30)}`,
    `负责人：${line(defect.assignee, 100, '')}`,
    `缺陷编号：${line(defect.id, 100).slice(0, 8)}`,
  ].join('\n');
}

export function createFeishuDefectSender(client) {
  return async ({ chatId, text, id }) => {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: id },
    });
    if (response?.code !== 0) throw new Error('飞书缺陷通知发送失败');
  };
}

export function createFeishuDefectNotifier({ db, target, logger = console, now = Date.now }) {
  if (!target) return { enqueue: () => false, start: () => {}, flush: async () => 0, close: () => {} };
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_defect_notifications (
    id TEXT PRIMARY KEY, defect_id TEXT NOT NULL, project_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, content TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feishu_defect_notifications_next_idx
    ON feishu_defect_notifications(next_attempt_at, created_at);`);
  const insert = db.prepare(`INSERT INTO feishu_defect_notifications
    (id, defect_id, project_id, chat_id, content, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const due = db.prepare('SELECT * FROM feishu_defect_notifications WHERE next_attempt_at <= ? ORDER BY next_attempt_at, created_at LIMIT 20');
  const next = db.prepare('SELECT MIN(next_attempt_at) AS time FROM feishu_defect_notifications');
  const delivered = db.prepare('DELETE FROM feishu_defect_notifications WHERE id = ?');
  const retry = db.prepare('UPDATE feishu_defect_notifications SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?');
  const project = db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL');
  let send; let timer; let running; let stopped = false;

  function schedule() {
    if (!send || stopped) return;
    clearTimeout(timer);
    const time = next.get().time;
    if (time === null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => { if (!stopped) logger.warn('飞书缺陷通知队列处理失败，等待下次服务启动重试'); });
    }, Math.max(0, Math.min(time - now(), 60 * 60 * 1000)));
    timer.unref?.();
  }

  function enqueue(type, defect) {
    if (stopped || defect.projectId !== target.projectId) return false;
    if (!project.get(defect.projectId)) return false;
    const time = now();
    insert.run(crypto.randomUUID(), defect.id, defect.projectId, target.chatId,
      formatFeishuDefectNotice(type, defect), time, new Date(time).toISOString());
    if (send) schedule();
    return true;
  }

  async function flush() {
    if (!send || stopped) return 0;
    if (running) return running;
    running = (async () => {
      let count = 0;
      for (const row of due.all(now())) {
        if (stopped) break;
        if (row.project_id !== target.projectId) {
          delivered.run(row.id);
          logger.warn('飞书缺陷通知目标项目已变更，已跳过旧项目待发消息');
          continue;
        }
        try {
          await send({ chatId: target.chatId, text: row.content, id: row.id });
          if (stopped) break;
          delivered.run(row.id);
          count += 1;
        } catch {
          if (stopped) break;
          const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(row.attempts, 7));
          retry.run(now() + delay, row.id);
          logger.warn('飞书缺陷通知发送失败，已加入自动重试队列');
        }
      }
      return count;
    })();
    try { return await running; }
    finally { running = null; schedule(); }
  }

  function start(sendMessage) {
    if (typeof sendMessage !== 'function') throw new Error('飞书缺陷通知发送器无效');
    send = sendMessage;
    schedule();
  }

  function close() {
    stopped = true;
    clearTimeout(timer);
  }

  return { enqueue, start, flush, close };
}
