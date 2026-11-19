import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { initializeProjects, createProjectService } from './projects.js';
import { loadAiProvider, publicAiProvider } from './ai-provider.js';
import { initializeCaseSets, caseTree, registerCaseSetRoutes } from './case-sets.js';
import { registerCaseExecutionRoutes } from './case-executions.js';
import { registerAiRoutes } from './ai-documents.js';
import { createFeishuBrowserService, registerFeishuBrowserRoutes } from './feishu-browser.js';
import { createFeishuDefectNotifier, createFeishuDefectSender, loadFeishuDefectTarget } from './feishu-defect-notifications.js';
import { createDefectImageStore } from './defect-images.js';
import { initializeWorkspaceDocuments, registerWorkspaceDocumentRoutes } from './workspace-documents.js';
import { registerAiWorkspaceRoutes } from './ai-workspace.js';
import { registerCodeAuditRoutes } from './code-audits.js';
import { uploadFilename } from './upload-name.js';
import { hashPassword, verifyPassword, loadPasswordKey,
  encryptPassword as encryptWithKey, decryptPassword as decryptWithKey } from './passwords.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, '..');
const dataDir = path.resolve(process.env.QZZ_DATA_DIR || path.join(projectDir, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const credentialFile = path.join(dataDir, 'initial-admin.txt');
const distDir = path.resolve(projectDir, process.env.QZZ_CLIENT_DIST || path.join('client', 'dist'));
const port = Number(process.env.PORT || 3210);
const trustProxy = process.env.TRUST_PROXY === '1';

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
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
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    issue_type TEXT NOT NULL DEFAULT '版本问题' CHECK (issue_type IN ('版本问题', '线上问题')),
    module TEXT NOT NULL,
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
if (!db.prepare('PRAGMA table_info(defects)').all().some((column) => column.name === 'issue_type')) {
  db.exec("ALTER TABLE defects ADD COLUMN issue_type TEXT NOT NULL DEFAULT '版本问题' CHECK (issue_type IN ('版本问题', '线上问题'))");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS file_folders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES file_folders(id),
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS file_folders_name_idx
    ON file_folders(COALESCE(parent_id, ''), name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS file_folders_parent_idx ON file_folders(parent_id);
`);
if (!db.prepare('PRAGMA table_info(files)').all().some((column) => column.name === 'folder_id')) {
  db.exec('ALTER TABLE files ADD COLUMN folder_id TEXT REFERENCES file_folders(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS files_folder_idx ON files(folder_id, created_at DESC)');
const projectIconDir = initializeProjects(db, dataDir);
initializeCaseSets(db);
const workspaceDocuments = initializeWorkspaceDocuments(db, dataDir);
const feishuBrowser = createFeishuBrowserService({ dataDir });
if (!db.prepare('PRAGMA table_info(cases)').all().some((column) => column.name === 'requirement_id')) db.exec('ALTER TABLE cases ADD COLUMN requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL');

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
for (const [name, definition] of Object.entries({
  disabled: 'INTEGER NOT NULL DEFAULT 0', permissions: 'TEXT', password_encrypted: 'TEXT', deleted_at: 'TEXT',
})) {
  if (!userColumns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS account_audit (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL,
  action TEXT NOT NULL, created_at TEXT NOT NULL
)`);
const passwordKey = loadPasswordKey(dataDir, Boolean(db.prepare('SELECT 1 FROM users WHERE password_encrypted IS NOT NULL').get()));
const permissionModules = ['cases', 'defects', 'ai', 'files', 'requirements', 'knowledge'];

function normalizePermissions(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new InputError('权限格式不正确');
  return Object.fromEntries(permissionModules.map((name) => {
    const item = value?.[name];
    if (item != null && (typeof item !== 'object' || Array.isArray(item))) throw new InputError('权限格式不正确');
    for (const flag of ['view', 'write']) {
      if (item?.[flag] !== undefined && typeof item[flag] !== 'boolean') throw new InputError('权限格式不正确');
    }
    const view = item?.view ?? true;
    return [name, { view, write: view && (item?.write ?? true) }];
  }));
}

function mapUser(user) {
  return { id: user.id, username: user.username, role: user.role, disabled: Boolean(user.disabled),
    permissions: normalizePermissions(user.role === 'admin' ? null : JSON.parse(user.permissions || 'null')),
    passwordAvailable: Boolean(user.password_encrypted), createdAt: user.created_at };
}

function encryptPassword(password) {
  return encryptWithKey(password, passwordKey);
}

function decryptPassword(value) {
  return decryptWithKey(value, passwordKey);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw new InputError('密码须为 6-200 位');
}

function audit(actor, target, action) {
  db.prepare('INSERT INTO account_audit VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), actor, target, action, new Date().toISOString());
}

if (db.prepare('SELECT count(*) AS count FROM users').get().count === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new Error('Invalid ADMIN_USERNAME');
  if (password.length < 6 || password.length > 200) throw new Error('ADMIN_PASSWORD must contain 6-200 characters');
  if (generated) {
    fs.writeFileSync(credentialFile, `username=${username}\npassword=${password}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`Initial admin credentials: ${credentialFile}`);
  }
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, password_encrypted) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), username, hashPassword(password), 'admin', new Date().toISOString(), encryptPassword(password));
  } catch (error) {
    if (generated) fs.unlinkSync(credentialFile);
    throw error;
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy ? 'loopback' : false);
app.use(express.json({ limit: '4mb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

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
  const user = db.prepare(`SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.disabled = 0`)
    .get(tokenHash, Date.now()) || null;
  return user ? mapUser(user) : null;
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
const accountAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttemptKeys = 5000;
let lastLoginPrune = 0;

function limitAccountAttempts(req, res, next) {
  const now = Date.now();
  for (const [key, value] of accountAttempts) {
    if (value.expiresAt <= now) accountAttempts.delete(key);
  }
  const key = `${req.ip}:${req.user?.id || 'public'}:${req.path.endsWith('reveal-password') ? 'reveal' : req.path}`;
  const previous = accountAttempts.get(key);
  const maximum = req.path === '/api/register' ? 30 : 10;
  if ((previous?.count || 0) >= maximum || (!previous && accountAttempts.size >= maxLoginAttemptKeys)) {
    return sendError(res, 429, 'too_many_attempts', '尝试次数过多，请稍后重试');
  }
  accountAttempts.set(key, { count: (previous?.count || 0) + 1, expiresAt: previous?.expiresAt || now + loginWindowMs });
  next();
}

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
  res.json({ user: userFromRequest(req), registrationEnabled: true });
});

function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const remember = req.body?.remember === true;
  const duration = (remember ? 30 : 1) * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + duration);
  res.cookie('qzz_session', token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', ...(remember ? { maxAge: duration } : {}),
  });
}

function createUser(body, actor) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new InputError('账号须为 2-32 位文字、数字或 ._-');
  validatePassword(body?.password);
  if (body.confirmPassword !== undefined && body.password !== body.confirmPassword) throw new InputError('两次密码不一致');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return null;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, password_encrypted) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, hashPassword(body.password), 'member', new Date().toISOString(), encryptPassword(body.password));
  audit(actor || id, id, actor ? 'user.created' : 'user.registered');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

app.post('/api/register', limitAccountAttempts, (req, res) => {
  if (typeof req.body?.username === 'string' && req.body.username.trim().toLowerCase() === 'admin') {
    return sendError(res, 409, 'reserved_admin', 'admin 为保留管理员账号');
  }
  const user = createUser(req.body);
  if (!user) return sendError(res, 409, 'duplicate', '账号已存在');
  createSession(req, res, user);
  res.status(201).json({ user: mapUser(user) });
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
    const verified = user && !user.disabled && await verifyPassword(password, user.password_hash);
    const fresh = user && db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const valid = verified && fresh && !fresh.disabled && fresh.password_hash === user.password_hash;
    if (!valid) {
      loginAttempts.set(attemptKey, {
        count: (attempt?.expiresAt > now ? attempt.count : 0) + 1,
        expiresAt: now + loginWindowMs,
      });
      return sendError(res, 401, 'invalid_credentials', '账号或密码错误');
    }
    loginAttempts.delete(attemptKey);
    createSession(req, res, fresh);
    if (user.role === 'admin' && fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
    res.json({ user: mapUser(fresh) });
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
  try { res.json(publicAiProvider(loadAiProvider(dataDir))); }
  catch { res.json({ aiConfigured: false, aiConfigError: '本机 AI 配置无法读取，请联系管理员检查配置' }); }
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at').all().map(mapUser);
  res.json({ users });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const user = createUser(req.body, req.user.id);
  if (!user) return sendError(res, 409, 'duplicate', '账号已存在');
  res.status(201).json({ user: mapUser(user) });
});

function invalidateUserSessions(id, keepToken = null) {
  const keepHash = keepToken ? crypto.createHash('sha256').update(keepToken).digest('hex') : '';
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(id, keepHash);
  for (const client of wss.clients) {
    if (client.userId === id && client.tokenHash !== keepHash) client.close(1008, 'Account updated');
  }
}

app.get('/api/account', (req, res) => res.json({ user: req.user }));
app.patch('/api/account', (req, res) => {
  if (Object.keys(req.body || {}).length) return sendError(res, 400, 'invalid_input', '当前仅支持在修改密码中更新密码');
  res.json({ user: req.user });
});

app.post('/api/account/password', limitAccountAttempts, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const currentPassword = req.body?.currentPassword;
  if (typeof currentPassword !== 'string' || currentPassword.length > 200 ||
      !await verifyPassword(currentPassword, user.password_hash)) {
    return sendError(res, 403, 'invalid_password', '当前密码不正确');
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!userFromRequest(req) || fresh.password_hash !== user.password_hash) {
    return sendError(res, 401, 'unauthorized', '账号已更新，请重新登录');
  }
  validatePassword(req.body?.newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_encrypted = ? WHERE id = ?')
    .run(hashPassword(req.body.newPassword), encryptPassword(req.body.newPassword), user.id);
  invalidateUserSessions(user.id, cookieToken(req));
  audit(user.id, user.id, 'password.changed');
  res.json({ ok: true, user: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return sendError(res, 404, 'not_found', '账号不存在');
  const role = req.body?.role ?? user.role;
  const disabled = req.body?.disabled ?? Boolean(user.disabled);
  if (!['admin', 'member'].includes(role) || typeof disabled !== 'boolean') throw new InputError('账号设置格式不正确');
  if (user.username === 'admin' && (role !== 'admin' || disabled)) {
    return sendError(res, 400, 'reserved_admin', 'admin 为保留管理员，不能停用或降级');
  }
  if (user.role === 'admin' && !user.disabled && (role !== 'admin' || disabled) &&
      db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count <= 1) {
    return sendError(res, 400, 'last_admin', '至少保留一名启用的管理员');
  }
  const permissions = normalizePermissions(req.body?.permissions ?? JSON.parse(user.permissions || 'null'));
  if (req.body?.password !== undefined) validatePassword(req.body.password);
  db.prepare('UPDATE users SET role = ?, disabled = ?, permissions = ?, password_hash = ?, password_encrypted = ? WHERE id = ?')
    .run(role, Number(disabled), JSON.stringify(permissions),
      req.body?.password !== undefined ? hashPassword(req.body.password) : user.password_hash,
      req.body?.password !== undefined ? encryptPassword(req.body.password) : user.password_encrypted, user.id);
  invalidateUserSessions(user.id, user.id === req.user.id ? cookieToken(req) : null);
  audit(req.user.id, user.id, req.body?.password !== undefined ? 'user.password_reset' : 'user.permissions_changed');
  res.json({ user: mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return sendError(res, 404, 'not_found', '账号不存在');
  if (user.id === req.user.id || user.role !== 'member') {
    return sendError(res, 400, 'protected_admin', '管理员账号不能删除');
  }
  db.transaction(() => {
    db.prepare(`UPDATE users SET username = ?, disabled = 1, password_hash = ?,
      password_encrypted = NULL, permissions = ?, deleted_at = ? WHERE id = ?`)
      .run(`已删除成员-${user.id}`, hashPassword(crypto.randomBytes(32).toString('base64url')),
        JSON.stringify(Object.fromEntries(permissionModules.map((module) => [module, { view: false, write: false }]))),
        new Date().toISOString(), user.id);
    audit(req.user.id, user.id, 'user.deleted');
  })();
  invalidateUserSessions(user.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reveal-password', requireAdmin, limitAccountAttempts, async (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const password = req.body?.currentPassword;
  if (typeof password !== 'string' || password.length > 200 || !await verifyPassword(password, admin.password_hash)) {
    return sendError(res, 403, 'invalid_password', '管理员密码不正确');
  }
  const freshAdmin = userFromRequest(req);
  const freshCredentials = db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id);
  if (!freshAdmin || freshAdmin.role !== 'admin' || freshCredentials.password_hash !== admin.password_hash) {
    return sendError(res, 401, 'unauthorized', '账号已更新，请重新登录');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return sendError(res, 404, 'not_found', '账号不存在');
  audit(req.user.id, user.id, 'password.revealed');
  res.set('Cache-Control', 'no-store');
  res.json({ available: Boolean(user.password_encrypted), password: user.password_encrypted ? decryptPassword(user.password_encrypted) : null });
});

const projects = createProjectService({ db, iconDir: projectIconDir, sendError, inputError: (message) => new InputError(message), authenticate: userFromRequest });
const defectImages = createDefectImageStore({ db, dataDir, sendError, inputError: (message) => new InputError(message) });
let defectNotificationTarget = null;
try { defectNotificationTarget = loadFeishuDefectTarget(dataDir); }
catch { console.warn('飞书缺陷通知目标配置无效，通知未启用。'); }
const defectNotifier = createFeishuDefectNotifier({ db, target: defectNotificationTarget,
  imageDir: path.join(dataDir, 'defect-images') });
projects.register(app, requireAdmin, broadcast);

app.use('/api', (req, res, next) => {
  const module = req.path.split('/')[1];
  if (!permissionModules.includes(module) || req.user.role === 'admin') return next();
  const permission = req.user.permissions[module];
  const operation = req.method === 'GET' || (req.method === 'POST' && req.path === '/cases/export') ? 'view' : 'write';
  if (!permission[operation]) return sendError(res, 403, 'forbidden', '没有此模块的操作权限');
  next();
});

app.get('/api/members', requirePermission('defects', 'view'), (_req, res) => {
  res.json({ members: db.prepare(`SELECT id, username FROM users
    WHERE disabled = 0 AND deleted_at IS NULL ORDER BY username COLLATE NOCASE`).all() });
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

function requirePermission(module, action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.permissions?.[module]?.[action]) return next();
    return sendError(res, 403, 'forbidden', '没有此模块的操作权限');
  };
}

function caseRequirement(value, projectId, req, previous = null) {
  if (value === undefined) return previous;
  if (value === null || value === '') return null;
  if (!req.user.permissions.requirements.view) throw new InputError('没有关联需求的查看权限');
  if (typeof value !== 'string' || !workspaceDocuments.getRequirement(projectId, value)) throw new InputError('关联需求不存在或不属于当前项目');
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
  result.tree = caseTree(source, previous, result, (message) => new InputError(message));
  return result;
}

function mapCase(row) {
  return {
    id: row.id, projectId: row.project_id, title: row.title, module: row.module, priority: row.priority,
    status: row.status, preconditions: row.preconditions, steps: row.steps,
    expected: row.expected, notes: row.notes, tags: JSON.parse(row.tags), tree: JSON.parse(row.tree),
    revision: row.revision, createdBy: row.creator_name, createdAt: row.created_at,
    updatedAt: row.updated_at, requirementId: row.requirement_id || null,
  };
}

const caseSelect = `SELECT cases.*, users.username AS creator_name FROM cases
  JOIN users ON users.id = cases.created_by`;
const getCase = db.prepare(`${caseSelect} WHERE cases.id = ?`);
const caseExecutions = registerCaseExecutionRoutes(app, { db, projects, requirePermission, broadcast, sendError });

app.get('/api/cases', (req, res) => {
  const projectId = projects.requireProject(req.query.projectId);
  if (req.query.requirementId !== undefined) {
    const requirementId = caseRequirement(req.query.requirementId, projectId, req);
    return res.json({ cases: db.prepare(`${caseSelect} WHERE cases.project_id = ? AND cases.requirement_id = ? ORDER BY cases.updated_at DESC, cases.id DESC`).all(projectId, requirementId).map(mapCase) });
  }
  res.json({ cases: db.prepare(`${caseSelect} WHERE cases.project_id = ? ORDER BY cases.updated_at DESC, cases.id DESC`).all(projectId).map(mapCase) });
});

app.post('/api/cases', (req, res) => {
  const projectId = projects.requireProject(req.body?.projectId);
  const value = normalizeCase(req.body);
  const requirementId = caseRequirement(req.body?.requirementId, projectId, req);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cases (id, title, module, priority, status, preconditions, steps, expected, notes, tags,
    revision, created_by, created_at, updated_at, project_id, tree, requirement_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(id, value.title, value.module, value.priority, value.status, value.preconditions,
      value.steps, value.expected, value.notes, JSON.stringify(value.tags), req.user.id, now, now, projectId, JSON.stringify(value.tree), requirementId);
  const record = mapCase(getCase.get(id));
  broadcast('case.created', { case: record, projectId });
  res.status(201).json({ case: record });
});

app.put('/api/cases/:id', (req, res) => {
  const projectId = projects.requireProject(req.body?.projectId);
  const current = getCase.get(req.params.id);
  if (!current || current.project_id !== projectId) return sendError(res, 404, 'not_found', '用例不存在');
  const revision = readRevision(req.body?.revision);
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '用例已被其他人修改，请刷新后重试', case: mapCase(current) });
  }
  const value = normalizeCase(req.body, mapCase(current));
  const requirementId = caseRequirement(req.body?.requirementId, projectId, req, current.requirement_id);
  const result = db.prepare(`UPDATE cases SET title=?, module=?, priority=?, status=?, preconditions=?,
    steps=?, expected=?, notes=?, tags=?, tree=?, requirement_id=?, revision=revision+1, updated_at=?
    WHERE id=? AND revision=?`).run(value.title, value.module, value.priority, value.status,
      value.preconditions, value.steps, value.expected, value.notes, JSON.stringify(value.tags), JSON.stringify(value.tree), requirementId,
      new Date().toISOString(), current.id, revision);
  if (!result.changes) return res.status(409).json({ error: 'conflict', message: '用例已被其他人修改', case: mapCase(getCase.get(current.id)) });
  caseExecutions.prune(current.id, value.tree);
  const record = mapCase(getCase.get(current.id));
  broadcast('case.updated', { case: record, projectId });
  res.json({ case: record });
});

app.delete('/api/cases/:id', (req, res) => {
  const projectId = projects.requireProject(req.body?.projectId);
  const revision = readRevision(req.body?.revision);
  const current = getCase.get(req.params.id);
  if (!current || current.project_id !== projectId) return sendError(res, 404, 'not_found', '用例不存在');
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
  broadcast('case.deleted', { id: current.id, projectId });
  res.json({ ok: true });
});

function normalizeDefect(body, previous = {}) {
  const source = body || {};
  const issueType = readString(source.issueType, 'issueType', 20, previous.issueType || '版本问题');
  if (!['版本问题', '线上问题'].includes(issueType)) throw new InputError('缺陷类型只能为版本问题或线上问题');
  const result = {
    issueType,
    title: readString(source.title, 'title', 200, previous.title || ''),
    module: readString(source.module, 'module', 100, previous.module || ''),
    severity: readString(source.severity, 'severity', 30, previous.severity || '一般'),
    status: readString(source.status, 'status', 30, previous.status || '待处理'),
    assignee: readString(source.assignee, 'assignee', 100, previous.assignee || ''),
    version: readString(source.version, 'version', 100, previous.version || ''),
    reproSteps: readString(source.reproSteps, 'reproSteps', 20000, previous.reproSteps || ''),
    expected: readString(source.expected, 'expected', 20000, previous.expected || ''),
    actual: readString(source.actual, 'actual', 20000, previous.actual || ''),
    notes: readString(source.notes, 'notes', 20000, previous.notes || ''),
  };
  return result;
}

function mapDefect(row) {
  return {
    id: row.id, projectId: row.project_id, title: row.title, issueType: row.issue_type,
    module: row.module, severity: row.severity,
    status: row.status, assignee: row.assignee, version: row.version,
    reproSteps: row.repro_steps, expected: row.expected, actual: row.actual,
    notes: row.notes, images: defectImages.list(row.id, row.project_id),
    revision: row.revision, createdBy: row.creator_name,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const defectSelect = `SELECT defects.*, users.username AS creator_name FROM defects
  JOIN users ON users.id = defects.created_by`;
const getDefect = db.prepare(`${defectSelect} WHERE defects.id = ?`);

app.get('/api/defects', (req, res) => {
  const projectId = projects.requireProject(req.query.projectId);
  res.json({ defects: db.prepare(`${defectSelect} WHERE defects.project_id = ? ORDER BY defects.updated_at DESC, defects.id DESC`).all(projectId).map(mapDefect) });
});

app.post('/api/defects', defectImages.parseUpload, async (req, res) => {
  let images = []; let saved = false;
  try {
    const input = defectImages.payload(req);
    const projectId = projects.requireProject(input?.projectId);
    const value = normalizeDefect(input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    defectImages.assertCapacity(id, req.files?.length || 0);
    images = await defectImages.prepare(req);
    const freshUser = userFromRequest(req);
    if (!freshUser) return sendError(res, 401, 'unauthorized', '账号已更新，请重新登录');
    if (!freshUser.permissions.defects.write) return sendError(res, 403, 'forbidden', '没有此模块的操作权限');
    const record = db.transaction(() => {
      db.prepare(`INSERT INTO defects (id, title, issue_type, module, severity, status, assignee, version, repro_steps,
        expected, actual, notes, revision, created_by, created_at, updated_at, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(id, value.title, value.issueType, value.module, value.severity, value.status, value.assignee,
          value.version, value.reproSteps, value.expected, value.actual, value.notes,
          freshUser.id, now, now, projectId);
      defectImages.save(images, id, projectId, freshUser.id);
      const created = mapDefect(getDefect.get(id));
      defectNotifier.enqueue('created', created);
      return created;
    })();
    saved = true;
    broadcast('defect.created', { defect: record, projectId });
    res.status(201).json({ defect: record });
  } finally {
    defectImages.cleanupUpload(req);
    if (!saved) defectImages.discard(images);
  }
});

app.put('/api/defects/:id', defectImages.parseUpload, async (req, res) => {
  let images = []; let saved = false;
  try {
    const input = defectImages.payload(req);
    const projectId = projects.requireProject(input?.projectId);
    const current = getDefect.get(req.params.id);
    if (!current || current.project_id !== projectId) return sendError(res, 404, 'not_found', '缺陷不存在');
    const revision = readRevision(input?.revision);
    if (revision !== current.revision) {
      return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改，请刷新后重试', defect: mapDefect(current) });
    }
    const value = normalizeDefect(input, mapDefect(current));
    defectImages.assertCapacity(current.id, req.files?.length || 0);
    images = await defectImages.prepare(req);
    const freshUser = userFromRequest(req);
    if (!freshUser) return sendError(res, 401, 'unauthorized', '账号已更新，请重新登录');
    if (!freshUser.permissions.defects.write) return sendError(res, 403, 'forbidden', '没有此模块的操作权限');
    const record = db.transaction(() => {
      const result = db.prepare(`UPDATE defects SET title=?, issue_type=?, module=?, severity=?, status=?, assignee=?,
        version=?, repro_steps=?, expected=?, actual=?, notes=?, revision=revision+1, updated_at=?
        WHERE id=? AND revision=?`).run(value.title, value.issueType, value.module, value.severity, value.status,
          value.assignee, value.version, value.reproSteps, value.expected, value.actual,
          value.notes, new Date().toISOString(), current.id, revision);
      if (!result.changes) return null;
      defectImages.save(images, current.id, projectId, freshUser.id);
      const updated = mapDefect(getDefect.get(current.id));
      if (current.status !== updated.status && ['已解决', '已关闭'].includes(updated.status)) {
        defectNotifier.enqueue(updated.status === '已解决' ? 'resolved' : 'closed', updated);
      }
      return updated;
    })();
    if (!record) return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(getDefect.get(current.id)) });
    saved = true;
    broadcast('defect.updated', { defect: record, projectId });
    res.json({ defect: record });
  } finally {
    defectImages.cleanupUpload(req);
    if (!saved) defectImages.discard(images);
  }
});

function serveDefectImage(req, res, next, thumbnail) {
  const projectId = projects.requireProject(req.query.projectId);
  const defect = getDefect.get(req.params.id);
  if (!defect || defect.project_id !== projectId) return sendError(res, 404, 'not_found', '缺陷不存在');
  const image = defectImages.row(req.params.imageId, defect.id, projectId);
  if (!image) return sendError(res, 404, 'not_found', '图片不存在');
  const filename = defectImages.imagePath(image, thumbnail);
  if (!filename || !fs.existsSync(filename)) return sendError(res, 404, 'not_found', '图片不存在');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', 'sandbox');
  res.type(thumbnail ? 'webp' : 'png');
  res.sendFile(filename, (error) => { if (error && !res.headersSent) next(error); });
}

app.get('/api/defects/:id/images/:imageId/thumbnail', (req, res, next) => serveDefectImage(req, res, next, true));
app.get('/api/defects/:id/images/:imageId', (req, res, next) => serveDefectImage(req, res, next, false));

app.delete('/api/defects/:id/images/:imageId', (req, res) => {
  const projectId = projects.requireProject(req.body?.projectId);
  const current = getDefect.get(req.params.id);
  if (!current || current.project_id !== projectId) return sendError(res, 404, 'not_found', '缺陷不存在');
  const image = defectImages.row(req.params.imageId, current.id, projectId);
  if (!image) return sendError(res, 404, 'not_found', '图片不存在');
  const revision = readRevision(req.body?.revision);
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改，请刷新后重试', defect: mapDefect(current) });
  }
  const updated = db.transaction(() => {
    const result = db.prepare('UPDATE defects SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(new Date().toISOString(), current.id, revision);
    if (!result.changes) return null;
    db.prepare('DELETE FROM defect_images WHERE id = ? AND defect_id = ?').run(image.id, current.id);
    return mapDefect(getDefect.get(current.id));
  })();
  if (!updated) return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(getDefect.get(current.id)) });
  try { defectImages.removeFiles([image]); }
  catch (error) { console.error('Defect image cleanup failed:', error); }
  broadcast('defect.updated', { defect: updated, projectId });
  res.json({ defect: updated });
});

