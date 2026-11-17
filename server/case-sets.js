import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { uploadFilename } from './upload-name.js';
import { blankTree, legacyTree, normalizeTree, importMarkdown, importXmind, exportMarkdown, exportMarkdownZip, exportXmind, safeFilename, FORMAT_LIMITS, assertTransferSize } from './mindmap-formats.js';

export function initializeCaseSets(db) {
  db.transaction(() => {
    if (!db.prepare('PRAGMA table_info(cases)').all().some((column) => column.name === 'tree')) db.exec('ALTER TABLE cases ADD COLUMN tree TEXT');
    const update = db.prepare('UPDATE cases SET tree = ? WHERE id = ?');
    for (const row of db.prepare('SELECT * FROM cases WHERE tree IS NULL').all()) update.run(JSON.stringify(legacyTree(row)), row.id);
  })();
}

export function caseTree(source, previous, normalized, inputError) {
  try {
    if (source.tree !== undefined) return normalizeTree(source.tree);
    if (previous.tree) {
      const tree = structuredClone(previous.tree);
      if (source.title !== undefined && tree.title === previous.title) tree.title = normalized.title;
      return tree;
    }
    return ['module', 'preconditions', 'steps', 'expected', 'notes'].some((key) => normalized[key]) || normalized.tags.length ? legacyTree(normalized) : blankTree(normalized.title);
  } catch (error) { throw inputError(error.message); }
}

