import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { uploadFilename } from './upload-name.js';

const MAX_FILES_PER_REQUEST = 12;
const MAX_FILES_PER_DEFECT = 24;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const STALE_UPLOAD_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

export function createDefectImageStore({ db, dataDir, sendError, inputError }) {
  const directory = path.join(dataDir, 'defect-images');
  const temporary = path.join(directory, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const staleBefore = Date.now() - STALE_UPLOAD_AGE_MS;
  for (const entry of fs.readdirSync(temporary, { withFileTypes: true })) {
    if (!entry.isFile() || !TEMP_UPLOAD_NAME.test(entry.name)) continue;
    const filename = path.join(temporary, entry.name);
    try {
      const stats = fs.lstatSync(filename);
      if (stats.isFile() && stats.mtimeMs < staleBefore) fs.rmSync(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Failed to clean up stale defect upload:', error);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS defect_images (
    id TEXT PRIMARY KEY, defect_id TEXT NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE, thumb_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL, size INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS defect_images_owner_idx ON defect_images(defect_id, project_id, created_at, id);`);

  const uploader = multer({
    storage: multer.diskStorage({
      destination: temporary,
      filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.tmp`),
    }),
    limits: { files: MAX_FILES_PER_REQUEST, fileSize: MAX_INPUT_BYTES, fields: 1, fieldSize: 256 * 1024 },
  });
  const listRows = db.prepare('SELECT * FROM defect_images WHERE defect_id = ? AND project_id = ? ORDER BY created_at, id');
  const getRow = db.prepare('SELECT * FROM defect_images WHERE id = ? AND defect_id = ? AND project_id = ?');
  const insert = db.prepare(`INSERT INTO defect_images
    (id, defect_id, project_id, name, stored_name, thumb_name, mime_type, size, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function parseUpload(req, res, next) {
    if (!req.is('multipart/form-data')) return next();
    uploader.array('image', MAX_FILES_PER_REQUEST)(req, res, (error) => {
      if (error instanceof multer.MulterError) return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        'upload_error', error.code === 'LIMIT_FILE_SIZE' ? '单张缺陷图片不能超过 20 MB' : '最多上传 12 张图片，请检查表单');
      if (error) return next(error);
      next();
    });
  }

  function payload(req) {
    if (!req.is('multipart/form-data')) return req.body;
    if (typeof req.body?.payload !== 'string') throw inputError('缺陷表单格式不正确');
    try {
      const body = JSON.parse(req.body.payload);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
      return body;
    } catch { throw inputError('缺陷表单格式不正确'); }
  }

  function cleanupUpload(req) {
    for (const file of req.files || []) fs.rmSync(file.path, { force: true });
  }

  function discard(images) {
    for (const image of images) {
      fs.rmSync(path.join(directory, image.stored_name), { force: true });
      fs.rmSync(path.join(directory, image.thumb_name), { force: true });
    }
  }

  function assertCapacity(defectId, count) {
    if (!count) return;
    const existing = db.prepare('SELECT COUNT(*) AS count FROM defect_images WHERE defect_id = ?').get(defectId).count;
    if (existing + count > MAX_FILES_PER_DEFECT) throw inputError('每条缺陷最多保存 24 张图片');
  }

  async function prepare(req) {
    const images = [];
    try {
      for (const file of req.files || []) {
        const id = crypto.randomUUID();
        const image = { id, name: uploadFilename(file.originalname, '图片.png').slice(0, 200),
          stored_name: `${id}.png`, thumb_name: `${id}.webp`, created_at: new Date().toISOString() };
        images.push(image);
        const output = path.join(directory, image.stored_name);
        const preview = path.join(directory, image.thumb_name);
        const decoder = sharp(file.path, { limitInputPixels: MAX_PIXELS, failOn: 'warning', pages: 1 });
        const metadata = await decoder.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
          throw inputError('仅支持静态 PNG、JPEG、WebP 图片');
        }
        await decoder.rotate().resize(4096, 4096, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 }).toFile(output);
        image.size = fs.statSync(output).size;
        if (image.size > MAX_OUTPUT_BYTES) throw inputError('图片处理后超过 32 MB，请缩小后重试');
        await sharp(output).resize(320, 240, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 }).toFile(preview);
      }
      return images;
    } catch (error) {
      discard(images);
      if (error?.name === 'InputError' || error?.code?.startsWith('E')) throw error;
      throw inputError('图片无法读取或尺寸过大，请使用有效的 PNG、JPEG、WebP 文件');
    } finally { cleanupUpload(req); }
  }

  function save(images, defectId, projectId, userId) {
    assertCapacity(defectId, images.length);
    for (const image of images) insert.run(image.id, defectId, projectId, image.name, image.stored_name,
      image.thumb_name, 'image/png', image.size, userId, image.created_at);
  }

  function list(defectId, projectId) {
    return listRows.all(defectId, projectId).map((row) => ({
      id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, createdAt: row.created_at,
      url: `/api/defects/${defectId}/images/${row.id}?projectId=${encodeURIComponent(projectId)}`,
      thumbnailUrl: `/api/defects/${defectId}/images/${row.id}/thumbnail?projectId=${encodeURIComponent(projectId)}`,
    }));
  }

  function row(imageId, defectId, projectId) { return getRow.get(imageId, defectId, projectId); }
  function stored(defectId, projectId) { return listRows.all(defectId, projectId); }
  function removeFiles(rows) { discard(rows); }
  function imagePath(row, thumbnail = false) {
    const name = thumbnail ? row.thumb_name : row.stored_name;
    const pattern = thumbnail ? /^[0-9a-f-]{36}\.webp$/i : /^[0-9a-f-]{36}\.png$/i;
    return pattern.test(name) ? path.join(directory, name) : null;
  }

  return { parseUpload, payload, cleanupUpload, prepare, discard, assertCapacity, save, list, row, stored, removeFiles, imagePath };
}