app.delete('/api/defects/:id', (req, res) => {
  const projectId = projects.requireProject(req.body?.projectId);
  const revision = readRevision(req.body?.revision);
  const current = getDefect.get(req.params.id);
  if (!current || current.project_id !== projectId) return sendError(res, 404, 'not_found', '缺陷不存在');
  if (revision !== current.revision) {
    return res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(current) });
  }
  const images = defectImages.stored(current.id, projectId);
  const result = db.prepare('DELETE FROM defects WHERE id = ? AND revision = ?').run(current.id, revision);
  if (!result.changes) {
    const latest = getDefect.get(current.id);
    return latest
      ? res.status(409).json({ error: 'conflict', message: '缺陷已被其他人修改', defect: mapDefect(latest) })
      : sendError(res, 404, 'not_found', '缺陷不存在');
  }
  try { defectImages.removeFiles(images); }
  catch (error) { console.error('Defect image cleanup failed:', error); }
  broadcast('defect.deleted', { id: current.id, projectId });
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}.bin`),
  }),
  limits: { files: 24, fields: 1, fieldSize: 100 },
});

const fileSelect = `SELECT files.*, users.username AS uploader_name FROM files
  JOIN users ON users.id = files.uploaded_by`;
const getFile = db.prepare(`${fileSelect} WHERE files.id = ?`);
const folderSelect = `SELECT file_folders.*, users.username AS creator_name FROM file_folders
  JOIN users ON users.id = file_folders.created_by`;
const getFolder = db.prepare(`${folderSelect} WHERE file_folders.id = ?`);

function folderId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) throw new InputError('文件夹格式不正确');
  return value;
}

function folderName(value) {
  const name = readString(value, '文件夹名称', 100);
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) {
    throw new InputError('文件夹名称不能为空，且不能包含斜杠或控制字符');
  }
  return name;
}

function mapFolder(row) {
  return { id: row.id, name: row.name, parentId: row.parent_id,
    createdBy: row.creator_name, createdAt: row.created_at };
}

function folderPath(folder) {
  const pathItems = [];
  for (let current = folder; current; current = current.parent_id ? getFolder.get(current.parent_id) : null) {
    pathItems.unshift(mapFolder(current));
  }
  return pathItems;
}

function duplicateFolder(error) {
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  throw error;
}

function mapFile(row) {
  return {
    id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, folderId: row.folder_id,
    uploadedBy: row.uploader_name, createdAt: row.created_at,
    downloadUrl: `/api/files/${row.id}/download`,
  };
}

app.get('/api/files', (req, res) => {
  const currentId = folderId(req.query.folderId);
  const current = currentId ? getFolder.get(currentId) : null;
  if (currentId && !current) return sendError(res, 404, 'not_found', '文件夹不存在');
  res.json({
    files: db.prepare(`${fileSelect} WHERE files.folder_id IS ? ORDER BY files.created_at DESC, files.id DESC`)
      .all(currentId).map(mapFile),
    folders: db.prepare(`${folderSelect} WHERE file_folders.parent_id IS ? ORDER BY file_folders.name COLLATE NOCASE`)
      .all(currentId).map(mapFolder),
    path: folderPath(current),
    allFolders: db.prepare(`${folderSelect} ORDER BY file_folders.name COLLATE NOCASE`).all().map(mapFolder),
  });
});

app.post('/api/files/folders', (req, res) => {
  const parentId = folderId(req.body?.parentId);
  if (parentId && !getFolder.get(parentId)) return sendError(res, 404, 'not_found', '上级文件夹不存在');
  const name = folderName(req.body?.name);
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO file_folders (id, name, parent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, parentId, req.user.id, new Date().toISOString());
  } catch (error) {
    if (duplicateFolder(error)) return sendError(res, 409, 'duplicate', '同一目录下已有同名文件夹');
  }
  const folder = mapFolder(getFolder.get(id));
  broadcast('file.folder.created', { folder });
  res.status(201).json({ folder });
});

app.put('/api/files/folders/:id', (req, res) => {
  const current = getFolder.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '文件夹不存在');
  const name = folderName(req.body?.name);
  try {
    db.prepare('UPDATE file_folders SET name = ? WHERE id = ?').run(name, current.id);
  } catch (error) {
    if (duplicateFolder(error)) return sendError(res, 409, 'duplicate', '同一目录下已有同名文件夹');
  }
  const folder = mapFolder(getFolder.get(current.id));
  broadcast('file.folder.updated', { folder });
  res.json({ folder });
});

app.delete('/api/files/folders/:id', (req, res) => {
  const current = getFolder.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '文件夹不存在');
  if (db.prepare('SELECT 1 FROM file_folders WHERE parent_id = ?').get(current.id) ||
      db.prepare('SELECT 1 FROM files WHERE folder_id = ?').get(current.id)) {
    return sendError(res, 409, 'folder_not_empty', '请先移走或删除文件夹内的内容');
  }
  db.prepare('DELETE FROM file_folders WHERE id = ?').run(current.id);
  broadcast('file.folder.deleted', { id: current.id, parentId: current.parent_id });
  res.json({ ok: true });
});

app.post('/api/files', (req, res, next) => {
  const targetId = folderId(req.query.folderId);
  if (targetId && !getFolder.get(targetId)) return sendError(res, 404, 'not_found', '文件夹不存在');
  req.targetFolderId = targetId;
  next();
}, upload.array('file', 24), (req, res) => {
  if (!req.files?.length) return sendError(res, 400, 'invalid_input', '请选择文件');
  const entries = req.files.map((file) => ({ file, id: crypto.randomUUID(), name: uploadFilename(file.originalname, '') }));
  const cleanup = () => { for (const { file } of entries) fs.rmSync(file.path, { force: true }); };
  if (entries.some(({ name }) => !name)) {
    cleanup();
    return sendError(res, 400, 'invalid_input', '文件名不能为空');
  }
  try {
    const insert = db.prepare(`INSERT INTO files (id, name, stored_name, mime_type, size, uploaded_by, created_at, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const { file, id, name } of entries) insert.run(id, name, file.filename, file.mimetype || 'application/octet-stream',
        file.size, req.user.id, new Date().toISOString(), req.targetFolderId);
    })();
  } catch (error) {
    cleanup();
    throw error;
  }
  const records = entries.map(({ id }) => mapFile(getFile.get(id)));
  for (const file of records) broadcast('file.created', { file });
  res.status(201).json({ file: records[0], files: records });
});

