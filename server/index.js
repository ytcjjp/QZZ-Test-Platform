import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';

const scrypt = promisify(crypto.scrypt);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, '..');
const dataDir = path.resolve(process.env.QZZ_DATA_DIR || path.join(projectDir, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const credentialFile = path.join(dataDir, 'initial-admin.txt');
const distDir = path.join(projectDir, 'client', 'dist');
const port = Number(process.env.PORT || 3210);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 100);
const trustProxy = process.env.TRUST_PROXY === '1';

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
if (!Number.isFinite(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 1024) {
  throw new Error('MAX_UPLOAD_MB must be between 1 and 1024');
}
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, 'platform.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, module TEXT NOT NULL,
    priority TEXT NOT NULL, status TEXT NOT NULL, preconditions TEXT NOT NULL,
    steps TEXT NOT NULL, expected TEXT NOT NULL, notes TEXT NOT NULL,
    tags TEXT NOT NULL, revision INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cases_updated_idx ON cases(updated_at DESC);
  CREATE TABLE IF NOT EXISTS defects (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, module TEXT NOT NULL,
    severity TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL,
    version TEXT NOT NULL, repro_steps TEXT NOT NULL, expected TEXT NOT NULL,
    actual TEXT NOT NULL, notes TEXT NOT NULL, revision INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS defects_updated_idx ON defects(updated_at DESC);
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL, size INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_created_idx ON files(created_at DESC);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${digest}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, salt, encoded] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'hex');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

if (db.prepare('SELECT count(*) AS count FROM users').get().count === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new Error('Invalid ADMIN_USERNAME');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
  if (generated) {
    fs.writeFileSync(credentialFile, `username=${username}\npassword=${password}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Initial admin credentials: ${credentialFile}`);
  }
  try {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), username, hashPassword(password), 'admin', new Date().toISOString());
  } catch (error) {
    if (generated) fs.unlinkSync(credentialFile);
    throw error;
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy ? 'loopback' : false);
app.use(express.json({ limit: '1mb' }));

function sendError(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function cookieToken(req) {
  const item = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('qzz_session='));
  const value = item?.slice('qzz_session='.length) || '';
  return /^[A-Za-z0-9_-]{40,50}$/.test(value) ? value : null;
}

function userFromRequest(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return db.prepare(`SELECT users.id, users.username, users.role FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(tokenHash, Date.now()) || null;
}

function requireAuth(req, res, next) {
  req.user = userFromRequest(req);
  if (!req.user) return sendError(res, 401, 'unauthorized', '请先登录');
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return sendError(res, 403, 'forbidden', '仅管理员可操作');
  next();
}

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    const expected = `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') {
      return sendError(res, 403, 'forbidden', '跨站请求已拒绝');
    }
  }
  next();
});

const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttemptKeys = 5000;
let lastLoginPrune = 0;

function pruneLoginAttempts(now) {
  if (now - lastLoginPrune < 60000 && loginAttempts.size < maxLoginAttemptKeys) return;
  for (const [key, attempt] of loginAttempts) {
    if (attempt.expiresAt <= now) loginAttempts.delete(key);
  }
  lastLoginPrune = now;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ user: userFromRequest(req) });
});

app.post('/api/session', async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) return sendError(res, 400, 'invalid_input', '请输入账号和密码');
    if (username.length > 32 || password.length > 200) {
      return sendError(res, 400, 'invalid_input', '账号或密码格式不正确');
    }
    const now = Date.now();
    pruneLoginAttempts(now);
    const attemptKey = `${req.ip}:${username}`;
    const attempt = loginAttempts.get(attemptKey);
    if ((attempt && attempt.expiresAt > now && attempt.count >= 10) ||
        (!attempt && loginAttempts.size >= maxLoginAttemptKeys)) {
      return sendError(res, 429, 'too_many_attempts', '尝试次数过多，请稍后重试');
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const valid = user && await verifyPassword(password, user.password_hash);
    if (!valid) {
      loginAttempts.set(attemptKey, {
        count: (attempt?.expiresAt > now ? attempt.count : 0) + 1,
        expiresAt: now + loginWindowMs,
      });
      return sendError(res, 401, 'invalid_credentials', '账号或密码错误');
    }
    loginAttempts.delete(attemptKey);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, expiresAt);
    res.cookie('qzz_session', token, {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    if (user.role === 'admin' && fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) { next(error); }
});

