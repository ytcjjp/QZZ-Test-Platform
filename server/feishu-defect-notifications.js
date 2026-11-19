import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const NOTIFICATION_TYPES = { created: '新建缺陷', resolved: '缺陷已解决', closed: '缺陷已关闭' };
const IMAGE_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/i;

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

async function prepareMessageImage(source) {
  for (const size of [2048, 1600, 1200, 900, 600]) {
    const image = await sharp(source, { limitInputPixels: 32_000_000 })
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 }).toBuffer();
    if (image.length <= 9 * 1024 * 1024) return image;
  }
  throw new Error('飞书缺陷图片压缩后仍超过上传限制');
}

export function createFeishuDefectSender(client, { imageDir } = {}) {
  return async ({ chatId, text, image, id }) => {
    if (image) {
      if (!imageDir || !IMAGE_NAME.test(image.storedName || '') ||
          (image.snapshotName && !IMAGE_NAME.test(image.snapshotName))) {
        return { skipped: true };
      }
      const filename = image.snapshotName
        ? path.join(imageDir, 'notification-snapshots', image.snapshotName)
        : path.join(imageDir, image.storedName);
      let stats;
      try { stats = await fs.promises.lstat(filename); }
      catch (error) { if (!image.snapshotName && error.code === 'ENOENT') return { skipped: true }; throw error; }
      if (!stats.isFile() || stats.size === 0 || stats.size > 32 * 1024 * 1024) {
        if (image.snapshotName) throw new Error('飞书缺陷图片快照无效');
        return { skipped: true };
      }
      const bytes = await prepareMessageImage(await fs.promises.readFile(filename));
      const upload = await client.im.v1.image.create({ data: { image_type: 'message', image: bytes } });
      if (!upload?.image_key) throw new Error('飞书缺陷图片上传失败');
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: upload.image_key }), uuid: id },
      });
      if (response?.code !== 0) throw new Error('飞书缺陷图片发送失败');
      return { skipped: false };
    }
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: id },
    });
    if (response?.code !== 0) throw new Error('飞书缺陷通知发送失败');
  };
}