app.patch('/api/files/:id', (req, res) => {
  const current = getFile.get(req.params.id);
  if (!current) return sendError(res, 404, 'not_found', '文件不存在');
  const targetId = folderId(req.body?.folderId);
  if (targetId && !getFolder.get(targetId)) return sendError(res, 404, 'not_found', '目标文件夹不存在');
  db.prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(targetId, current.id);
  const file = mapFile(getFile.get(current.id));
  broadcast('file.updated', { file });
  res.json({ file });
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

registerCaseSetRoutes(app, { db, projects, sendError, inputError: (message) => new InputError(message), readRevision, mapCase, mapDefect, getCase, getDefect, broadcast, notifyDefect: defectNotifier.enqueue });
registerFeishuBrowserRoutes(app, { service: feishuBrowser, requireAdmin, sendError });
app.get('/api/feishu-browser/extension.zip', requireAdmin, (req, res) => {
  const archive = path.join(projectDir, 'browser-extension', 'dist', 'QZZ-Feishu-Browser.zip');
  if (!fs.existsSync(archive)) return sendError(res, 503, 'extension_missing', '浏览器扩展未打包，请在服务器运行扩展打包命令。');
  res.set('Cache-Control', 'no-store');
  res.download(archive, 'QZZ-Feishu-Browser.zip');
});
registerAiRoutes(app, { db, dataDir, sendError, authenticate: userFromRequest, browserService: feishuBrowser, requireProject: projects.requireProject });
registerWorkspaceDocumentRoutes(app, { db, dataDir, requirePermission, requireProject: projects.requireProject, broadcast, authenticate: userFromRequest, browserService: feishuBrowser });
registerAiWorkspaceRoutes(app, { db, dataDir, workspace: workspaceDocuments, requireProject: projects.requireProject, authenticate: userFromRequest, sendError });
const codeAudit = registerCodeAuditRoutes(app, { db, dataDir, requireProject: projects.requireProject, authenticate: userFromRequest,
  sendError, requirePermission, requireAdmin, getCase, getDefect, mapDefect, broadcast, notifyDefect: defectNotifier.enqueue });

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
    return sendError(res, 400, 'upload_error', '文件上传失败');
  }
  if (error instanceof SyntaxError && 'body' in error) return sendError(res, 400, 'invalid_json', '请求内容不是有效的 JSON');
  if (error.type === 'entity.too.large') return sendError(res, 413, 'too_large', '请求内容超过 4 MB，请缩小思维导图后重试');
  console.error(error);
  sendError(res, 500, 'internal_error', '服务器发生错误');
});

