import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';

export function initializeProjects(db, dataDir) {
  const iconDir = path.join(dataDir, 'project-icons');
  fs.mkdirSync(iconDir, { recursive: true });
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      icon_file TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    if (!db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'deleted_at')) db.exec('ALTER TABLE projects ADD COLUMN deleted_at TEXT');
    for (const table of ['cases', 'defects']) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'project_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT REFERENCES projects(id)`);
      }
    }
    let defaultProject = db.prepare('SELECT id FROM projects ORDER BY created_at, id LIMIT 1').get();
    if (!defaultProject) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO projects (id, name, name_key, icon_file, revision, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?)')
        .run(id, '默认项目组', '默认项目组', now, now);
      defaultProject = { id };
    }
    for (const table of ['cases', 'defects']) {
      db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id IS NULL OR project_id = ''`).run(defaultProject.id);
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project_updated_idx ON ${table}(project_id, updated_at DESC)`);
    }
  })();
  return iconDir;
}

export function createProjectService({ db, iconDir, sendError, inputError, authenticate }) {
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const canView = (user) => user.permissions.cases.view || user.permissions.defects.view;

  function mapProject(row, user) {
    return {
      id: row.id, name: row.name,
      iconUrl: row.icon_file ? `/api/projects/${row.id}/icon?v=${row.revision}` : null,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
      caseCount: user.permissions.cases.view ? db.prepare('SELECT count(*) AS count FROM cases WHERE project_id = ?').get(row.id).count : null,
      defectCount: user.permissions.defects.view ? db.prepare('SELECT count(*) AS count FROM defects WHERE project_id = ?').get(row.id).count : null,
    };
  }

  function requireProject(value) {
    if (typeof value !== 'string' || !value || value.length > 100) throw inputError('请先选择项目组');
    const project = getProject.get(value);
    if (!project || project.deleted_at) throw inputError('项目组不存在或已删除，请重新选择');
    return project.id;
  }

  function nameValue(value) {
    if (typeof value !== 'string') throw inputError('请输入项目组名称');
    const name = value.trim().normalize('NFC');
    if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw inputError('项目组名称须为 1-60 位');
    return { name, key: name.toLowerCase() };
  }

  function revisionValue(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw inputError('revision 格式不正确');
    return value;
  }

  function conflict(res, row, user) {
    return res.status(409).json({ error: 'conflict', message: '项目组已被其他人修改，请刷新后重试', project: mapProject(row, user) });
  }

  function requireView(req, res, next) {
    if (!canView(req.user)) return sendError(res, 403, 'forbidden', '没有项目组的查看权限');
    next();
  }

  function register(app, requireAdmin, broadcast) {
    app.get('/api/projects', requireView, (req, res) => {
      const archived = req.query.archived === '1';
      if (archived && req.user.role !== 'admin') return sendError(res, 403, 'forbidden', '仅管理员可查看已删除项目组');
      res.json({ projects: db.prepare(`SELECT * FROM projects WHERE deleted_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY created_at, id`).all().map((row) => mapProject(row, req.user)) });
    });

    app.post('/api/projects', requireAdmin, (req, res) => {
      const value = nameValue(req.body?.name);
      if (db.prepare('SELECT 1 FROM projects WHERE name_key = ?').get(value.key)) {
        return sendError(res, 409, 'duplicate', '项目组名称已存在，请检查已删除项目组并恢复');
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO projects (id, name, name_key, icon_file, revision, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?)').run(id, value.name, value.key, now, now);
      const project = mapProject(getProject.get(id), req.user);
      broadcast('project.created', { project });
      res.status(201).json({ project });
    });

    app.put('/api/projects/:id', requireAdmin, (req, res) => {
      const current = getProject.get(req.params.id);
      if (!current || current.deleted_at) return sendError(res, 404, 'not_found', '项目组不存在或已删除');
      const revision = revisionValue(req.body?.revision);
      if (revision !== current.revision) return conflict(res, current, req.user);
      const value = nameValue(req.body?.name);
      if (db.prepare('SELECT 1 FROM projects WHERE name_key = ? AND id != ?').get(value.key, current.id)) {
        return sendError(res, 409, 'duplicate', '项目组名称已存在');
      }
      const result = db.prepare('UPDATE projects SET name = ?, name_key = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
        .run(value.name, value.key, new Date().toISOString(), current.id, revision);
      if (!result.changes) return conflict(res, getProject.get(current.id), req.user);
      const project = mapProject(getProject.get(current.id), req.user);
      broadcast('project.updated', { project });
      res.json({ project });
    });

    app.delete('/api/projects/:id', requireAdmin, (req, res) => {
      const current = getProject.get(req.params.id);
      if (!current || current.deleted_at) return sendError(res, 404, 'not_found', '项目组不存在或已删除');
      const revision = revisionValue(req.body?.revision);
      if (revision !== current.revision) return conflict(res, current, req.user);
      if (req.body?.confirmationName !== current.name) throw inputError('请输入完整项目组名称以确认删除');
      const now = new Date().toISOString();
      const result = db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL').run(now, now, current.id, revision);
      if (!result.changes) return conflict(res, getProject.get(current.id), req.user);
      const project = mapProject(getProject.get(current.id), req.user);
      broadcast('project.deleted', { project });
      res.json({ project });
    });

    app.post('/api/projects/:id/restore', requireAdmin, (req, res) => {
      const current = getProject.get(req.params.id);
      if (!current) return sendError(res, 404, 'not_found', '项目组不存在');
      const revision = revisionValue(req.body?.revision);
      if (revision !== current.revision) return conflict(res, current, req.user);
      if (!current.deleted_at) throw inputError('此项目组未被删除');
      const result = db.prepare('UPDATE projects SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL').run(new Date().toISOString(), current.id, revision);
      if (!result.changes) return conflict(res, getProject.get(current.id), req.user);
      const project = mapProject(getProject.get(current.id), req.user);
      broadcast('project.restored', { project });
      res.json({ project });
    });

    const iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 1, fieldSize: 100 } });
    app.post('/api/projects/:id/icon', requireAdmin, (req, res, next) => {
      iconUpload.single('file')(req, res, (error) => {
        if (error instanceof multer.MulterError) {
          return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'upload_error',
            error.code === 'LIMIT_FILE_SIZE' ? '项目图标不能超过 2 MB' : '项目图标上传失败');
        }
        if (error) return next(error);
        next();
      });
    }, async (req, res) => {
      const current = getProject.get(req.params.id);
      if (!current || current.deleted_at) return sendError(res, 404, 'not_found', '项目组不存在或已删除');
      const revision = revisionValue(typeof req.body?.revision === 'string' && /^[1-9]\d*$/.test(req.body.revision) ? Number(req.body.revision) : null);
      if (revision !== current.revision) return conflict(res, current, req.user);
      if (!req.file) throw inputError('请选择项目图标');
      let image;
      try {
        const source = sharp(req.file.buffer, { limitInputPixels: 16777216, failOn: 'warning', pages: 1 });
        const metadata = await source.metadata();
        if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error('Unsupported icon format');
        image = await source.rotate().resize(256, 256, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      } catch {
        return sendError(res, 400, 'invalid_image', '请选择有效的 PNG、JPG、WebP 或 GIF 图片，像素总数不超过 1600 万');
      }
      const freshUser = authenticate(req);
      if (!freshUser) return sendError(res, 401, 'unauthorized', '账号已更新，请重新登录');
      if (freshUser.role !== 'admin') return sendError(res, 403, 'forbidden', '仅管理员可操作');
      const filename = `${crypto.randomUUID()}.webp`;
      const finalPath = path.join(iconDir, filename);
      const temporaryPath = `${finalPath}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, image, { flag: 'wx' });
        fs.renameSync(temporaryPath, finalPath);
        const result = db.prepare('UPDATE projects SET icon_file = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
          .run(filename, new Date().toISOString(), current.id, revision);
        if (!result.changes) {
          fs.unlinkSync(finalPath);
          return conflict(res, getProject.get(current.id), req.user);
        }
      } catch (error) {
        for (const cleanup of [temporaryPath, finalPath]) {
          try { fs.unlinkSync(cleanup); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('Icon cleanup failed:', cleanupError); }
        }
        throw error;
      }
      if (current.icon_file) {
        try { fs.unlinkSync(path.join(iconDir, current.icon_file)); }
        catch (error) { if (error.code !== 'ENOENT') console.error('Old icon cleanup failed:', error); }
      }
      const project = mapProject(getProject.get(current.id), req.user);
      broadcast('project.updated', { project });
      res.json({ project });
    });

    app.get('/api/projects/:id/icon', requireView, (req, res, next) => {
      const project = getProject.get(req.params.id);
      if (!project?.icon_file || project.deleted_at) return sendError(res, 404, 'not_found', '项目图标不存在');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('image/webp');
      res.sendFile(path.join(iconDir, project.icon_file), (error) => { if (error && !res.headersSent) next(error); });
    });
  }

  return { requireProject, register, canView, mapProject, getProject };
}