app.delete('/api/session', requireAuth, (req, res) => {
  const token = cookieToken(req);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  for (const client of wss.clients) {
    if (client.tokenHash === tokenHash) client.close(1008, 'Session ended');
  }
  res.clearCookie('qzz_session', { path: '/' });
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/config', (req, res) => {
  res.json({ aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), maxUploadMb });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at').all();
  res.json({ users });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username) || password.length < 12 || password.length > 200) {
    return sendError(res, 400, 'invalid_input', '账号须为 2-32 位文字、数字或 ._-；密码须为 12-200 位');
  }
  const user = { id: crypto.randomUUID(), username, role: 'member', createdAt: new Date().toISOString() };
  try {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.username, hashPassword(password), user.role, user.createdAt);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'duplicate', '账号已存在');
    throw error;
  }
  res.status(201).json({ user });
});

function readString(value, field, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new InputError(`${field} 格式不正确`);
  return value.trim();
}

class InputError extends Error {}

function readRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new InputError('revision 格式不正确');
  return value;
}

function normalizeCase(body, previous = {}) {
  const source = body || {};
  const tags = source.tags === undefined ? previous.tags || [] : source.tags;
  if (!Array.isArray(tags) || tags.length > 30 ||
      tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) {
    throw new InputError('tags 格式不正确');
  }
  const result = {
    title: readString(source.title, 'title', 200, previous.title),
    module: readString(source.module, 'module', 100, previous.module || ''),
    priority: readString(source.priority, 'priority', 30, previous.priority || 'medium'),
    status: readString(source.status, 'status', 30, previous.status || 'draft'),
    preconditions: readString(source.preconditions, 'preconditions', 20000, previous.preconditions || ''),
    steps: readString(source.steps, 'steps', 20000, previous.steps || ''),
    expected: readString(source.expected, 'expected', 20000, previous.expected || ''),
    notes: readString(source.notes, 'notes', 20000, previous.notes || ''),
    tags: [...new Set(tags.map((tag) => tag.trim()))],
  };
  if (!result.title) throw new InputError('请输入用例标题');
  return result;
}

function mapCase(row) {
  return {
    id: row.id, title: row.title, module: row.module, priority: row.priority,
    status: row.status, preconditions: row.preconditions, steps: row.steps,
    expected: row.expected, notes: row.notes, tags: JSON.parse(row.tags),
    revision: row.revision, createdBy: row.creator_name, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const caseSelect = `SELECT cases.*, users.username AS creator_name FROM cases
  JOIN users ON users.id = cases.created_by`;
const getCase = db.prepare(`${caseSelect} WHERE cases.id = ?`);

app.get('/api/cases', (req, res) => {
  res.json({ cases: db.prepare(`${caseSelect} ORDER BY cases.updated_at DESC, cases.id DESC`).all().map(mapCase) });
});

app.post('/api/cases', (req, res) => {
  const value = normalizeCase(req.body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, value.title, value.module, value.priority, value.status, value.preconditions,
      value.steps, value.expected, value.notes, JSON.stringify(value.tags), req.user.id, now, now);
  const record = mapCase(getCase.get(id));
  broadcast('case.created', { case: record });
  res.status(201).json({ case: record });
});

app.put('/api/cases/:id', (req, res) => {
  const current = getCase.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '用例不存在');
  const revision = readRevision(req.body?.revision);
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '用例已被其他人修改，请刷新后重试', case: mapCase(current) });
  }
  const value = normalizeCase(req.body, mapCase(current));
  const result = db.prepare(`UPDATE cases SET title=?, module=?, priority=?, status=?, preconditions=?,
    steps=?, expected=?, notes=?, tags=?, revision=revision+1, updated_at=?
    WHERE id=? AND revision=?`).run(value.title, value.module, value.priority, value.status,
      value.preconditions, value.steps, value.expected, value.notes, JSON.stringify(value.tags),
      new Date().toISOString(), current.id, revision);
  if (!result.changes) return res.status(409).json({ error: 'conflict', message: '用例已被其他人修改', case: mapCase(getCase.get(current.id)) });
  const record = mapCase(getCase.get(current.id));
  broadcast('case.updated', { case: record });
  res.json({ case: record });
});

app.delete('/api/cases/:id', (req, res) => {
  const revision = readRevision(req.body?.revision);
  const current = getCase.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '用例不存在');
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '用例已被其他人修改', case: mapCase(current) });
  }
  const result = db.prepare('DELETE FROM cases WHERE id = ? AND revision = ?').run(current.id, revision);
  if (!result.changes) {
    const latest = getCase.get(current.id);
    return latest
      ? res.status(409).json({ error: 'conflict', message: '用例已被其他人修改', case: mapCase(latest) })
      : sendError(res, 404, 'not_found', '用例不存在');
  }
  broadcast('case.deleted', { id: current.id });
  res.json({ ok: true });
});