const server = http.createServer(app);
server.requestTimeout = 0;
server.setTimeout(120000);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (feishuBrowser.handleUpgrade(req, socket, head)) return;
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
    ws.userId = userFromRequest(req).id;
    wss.emit('connection', ws, req);
  });
});

function broadcast(type, details) {
  const payload = JSON.stringify({ type, ...details });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const session = db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_hash = ? AND expires_at > ? AND disabled = 0`)
      .get(client.tokenHash, Date.now());
    const category = type.split('.')[0];
    const module = { case: 'cases', defect: 'defects', file: 'files', requirement: 'requirements', plan: 'requirements', knowledge: 'knowledge', audit: 'ai' }[category];
    const user = session && mapUser(session);
    if (user && category === 'project') {
      if (projects.canView(user)) client.send(JSON.stringify({ type, project: projects.mapProject(projects.getProject.get(details.project.id), user) }));
    }
    else if (session && (!module || user.permissions[module].view)) client.send(payload);
    else if (session) continue;
    else client.close(1008, 'Session expired');
  }
}

let feishuBot;
let shuttingDown = false;
server.listen(port, '0.0.0.0', () => {
  console.log(`QZZ test platform listening on http://0.0.0.0:${server.address().port}`);
  if (defectNotificationTarget) {
    void import('./feishu-bot.js').then(async ({ loadFeishuBotCredentials }) => {
      const credentials = loadFeishuBotCredentials(dataDir);
      if (!credentials) throw new Error('飞书机器人凭据缺失');
      const Lark = await import('@larksuiteoapi/node-sdk');
      const client = new Lark.Client({ ...credentials, loggerLevel: Lark.LoggerLevel.error });
      if (!shuttingDown) defectNotifier.start(createFeishuDefectSender(client, { imageDir: path.join(dataDir, 'defect-images') }));
    }).catch(() => { console.warn('飞书缺陷通知暂不可发送，已保存的通知将在服务重启后重试。'); });
  }
  void import('./feishu-bot.js').then(({ startFeishuBot }) => startFeishuBot(dataDir))
    .then((bot) => { if (shuttingDown) bot?.close({ force: true }); else feishuBot = bot; })
    .catch(() => { console.warn('飞书助手未启动，请检查本机凭据、模型、网络及飞书应用配置。'); });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  defectNotifier.close();
  feishuBot?.close({ force: true });
  feishuBrowser.close();
  try { await codeAudit.close(); }
  catch (error) { console.error('Code audit shutdown failed:', error); }
  server.close(); wss.close(); db.close(); process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
