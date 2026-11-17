export const CASE_NODE_STATUSES = Object.freeze(['待测试', '测试通过', '跳过']);
const NODE_ID = /^[A-Za-z0-9_-]{1,100}$/;

class ExecutionError extends Error {
  constructor(message, status = 400, code = 'invalid_input', details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function treeIds(tree) {
  let value;
  try { value = typeof tree === 'string' ? JSON.parse(tree) : tree; } catch { throw new ExecutionError('用例导图数据无法读取，请刷新或联系管理员。', 503, 'invalid_tree'); }
  const ids = new Set(); const stack = [{ node: value, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !NODE_ID.test(node.id) || !Array.isArray(node.children) || ids.has(node.id) || depth > 64 || ids.size >= 5000) throw new ExecutionError('用例导图数据无法读取，请刷新或联系管理员。', 503, 'invalid_tree');
    ids.add(node.id);
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return ids;
}

export function initializeCaseExecutions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS case_node_statuses (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('待测试','测试通过','跳过')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (case_id, node_id)
  )`);
}

export function registerCaseExecutionRoutes(app, { db, projects, requirePermission, broadcast = () => {}, sendError } = {}) {
  initializeCaseExecutions(db);
  const getCase = db.prepare('SELECT id, project_id, tree, revision FROM cases WHERE id=?');
  const select = `SELECT case_node_statuses.*, users.username AS updater_name FROM case_node_statuses LEFT JOIN users ON users.id=case_node_statuses.updated_by`;
  const getStatus = db.prepare(`${select} WHERE case_id=? AND node_id=?`);
  const getAll = db.prepare(`${select} WHERE case_id=? ORDER BY updated_at, node_id`);
  const insert = db.prepare('INSERT INTO case_node_statuses(case_id,node_id,status,revision,updated_by,updated_at) VALUES(?,?,?,1,?,?)');
  const update = db.prepare('UPDATE case_node_statuses SET status=?,revision=revision+1,updated_by=?,updated_at=? WHERE case_id=? AND node_id=? AND revision=?');
  const remove = db.prepare('DELETE FROM case_node_statuses WHERE case_id=? AND node_id=?');
  const mapped = (row) => ({ nodeId: row.node_id, status: row.status, revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updater_name || '已删除账号' });
  const context = (row) => ({ caseId: row.id, projectId: row.project_id, caseRevision: row.revision });
  function errorResponse(res, error) {
    if (error.details) return res.status(error.status).json({ error: error.code, message: error.message, ...error.details });
    return sendError ? sendError(res, error.status, error.code, error.message) : res.status(error.status).json({ error: error.code, message: error.message });
  }
  const authenticated = (req, res, next) => req.user?.id ? next() : errorResponse(res, new ExecutionError('请先登录。', 401, 'unauthorized'));
  const permission = (action) => requirePermission ? requirePermission('cases', action) : (req, res, next) => req.user?.role === 'admin' || req.user?.permissions?.cases?.[action] ? next() : errorResponse(res, new ExecutionError('没有用例库的操作权限。', 403, 'forbidden'));
  const route = (handler) => (req, res, next) => { try { handler(req, res); } catch (error) { if (error instanceof ExecutionError) errorResponse(res, error); else next(error); } };
  function loadCase(caseId, projectId) {
    try { projects.requireProject(projectId); } catch { throw new ExecutionError('项目组不存在或已删除，请重新选择。'); }
    if (typeof caseId !== 'string' || !caseId || caseId.length > 100) throw new ExecutionError('用例集不存在。', 404, 'not_found');
    const row = getCase.get(caseId);
    if (!row || row.project_id !== projectId) throw new ExecutionError('用例集不存在于当前项目组。', 404, 'not_found');
    return { row, ids: treeIds(row.tree) };
  }
  const list = db.transaction((caseId, projectId) => {
    const { row, ids } = loadCase(caseId, projectId);
    return { ...context(row), statuses: getAll.all(row.id).filter((status) => ids.has(status.node_id)).map(mapped) };
  });
  app.get('/api/cases/:id/node-statuses', authenticated, permission('view'), route((req, res) => {
    res.set('Cache-Control', 'no-store'); res.json(list(req.params.id, req.query.projectId));
  }));
  const write = db.transaction((req) => {
    const { row, ids } = loadCase(req.params.id, req.body?.projectId);
    const nodeId = req.params.nodeId;
    if (!NODE_ID.test(nodeId) || !ids.has(nodeId)) throw new ExecutionError('此导图节点不存在或已被删除，请刷新用例集。', 404, 'not_found');
    const status = req.body?.status;
    if (!CASE_NODE_STATUSES.includes(status)) throw new ExecutionError('节点状态只能为待测试、测试通过或跳过。');
    const revision = req.body?.revision;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new ExecutionError('节点 revision 格式不正确。');
    const current = getStatus.get(row.id, nodeId);
    if (revision !== undefined && revision !== (current?.revision || 0)) throw new ExecutionError('此节点状态已被其他人修改，请刷新后重试。', 409, 'conflict', { ...context(row), nodeStatus: current ? mapped(current) : { nodeId, status: '待测试', revision: 0, updatedAt: null, updatedBy: null } });
    if (current?.status === status) return { result: { ...context(row), nodeStatus: mapped(current) }, changed: false };
    const now = new Date().toISOString();
    if (current) {
      if (!update.run(status, req.user.id, now, row.id, nodeId, current.revision).changes) throw new ExecutionError('此节点状态已被其他人修改，请刷新后重试。', 409, 'conflict');
    } else insert.run(row.id, nodeId, status, req.user.id, now);
    return { result: { ...context(row), nodeStatus: mapped(getStatus.get(row.id, nodeId)) }, changed: true };
  });
  app.put('/api/cases/:id/node-statuses/:nodeId', authenticated, permission('view'), permission('write'), route((req, res) => {
    const { result, changed } = write.immediate(req);
    if (changed) broadcast('case.node-status-updated', { projectId: result.projectId, caseId: result.caseId, nodeStatus: result.nodeStatus });
    res.json(result);
  }));
  const prune = db.transaction((caseId, tree) => {
    const ids = treeIds(tree); let deleted = 0;
    for (const row of getAll.all(caseId)) if (!ids.has(row.node_id)) deleted += remove.run(caseId, row.node_id).changes;
    return { deleted };
  });
  return { getStatuses: list, prune };
}