export function registerCaseSetRoutes(app, { db, projects, sendError, inputError, readRevision, mapCase, mapDefect, getCase, getDefect, broadcast }) {
  function selected(body) {
    const projectId = projects.requireProject(body?.projectId);
    if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 1000) throw inputError('请选择 1-1000 条记录');
    const ids = new Set();
    const items = body.items.map((item) => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)) throw inputError('所选记录 ID 无效或重复');
      ids.add(item.id);
      return { id: item.id, revision: readRevision(item.revision) };
    });
    return { projectId, items };
  }
  function currentItems(req, res, table, selection, limitExport = false) {
    const get = table === 'cases' ? getCase : getDefect;
    const rows = [];
    let treeSize = 0;
    for (const item of selection.items) {
      const row = get.get(item.id);
      if (!row || row.project_id !== selection.projectId) { sendError(res, 404, 'not_found', '所选记录不存在于当前项目组'); return null; }
      if (row.revision !== item.revision) { sendError(res, 409, 'conflict', '所选记录已被其他人修改，请刷新后重试'); return null; }
      if (limitExport && (treeSize += Buffer.byteLength(row.tree, 'utf8')) > FORMAT_LIMITS.contentBytes) { sendError(res, 413, 'too_large', '导出内容超过 8 MB，请分批导出'); return null; }
      rows.push(row);
    }
    return rows;
  }
  for (const table of ['cases', 'defects']) {
    app.post(`/api/${table}/batch`, (req, res) => {
      const selection = selected(req.body);
      const action = req.body.action;
      if (action !== 'delete' && !(table === 'defects' && action === 'status')) throw inputError('批量操作不正确');
      if (action === 'status' && !['待处理', '处理中', '待验证', '已解决', '已关闭', '搁置'].includes(req.body.status)) throw inputError('缺陷状态不正确');
      const rows = currentItems(req, res, table, selection);
      if (!rows) return;
      const now = new Date().toISOString();
      try {
        db.transaction(() => {
          for (const row of rows) {
            const result = action === 'delete'
              ? db.prepare(`DELETE FROM ${table} WHERE id = ? AND revision = ?`).run(row.id, row.revision)
              : db.prepare('UPDATE defects SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(req.body.status, now, row.id, row.revision);
            if (!result.changes) throw new Error('conflict');
          }
        })();
      } catch (error) {
        if (error.message === 'conflict') return sendError(res, 409, 'conflict', '所选记录已被其他人修改，请刷新后重试');
        throw error;
      }
      const category = table === 'cases' ? 'case' : 'defect';
      for (const row of rows) {
        if (action === 'delete') broadcast(`${category}.deleted`, { id: row.id, projectId: selection.projectId });
        else broadcast('defect.updated', { defect: mapDefect(getDefect.get(row.id)), projectId: selection.projectId });
      }
      res.json({ ok: true, count: rows.length });
    });
  }

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, fieldSize: 100 } });
  app.post('/api/cases/import', (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (error instanceof multer.MulterError) return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'upload_error', error.code === 'LIMIT_FILE_SIZE' ? '用例集文件不能超过 10 MB' : '用例集上传格式不正确');
      if (error) return next(error);
      next();
    });
  }, (req, res) => {
    const projectId = projects.requireProject(req.body?.projectId);
    if (!req.file) throw inputError('请选择 Markdown 或 XMind 文件');
    const requirementId = req.body?.requirementId || null;
    const hasRequirementColumn = db.prepare('PRAGMA table_info(cases)').all().some((column) => column.name === 'requirement_id');
    if (requirementId) {
      if (req.user.role !== 'admin' && !req.user.permissions?.requirements?.view) return sendError(res, 403, 'forbidden', '没有关联需求的查看权限');
      if (typeof requirementId !== 'string' || requirementId.length > 100 || !hasRequirementColumn || !db.prepare('SELECT 1 FROM requirements WHERE id=? AND project_id=? AND deleted_at IS NULL').get(requirementId, projectId)) throw inputError('关联需求不存在或不属于当前项目');
    }
    const filename = uploadFilename(req.file.originalname, '导入用例集.md');
    const originalExtension = path.extname(filename);
    const extension = originalExtension.toLowerCase();
    let sets;
    try {
      if (extension === '.md' || extension === '.markdown') sets = importMarkdown(req.file.buffer.toString('utf8'), filename.slice(0, -originalExtension.length));
      else if (extension === '.xmind') sets = importXmind(req.file.buffer);
      else throw new Error('仅支持 .md、.markdown 或 .xmind 文件');
      assertTransferSize(sets);
    } catch (error) {
      if (error.status === 413) return sendError(res, 413, 'too_large', `导入失败：${error.message}`);
      throw inputError(`导入失败：${error.message}`);
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO cases (id, title, module, priority, status, preconditions, steps, expected, notes, tags,
      revision, created_by, created_at, updated_at, project_id, tree${hasRequirementColumn ? ', requirement_id' : ''}) VALUES (?, ?, '', 'P2', '未执行', '', '', '', '', '[]', 1, ?, ?, ?, ?, ?${hasRequirementColumn ? ', ?' : ''})`);
    const ids = db.transaction(() => sets.map((set) => {
      const id = crypto.randomUUID();
      insert.run(id, set.title, req.user.id, now, now, projectId, JSON.stringify(set.tree), ...(hasRequirementColumn ? [requirementId] : []));
      return id;
    }))();
    const cases = ids.map((id) => mapCase(getCase.get(id)));
    for (const record of cases) broadcast('case.created', { case: record, projectId });
    res.status(201).json({ cases });
  });

  app.post('/api/cases/export', (req, res) => {
    const selection = selected(req.body);
    if (!['md', 'xmind'].includes(req.body.format)) throw inputError('导出格式须为 md 或 xmind');
    const rows = currentItems(req, res, 'cases', selection, true);
    if (!rows) return;
    const sets = rows.map(mapCase);
    let data;
    let extension;
    let mime;
    try {
      if (req.body.format === 'xmind') { data = Buffer.from(exportXmind(sets)); extension = 'xmind'; mime = 'application/vnd.xmind.workbook'; }
      else if (sets.length === 1) { data = Buffer.from(exportMarkdown(sets[0].tree), 'utf8'); extension = 'md'; mime = 'text/markdown; charset=utf-8'; }
      else { data = Buffer.from(exportMarkdownZip(sets)); extension = 'zip'; mime = 'application/zip'; }
    } catch (error) {
      if (error.status === 413) return sendError(res, 413, 'too_large', error.message);
      throw inputError(error.message);
    }
    const filename = `${sets.length === 1 ? safeFilename(sets[0].title) : '用例集导出'}.${extension}`;
    res.set('Content-Type', mime);
    res.set('Content-Disposition', `attachment; filename="case-sets.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(data);
  });
}