function normalizeDefect(body, previous = {}) {
  const source = body || {};
  const result = {
    title: readString(source.title, 'title', 200, previous.title),
    module: readString(source.module, 'module', 100, previous.module || ''),
    severity: readString(source.severity, 'severity', 30, previous.severity || 'medium'),
    status: readString(source.status, 'status', 30, previous.status || 'open'),
    assignee: readString(source.assignee, 'assignee', 100, previous.assignee || ''),
    version: readString(source.version, 'version', 100, previous.version || ''),
    reproSteps: readString(source.reproSteps, 'reproSteps', 20000, previous.reproSteps || ''),
    expected: readString(source.expected, 'expected', 20000, previous.expected || ''),
    actual: readString(source.actual, 'actual', 20000, previous.actual || ''),
    notes: readString(source.notes, 'notes', 20000, previous.notes || ''),
  };
  if (!result.title) throw new InputError('请输入缺陷标题');
  return result;
}

function mapDefect(row) {
  return {
    id: row.id, title: row.title, module: row.module, severity: row.severity,
    status: row.status, assignee: row.assignee, version: row.version,
    reproSteps: row.repro_steps, expected: row.expected, actual: row.actual,
    notes: row.notes, revision: row.revision, createdBy: row.creator_name,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const defectSelect = `SELECT defects.*, users.username AS creator_name FROM defects
  JOIN users ON users.id = defects.created_by`;
const getDefect = db.prepare(`${defectSelect} WHERE defects.id = ?`);

app.get('/api/defects', (req, res) => {
  res.json({ defects: db.prepare(`${defectSelect} ORDER BY defects.updated_at DESC, defects.id DESC`).all().map(mapDefect) });
});

app.post('/api/defects', (req, res) => {
  const value = normalizeDefect(req.body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO defects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, value.title, value.module, value.severity, value.status, value.assignee,
      value.version, value.reproSteps, value.expected, value.actual, value.notes,
      req.user.id, now, now);
  const record = mapDefect(getDefect.get(id));
  broadcast('defect.created', { defect: record });
  res.status(201).json({ defect: record });
});

app.put('/api/defects/:id', (req, res) => {
  const current = getDefect.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '缺陷不存在');
  const revision = readRevision(req.body?.revision);
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改，请刷新后重试', defect: mapDefect(current) });
  }
  const value = normalizeDefect(req.body, mapDefect(current));
  const result = db.prepare(`UPDATE defects SET title=?, module=?, severity=?, status=?, assignee=?,
    version=?, repro_steps=?, expected=?, actual=?, notes=?, revision=revision+1, updated_at=?
    WHERE id=? AND revision=?`).run(value.title, value.module, value.severity, value.status,
      value.assignee, value.version, value.reproSteps, value.expected, value.actual,
      value.notes, new Date().toISOString(), current.id, revision);
  if (!result.changes) return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(getDefect.get(current.id)) });
  const record = mapDefect(getDefect.get(current.id));
  broadcast('defect.updated', { defect: record });
  res.json({ defect: record });
});