export function createFeishuDefectNotifier({ db, target, imageDir, logger = console, now = Date.now }) {
  if (!target) return { enqueue: () => false, start: () => {}, flush: async () => 0, close: () => {} };
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_defect_notifications (
    id TEXT PRIMARY KEY, defect_id TEXT NOT NULL, project_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, content TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, created_at TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]', text_sent INTEGER NOT NULL DEFAULT 0,
    next_image_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS feishu_defect_notifications_next_idx
    ON feishu_defect_notifications(next_attempt_at, created_at);`);
  const columns = new Set(db.prepare('PRAGMA table_info(feishu_defect_notifications)').all().map((column) => column.name));
  for (const [column, definition] of Object.entries({
    images_json: "TEXT NOT NULL DEFAULT '[]'", text_sent: 'INTEGER NOT NULL DEFAULT 0',
    next_image_index: 'INTEGER NOT NULL DEFAULT 0',
  })) {
    if (!columns.has(column)) db.exec(`ALTER TABLE feishu_defect_notifications ADD COLUMN ${column} ${definition}`);
  }
  const insert = db.prepare(`INSERT INTO feishu_defect_notifications
    (id, defect_id, project_id, chat_id, content, next_attempt_at, created_at, images_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const due = db.prepare('SELECT * FROM feishu_defect_notifications WHERE next_attempt_at <= ? ORDER BY next_attempt_at, created_at LIMIT 20');
  const next = db.prepare('SELECT MIN(next_attempt_at) AS time FROM feishu_defect_notifications');
  const delivered = db.prepare('DELETE FROM feishu_defect_notifications WHERE id = ?');
  const retry = db.prepare('UPDATE feishu_defect_notifications SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?');
  const markText = db.prepare('UPDATE feishu_defect_notifications SET text_sent = 1 WHERE id = ?');
  const markImage = db.prepare('UPDATE feishu_defect_notifications SET next_image_index = ? WHERE id = ?');
  const defectImages = db.prepare('SELECT id, stored_name FROM defect_images WHERE defect_id = ? AND project_id = ? ORDER BY created_at, id');
  const project = db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL');
  const snapshotDir = imageDir && path.join(imageDir, 'notification-snapshots');
  if (snapshotDir) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const referenced = new Set(db.prepare('SELECT images_json FROM feishu_defect_notifications').all()
      .flatMap((row) => {
        try { return JSON.parse(row.images_json).map((image) => image.snapshotName).filter((name) => IMAGE_NAME.test(name)); }
        catch { return []; }
      }));
    for (const name of fs.readdirSync(snapshotDir)) {
      if (IMAGE_NAME.test(name) && !referenced.has(name)) fs.rmSync(path.join(snapshotDir, name), { force: true });
    }
  }
  let send; let timer; let running; let stopped = false;

  function removeSnapshots(images) {
    if (!snapshotDir) return;
    for (const image of images) {
      if (IMAGE_NAME.test(image.snapshotName || '')) {
        try { fs.rmSync(path.join(snapshotDir, image.snapshotName), { force: true }); }
        catch (error) { logger.warn('飞书缺陷通知快照清理失败', error); }
      }
    }
  }

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
    const images = defectImages.all(defect.id, defect.projectId).map((image) => ({ id: image.id, storedName: image.stored_name }));
    for (const image of images) {
      if (!snapshotDir || !IMAGE_NAME.test(image.storedName)) continue;
      const snapshotName = `${crypto.randomUUID()}.png`;
      try {
        const source = path.join(imageDir, image.storedName);
        const destination = path.join(snapshotDir, snapshotName);
        try { fs.linkSync(source, destination); }
        catch { fs.copyFileSync(source, destination); }
        image.snapshotName = snapshotName;
      } catch (error) {
        try { fs.rmSync(path.join(snapshotDir, snapshotName), { force: true }); }
        catch { /* orphan snapshots are also removed when the service restarts */ }
        logger.warn('飞书缺陷通知图片快照失败，将在投递时读取原图', error);
      }
    }
    try {
      insert.run(crypto.randomUUID(), defect.id, defect.projectId, target.chatId,
        formatFeishuDefectNotice(type, defect), time, new Date(time).toISOString(), JSON.stringify(images));
    } catch (error) { removeSnapshots(images); throw error; }
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
        let textSent = Boolean(row.text_sent);
        try {
          const images = JSON.parse(row.images_json);
          if (!Array.isArray(images)) throw new Error('缺陷图片队列格式无效');
          if (row.project_id !== target.projectId) {
            delivered.run(row.id);
            removeSnapshots(images);
            logger.warn('飞书缺陷通知目标项目已变更，已跳过旧项目待发消息');
            continue;
          }
          if (!textSent) {
            await send({ chatId: row.chat_id, text: row.content, id: row.id });
            if (stopped) break;
            markText.run(row.id);
            textSent = true;
          }
          for (let index = row.next_image_index; index < images.length; index++) {
            const result = await send({ chatId: row.chat_id, image: images[index], id: `${row.id}-img-${index}` });
            if (stopped) break;
            if (result?.skipped) logger.warn('飞书缺陷图片文件缺失或无法读取，已跳过该图片');
            markImage.run(index + 1, row.id);
          }
          if (stopped) break;
          delivered.run(row.id);
          removeSnapshots(images);
          count += 1;
        } catch {
          if (stopped) break;
          const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(row.attempts, 7));
          retry.run(now() + delay, row.id);
          logger.warn(textSent ? '飞书缺陷图片发送失败，请检查网络与 im:resource:upload 权限；已加入自动重试队列'
            : '飞书缺陷通知发送失败，已加入自动重试队列');
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