app.delete('/api/defects/:id', (req, res) => {
  const revision = readRevision(req.body?.revision);
  const current = getDefect.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '缺陷不存在');
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(current) });
  }
  const result = db.prepare('DELETE FROM defects WHERE id = ? AND revision = ?').run(current.id, revision);
  if (!result.changes) {
    const latest = getDefect.get(current.id);
    return latest
      ? res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(latest) })
      : sendError(res, 404, 'not_found', '缺陷不存在');
  }
  broadcast('defect.deleted', { id: current.id });
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}.bin`),
  }),
  limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
});

const fileSelect = `SELECT files.*, users.username AS uploader_name FROM files
  JOIN users ON users.id = files.uploaded_by`;
const getFile = db.prepare(`${fileSelect} WHERE files.id = ?`);

function mapFile(row) {
  return {
    id: row.id, name: row.name, size: row.size, mimeType: row.mime_type,
    uploadedBy: row.uploader_name, createdAt: row.created_at,
    downloadUrl: `/api/files/${row.id}/download`,
  };
}

app.get('/api/files', (req, res) => {
  res.json({ files: db.prepare(`${fileSelect} ORDER BY files.created_at DESC, files.id DESC`).all().map(mapFile) });
});

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return sendError(res, 400, 'invalid_input', '请选择文件');
  const name = path.basename(req.file.originalname).replace(/[\x00-\x1f\\/]/g, '').slice(0, 200);
  if (!name) {
    fs.unlinkSync(req.file.path);
    return sendError(res, 400, 'invalid_input', '文件名不能为空');
  }
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, req.file.filename, req.file.mimetype || 'application/octet-stream',
        req.file.size, req.user.id, new Date().toISOString());
  } catch (error) {
    fs.unlinkSync(req.file.path);
    throw error;
  }
  const record = mapFile(getFile.get(id));
  broadcast('file.created', { file: record });
  res.status(201).json({ file: record });
});

app.get('/api/files/:id/download', (req, res, next) => {
  const record = getFile.get(req.params.id);
  if (!record) return sendError(res, 404, 'not_found', '文件不存在');
  res.download(path.join(uploadDir, record.stored_name), record.name, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.delete('/api/files/:id', (req, res) => {
  const record = getFile.get(req.params.id);
  if (!record) return sendError(res, 404, 'not_found', '文件不存在');
  db.prepare('DELETE FROM files WHERE id = ?').run(record.id);
  try { fs.unlinkSync(path.join(uploadDir, record.stored_name)); }
  catch (error) { if (error.code !== 'ENOENT') console.error('File cleanup failed:', error); }
  broadcast('file.deleted', { id: record.id });
  res.json({ ok: true });
});

app.post('/api/ai/generate', async (req, res) => {
  if (!process.env.AI_API_KEY || !process.env.AI_MODEL) {
    return sendError(res, 503, 'ai_not_configured', 'AI 服务尚未配置，请联系管理员');
  }
  const requirements = readString(req.body?.requirements, 'requirements', 12000);
  const module = readString(req.body?.module, 'module', 100);
  const count = req.body?.count === undefined ? 5 : req.body.count;
  if (!requirements || !Number.isSafeInteger(count) || count < 1 || count > 20) {
    return sendError(res, 400, 'invalid_input', '请填写需求描述，生成数量须为 1-20');
  }
  try {
    const baseUrl = new URL(process.env.AI_BASE_URL || 'https://api.openai.com/v1/');
    if (!['https:', 'http:'].includes(baseUrl.protocol)) throw new Error('Invalid AI_BASE_URL');
    const apiUrl = new URL('chat/completions', `${baseUrl.href.replace(/\/$/, '')}/`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.AI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        messages: [
          { role: 'system', content: '你是游戏测试用例编写助手。仅输出 JSON 对象，格式为 {"cases":[{"title":"","module":"","priority":"medium","preconditions":"","steps":"","expected":"","notes":"","tags":[]}]}。每条需有明确的步骤和预期；不要编造未给出的业务规则，必要时在 notes 标注待确认。不要输出 Markdown。' },
          { role: 'user', content: `模块：${module || '未指定'}\n生成数量：${count}\n需求：\n${requirements}` },
        ],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.cases) || parsed.cases.length < 1 || parsed.cases.length > count) {
      throw new Error('Invalid AI cases');
    }
    const cases = parsed.cases.map((item) => normalizeCase({ ...item, module: item.module || module }));
    res.json({ cases });
  } catch (error) {
    console.error('AI generation failed:', error);
    sendError(res, 502, 'ai_failed', 'AI 服务暂时不可用，请稍后重试');
  }
});

app.use('/api', (req, res) => sendError(res, 404, 'not_found', '接口不存在'));

if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(distDir, 'index.html'));
    next();
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof InputError) return sendError(res, 400, 'invalid_input', error.message);
  if (error instanceof multer.MulterError) {
    return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      'upload_error', error.code === 'LIMIT_FILE_SIZE' ? `文件不能超过 ${maxUploadMb} MB` : '文件上传失败');
  }
  if (error instanceof SyntaxError && 'body' in error) return sendError(res, 400, 'invalid_json', '请求内容不是有效的 JSON');
  console.error(error);
  sendError(res, 500, 'internal_error', '服务器发生错误');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const protocol = trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const expectedOrigin = `${protocol}://${req.headers.host}`;
  if (req.url !== '/api/events' || !userFromRequest(req) ||
      (req.headers.origin && req.headers.origin !== expectedOrigin)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.tokenHash = crypto.createHash('sha256').update(cookieToken(req)).digest('hex');
    wss.emit('connection', ws, req);
  });
});

function broadcast(type, details) {
  const payload = JSON.stringify({ type, ...details });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(client.tokenHash, Date.now());
    if (session) client.send(payload);
    else client.close(1008, 'Session expired');
  }
}

server.listen(port, '0.0.0.0', () => {
  console.log(`QZZ test platform listening on http://0.0.0.0:${server.address().port}`);
});

process.on('SIGINT', () => { server.close(); wss.close(); db.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); wss.close(); db.close(); process.exit(0); });
