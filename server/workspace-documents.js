import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { extractDocument } from './ai-documents.js';
import { uploadFilename } from './upload-name.js';

const services = new WeakMap();
const STATUS = ['草稿', '已确认', '已归档'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const TEXT_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.md', '.markdown', '.txt']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain' };

class WorkspaceError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function text(value, label, max = 1000000, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new WorkspaceError(`${label}格式不正确或过长`);
  return value.trim();
}
function revision(value) { const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value; if (!Number.isSafeInteger(parsed) || parsed < 1) throw new WorkspaceError('请提供有效 revision'); return parsed; }
function conflict() { throw new WorkspaceError('内容已被其他人修改，请刷新后重试', 409); }
function now() { return new Date().toISOString(); }
function parsedMeta(row) { return JSON.parse(row.metadata || '{}'); }
function appendExtracted(body, groups) {
  let result = body;
  for (const row of groups.flatMap((group) => group.rows).filter((row) => !row.parentId && row.extractedText)) {
    if (!result.includes(row.extractedText)) result += (result ? `\n\n来源附件：${row.name}\n` : '') + row.extractedText;
  }
  return result;
}
function sourceAddress(value, fallback = '') {
  const address = text(value, '来源地址', 2000, fallback);
  if (!address) return '';
  let parsed;
  try { parsed = new URL(address); } catch { throw new WorkspaceError('来源地址须为有效 HTTP 或 HTTPS 链接'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new WorkspaceError('来源地址须为不含账号密码的 HTTP 或 HTTPS 链接');
  return address;
}

export function splitKnowledgeText(value, config = {}) {
  const chunkSize = config.chunkSize ?? 400;
  const chunkOverlap = config.chunkOverlap ?? 80;
  if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 4000 || !Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) throw new WorkspaceError('分块长度须为 100-4000，重叠须小于分块长度');
  const source = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const segments = [];
  if (config.chunkMode === 'heading') {
    let heading = ''; let lines = [];
    for (const line of source.split('\n')) {
      const match = line.match(/^#{1,6}\s+(.+)$/);
      if (match) { if (lines.join('\n').trim()) segments.push({ heading, text: lines.join('\n').trim() }); heading = match[1].trim(); lines = [line]; }
      else lines.push(line);
    }
    if (lines.join('\n').trim()) segments.push({ heading, text: lines.join('\n').trim() });
  } else segments.push({ heading: '', text: source });
  const chunks = [];
  for (const segment of segments) {
    for (let start = 0; start < segment.text.length; start += chunkSize - chunkOverlap) {
      chunks.push({ position: chunks.length, heading: segment.heading, content: segment.text.slice(start, start + chunkSize) });
      if (chunks.length > 10000) throw new WorkspaceError('单文档分块超过 10000，请增大分块长度或减少重叠');
      if (start + chunkSize >= segment.text.length) break;
    }
  }
  return chunks;
}

function chunkConfig(body, previous = {}) {
  const presets = { fine: { chunkMode: 'window', chunkSize: 250, chunkOverlap: 50 }, standard: { chunkMode: 'window', chunkSize: 400, chunkOverlap: 80 }, heading: { chunkMode: 'heading', chunkSize: 800, chunkOverlap: 100 } };
  if (body.preset !== undefined && !Object.hasOwn(presets, body.preset)) throw new WorkspaceError('分块预设不正确');
  const defaults = body.preset ? presets[body.preset] : { chunkMode: previous.chunk_mode || 'window', chunkSize: previous.chunk_size || 400, chunkOverlap: previous.chunk_overlap ?? 80 };
  const integer = (value) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const result = { chunkMode: body.chunkMode ?? defaults.chunkMode, chunkSize: integer(body.chunkSize ?? defaults.chunkSize), chunkOverlap: integer(body.chunkOverlap ?? defaults.chunkOverlap) };
  if (!['window', 'heading'].includes(result.chunkMode)) throw new WorkspaceError('分块方式不正确');
  splitKnowledgeText('', result);
  return result;
}

function queryTerms(query) {
  const terms = new Set();
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9_]{1,39}|[\u4e00-\u9fff]{2,}/g)) {
    terms.add(match[0]);
    if (/^[\u4e00-\u9fff]+$/.test(match[0])) for (let index = 0; index < match[0].length - 1; index++) terms.add(match[0].slice(index, index + 2));
    if (terms.size >= 60) break;
  }
  return [...terms].slice(0, 60);
}

export function initializeWorkspaceDocuments(db, dataDir) {
  if (services.has(db)) return services.get(db);
  const fileDir = path.resolve(dataDir, 'workspace-documents', 'files');
  fs.mkdirSync(fileDir, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL, analysis TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, priority TEXT NOT NULL, source_url TEXT NOT NULL, revision INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS requirements_project_idx ON requirements(project_id,deleted_at,updated_at);
  CREATE TABLE IF NOT EXISTS test_plans (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), requirement_id TEXT NOT NULL REFERENCES requirements(id),
    title TEXT NOT NULL, version TEXT NOT NULL, iteration TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS test_plans_project_idx ON test_plans(project_id,requirement_id,deleted_at);
  CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
    chunk_mode TEXT NOT NULL, chunk_size INTEGER NOT NULL, chunk_overlap INTEGER NOT NULL, index_version INTEGER NOT NULL,
    revision INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS knowledge_bases_project_idx ON knowledge_bases(project_id,deleted_at);
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
    title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL, source_url TEXT NOT NULL, revision INTEGER NOT NULL,
    index_version INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS knowledge_documents_base_idx ON knowledge_documents(knowledge_base_id,deleted_at);
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id), position INTEGER NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks(document_id,position);
  CREATE TABLE IF NOT EXISTS workspace_attachments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, parent_id TEXT,
    name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size INTEGER NOT NULL, extracted_text TEXT NOT NULL,
    metadata TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
  ); CREATE INDEX IF NOT EXISTS workspace_attachments_owner_idx ON workspace_attachments(owner_type,owner_id,deleted_at);`);
  for (const table of ['requirements', 'knowledge_documents']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of Object.entries({
      source_warnings: "TEXT NOT NULL DEFAULT '[]'", source_completeness: "TEXT NOT NULL DEFAULT 'unknown'",
      source_import_mode: "TEXT NOT NULL DEFAULT ''",
    })) if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  let dependencies = {};
  function project(value) {
    if (dependencies.requireProject) return dependencies.requireProject(value);
    if (typeof value !== 'string' || !value || !db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL').get(value)) throw new WorkspaceError('请先选择有效项目组');
    return value;
  }
  const reqRow = (projectId, id) => db.prepare('SELECT * FROM requirements WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(id, projectId);
  const kbRow = (projectId, id) => db.prepare('SELECT * FROM knowledge_bases WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(id, projectId);
  const docRow = (projectId, kbId, id) => db.prepare('SELECT * FROM knowledge_documents WHERE id = ? AND project_id = ? AND knowledge_base_id = ? AND deleted_at IS NULL').get(id, projectId, kbId);
  function need(row, label) { if (!row) throw new WorkspaceError(`${label}不存在或不属于当前项目组`, 404); return row; }
  function check(row, value) { if (row.revision !== revision(value)) conflict(); }
  function attachmentUrl(type, ownerId, attachmentId, kbId) { return type === 'requirement' ? `/api/requirements/${ownerId}/attachments/${attachmentId}/download` : `/api/knowledge-bases/${kbId}/documents/${ownerId}/attachments/${attachmentId}/download`; }
  function attachments(type, ownerId, projectId, kbId) {
    const rows = db.prepare('SELECT * FROM workspace_attachments WHERE owner_type = ? AND owner_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY created_at,id').all(type, ownerId, projectId);
    const map = (row) => {
      const metadata = parsedMeta(row);
      const downloadUrl = attachmentUrl(type, ownerId, row.id, kbId) + `?projectId=${encodeURIComponent(projectId)}`;
      return { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, extractedText: row.extracted_text, extractionError: metadata.extractionError || '', warnings: metadata.warnings || [], width: metadata.width, height: metadata.height, downloadUrl, previewUrl: metadata.image || row.mime_type === 'application/pdf' ? downloadUrl + '&inline=1' : null, imageCount: metadata.imageCount || 0, images: rows.filter((child) => child.parent_id === row.id).map((child) => ({ ...mapLeaf(child), sourceAttachmentId: row.id })) };
    };
    const mapLeaf = (row) => { const metadata = parsedMeta(row); const url = attachmentUrl(type, ownerId, row.id, kbId) + `?projectId=${encodeURIComponent(projectId)}`; return { id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, width: metadata.width, height: metadata.height, previewUrl: metadata.image ? url + '&inline=1' : null, downloadUrl: url, extractionError: metadata.extractionError || '', warnings: metadata.warnings || [] }; };
    return rows.filter((row) => !row.parent_id).map(map);
  }
  function mapRequirement(row) { return { id: row.id, projectId: row.project_id, title: row.title, body: row.body, analysis: row.analysis, status: row.status, priority: row.priority, sourceUrl: row.source_url, sourceWarnings: JSON.parse(row.source_warnings), sourceCompleteness: row.source_completeness, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, attachments: attachments('requirement', row.id, row.project_id) }; }
  function mapKb(row) { return { id: row.id, projectId: row.project_id, name: row.name, description: row.description, category: row.category, chunkMode: row.chunk_mode, chunkSize: row.chunk_size, chunkOverlap: row.chunk_overlap, indexVersion: row.index_version, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, documentCount: db.prepare('SELECT count(*) n FROM knowledge_documents WHERE knowledge_base_id = ? AND deleted_at IS NULL').get(row.id).n, chunkCount: db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE knowledge_base_id = ?').get(row.id).n, indexPending: db.prepare('SELECT count(*) n FROM knowledge_documents WHERE knowledge_base_id = ? AND deleted_at IS NULL AND index_version != ?').get(row.id, row.index_version).n }; }
  function mapDocument(row) { const kb = kbRow(row.project_id, row.knowledge_base_id); return { id: row.id, projectId: row.project_id, knowledgeBaseId: row.knowledge_base_id, title: row.title, body: row.body, category: row.category, sourceUrl: row.source_url, sourceWarnings: JSON.parse(row.source_warnings), sourceCompleteness: row.source_completeness, revision: row.revision, indexOutdated: !kb || row.index_version !== kb.index_version, chunkCount: db.prepare('SELECT count(*) n FROM knowledge_chunks WHERE document_id = ?').get(row.id).n, createdAt: row.created_at, updatedAt: row.updated_at, attachments: attachments('knowledge', row.id, row.project_id, row.knowledge_base_id) }; }
  function imageEvidence(type, id, projectId) {
    const rows = db.prepare('SELECT * FROM workspace_attachments WHERE owner_type = ? AND owner_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY created_at,id').all(type, id, projectId);
    return rows.flatMap((row) => { const meta = parsedMeta(row); return meta.visionFile ? [{ id: row.id, name: row.name, path: path.join(fileDir, meta.visionFile), mimeType: 'image/png', sourceAttachmentId: row.parent_id || row.id }] : []; });
  }
  function getRequirement(projectId, id) { project(projectId); const row = reqRow(projectId, id); return row ? mapRequirement(row) : null; }
  function getRequirementEvidence(projectId, id) {
    const requirement = getRequirement(projectId, id);
    if (!requirement) return null;
    if (requirement.attachments.some((attachment) => attachment.imageCount > 64)) throw new WorkspaceError('需求原件包含超过 64 个嵌入媒体，本轮 AI 不会截取部分图片分析，请拆分文档后重试；原件已完整保留。', 413);
    const sections = requirement.body ? [requirement.body] : [];
    const warnings = [];
    const source = reqRow(projectId, id);
    warnings.push(...requirement.sourceWarnings);
    if (source.source_import_mode !== 'browser' && /\.?(?:feishu\.cn|larksuite\.com)\//i.test(requirement.sourceUrl)) warnings.push('历史飞书来源仅通过文字接口读取；如原文含图片或页面布局，请另行补充图片附件。');
    for (const attachment of requirement.attachments) {
      if (!requirement.body && attachment.extractedText) sections.push(`来源附件：${attachment.name}\n${attachment.extractedText}`);
      warnings.push(...attachment.warnings, ...(attachment.extractionError ? [`${attachment.name}：${attachment.extractionError}`] : []));
      for (const image of attachment.images) if (image.extractionError) warnings.push(`${attachment.name}/${image.name}：${image.extractionError}`);
    }
    return { requirement, documents: sections.length ? [{ name: requirement.title, text: sections.join('\n\n') }] : [], images: imageEvidence('requirement', id, projectId), warnings };
  }
  function documentText(row) {
    if (row.body) return row.body;
    const rows = db.prepare('SELECT extracted_text FROM workspace_attachments WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL AND parent_id IS NULL').all('knowledge', row.id);
    return [row.body, ...rows.map((item) => item.extracted_text).filter((value) => value && !row.body.includes(value))].filter(Boolean).join('\n\n');
  }
  function indexDocument(row, kb) {
    const chunks = splitKnowledgeText(documentText(row), { chunkMode: kb.chunk_mode, chunkSize: kb.chunk_size, chunkOverlap: kb.chunk_overlap });
    db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(row.id);
    const insert = db.prepare('INSERT INTO knowledge_chunks (id,project_id,knowledge_base_id,document_id,position,heading,content) VALUES (?,?,?,?,?,?,?)');
    for (const chunk of chunks) insert.run(crypto.randomUUID(), row.project_id, kb.id, row.id, chunk.position, chunk.heading, chunk.content);
    db.prepare('UPDATE knowledge_documents SET index_version = ? WHERE id = ?').run(kb.index_version, row.id);
    return chunks.length;
  }
  function getKnowledgeContext(projectId, knowledgeBaseIds, query, { limit = 8, maxChars = 12000, includeImages = true } = {}) {
    project(projectId);
    if (!Array.isArray(knowledgeBaseIds) || knowledgeBaseIds.length > 20 || knowledgeBaseIds.some((id) => typeof id !== 'string' || !id || id.length > 100) || new Set(knowledgeBaseIds).size !== knowledgeBaseIds.length) throw new WorkspaceError('知识库选择不正确');
    const bases = knowledgeBaseIds.map((id) => need(kbRow(projectId, id), '知识库'));
    if (!bases.length) return { chunks: [], images: [], warnings: [], retrieval: 'local-keyword' };
    const terms = queryTerms(text(query, '检索问题', 12000));
    const ranked = [];
    const warnings = [];
    for (const kb of bases) {
      if (mapKb(kb).indexPending) warnings.push(`${kb.name} 的分块配置已更新，请重建索引后使用最新分块。`);
      for (const row of db.prepare(`SELECT c.*,d.title document_name FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.knowledge_base_id = ? AND c.project_id = ? AND d.deleted_at IS NULL ORDER BY c.document_id,c.position LIMIT 10000`).all(kb.id, projectId)) {
        const value = (row.heading + '\n' + row.content).toLowerCase();
        const score = terms.reduce((sum, term) => sum + (value.includes(term) ? Math.min(term.length, 12) : 0), 0);
        if (score) ranked.push({ id: row.id, knowledgeBaseId: kb.id, knowledgeBaseName: kb.name, documentId: row.document_id, documentName: row.document_name, heading: row.heading, position: row.position, locator: `分块 ${row.position + 1}`, content: row.content, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.position - b.position);
    const chunks = []; let count = 0;
    for (const row of ranked.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))) {
      const content = row.content.slice(0, Math.max(0, Math.min(30000, maxChars) - count));
      if (!content) break; chunks.push({ ...row, content }); count += content.length;
    }
    const images = [];
    for (const kb of bases) for (const doc of db.prepare('SELECT id,title,source_url,source_warnings,source_import_mode FROM knowledge_documents WHERE knowledge_base_id = ? AND deleted_at IS NULL ORDER BY created_at,id').all(kb.id)) {
      if (chunks.some((chunk) => chunk.documentId === doc.id) || !db.prepare('SELECT 1 FROM knowledge_chunks WHERE document_id = ?').get(doc.id)) {
        for (const attachment of attachments('knowledge', doc.id, projectId, kb.id)) {
          if (includeImages && attachment.imageCount > 64) throw new WorkspaceError('引用的知识文档包含超过 64 个嵌入媒体，AI 不会截取部分图片分析，请拆分原件或减少引用后重试。', 413);
          warnings.push(...attachment.warnings.map((warning) => `${doc.title}：${warning}`));
          if (attachment.extractionError) warnings.push(`${doc.title}/${attachment.name}：${attachment.extractionError}`);
          for (const image of attachment.images) if (image.extractionError) warnings.push(`${doc.title}/${image.name}：${image.extractionError}`);
        }
        if (includeImages) images.push(...imageEvidence('knowledge', doc.id, projectId));
        warnings.push(...JSON.parse(doc.source_warnings).map((warning) => `${doc.title}：${warning}`));
        if (doc.source_import_mode !== 'browser' && /\.?(?:feishu\.cn|larksuite\.com)\//i.test(doc.source_url)) warnings.push(`${doc.title} 历史来源仅同步飞书文字；如含图片请补充原图。`);
      }
    }
    if (!chunks.length) warnings.push('本地关键词检索未找到匹配文本，不可据此假定知识库不存在相关规则。');
    return { chunks, images, warnings, retrieval: 'local-keyword' };
  }
  const service = { db, dataDir, fileDir, project, reqRow, kbRow, docRow, need, check, attachments, mapRequirement, mapKb, mapDocument, indexDocument, getRequirement, getRequirementEvidence, getRequirementImages: (projectId, id) => getRequirementEvidence(projectId, id)?.images || [], getKnowledgeContext, retrieveKnowledge: (projectId, ids, query, options) => getKnowledgeContext(projectId, ids, query, options).chunks.map((chunk) => ({ ...chunk, title: chunk.documentName, text: chunk.content })), setDependencies: (value) => { dependencies = value; } };
  services.set(db, service);
  return service;
}

async function prepareFile(file, service, type, ownerId, projectId) {
  const filename = uploadFilename(file.originalname);
  const extension = path.extname(filename).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) throw new WorkspaceError('支持 PDF、Word、Markdown、TXT 及 PNG/JPG/WebP/GIF/BMP/TIFF 图片');
  const rows = [];
  const files = [file.path];
  const root = { id: crypto.randomUUID(), projectId, ownerType: type, ownerId, parentId: null, name: filename, storedName: path.basename(file.path), mimeType: MIME[extension] || 'application/octet-stream', size: file.size, extractedText: '', metadata: { warnings: [] }, createdAt: now() };
  rows.push(root);
  async function image(row, sourcePath) {
    try {
      const decoder = sharp(sourcePath, { limitInputPixels: 40000000, pages: 1 });
      const info = await decoder.metadata();
      if (!['png', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'].includes(info.format)) throw new Error('format');
      row.metadata.image = true; row.metadata.width = info.width; row.metadata.height = info.height;
      row.mimeType = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', tiff: 'image/tiff', bmp: 'image/bmp' }[info.format];
      const visionFile = crypto.randomUUID() + '.png';
      const visionPath = path.join(service.fileDir, visionFile); files.push(visionPath);
      await decoder.resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).png().toFile(visionPath);
      row.metadata.visionFile = visionFile;
      row.metadata.warnings.push('图片原件已保留，尚未自动提取文字；AI 分析须读取图片，或先补充正文。');
    } catch { row.mimeType = 'application/octet-stream'; row.metadata.extractionError = '图片无法解码或超出安全像素限制；原件已保留，请补正文或转换为 PNG/JPG 后重新上传。'; }
  }
  try {
    if (IMAGE_EXTENSIONS.has(extension)) await image(root, file.path);
    else {
      const buffer = await fsp.readFile(file.path);
      try { root.extractedText = await extractDocument({ originalname: filename, buffer }); }
      catch (error) { root.metadata.extractionError = error.message; }
      if (extension === '.docx') {
        try {
          let total = 0; let count = 0; let mediaCount = 0;
          const media = unzipSync(buffer, { filter(entry) {
            total += entry.originalSize;
            if (++count > 2000 || total > 64 * 1024 * 1024) throw new Error('archive');
            const selected = /^word\/media\/[^/]+$/i.test(entry.name);
            if (selected) mediaCount += 1;
            return selected && mediaCount <= 65;
          } });
          root.metadata.imageCount = mediaCount;
          if (mediaCount > 65) root.metadata.warnings.push('DOCX 超过 AI 单轮 64 张图片预算，只生成前 65 个媒体的预览；AI 分析会明确拒绝部分读取，请拆分文档。完整原件仍可下载。');
          for (const [entry, bytes] of Object.entries(media)) {
            const name = uploadFilename(path.posix.basename(entry)); const suffix = path.extname(name).toLowerCase();
            const storedName = crypto.randomUUID() + '.bin'; const target = path.join(service.fileDir, storedName); files.push(target);
            await fsp.writeFile(target, bytes, { flag: 'wx' });
            const embedded = { ...root, id: crypto.randomUUID(), parentId: root.id, name, storedName, size: bytes.byteLength, mimeType: MIME[suffix] || 'application/octet-stream', extractedText: '', metadata: { warnings: [] } };
            if (IMAGE_EXTENSIONS.has(suffix)) await image(embedded, target);
            else embedded.metadata.extractionError = '该嵌入媒体无法直接预览，请下载原件核对。';
            rows.push(embedded);
          }
          if (mediaCount) root.metadata.warnings.push(`DOCX 含 ${mediaCount} 个嵌入媒体；正文提取不包含图片内容，请同时核对图片。`);
        } catch { root.metadata.warnings.push('DOCX 嵌入媒体无法安全提取，原件已保留；请补充相关图片或正文，不可视为图片已被读取。'); }
      } else if (extension === '.doc') root.metadata.warnings.push('DOC 仅提取文字；如含嵌图，请另存为 DOCX 或单独上传图片。');
    }
    return { rows, files };
  } catch (error) { await Promise.all(files.map((filename) => fsp.unlink(filename).catch(() => {}))); throw error; }
}

export function registerWorkspaceDocumentRoutes(app, options) {
  const { db, dataDir, broadcast = () => {}, authenticate, browserService } = options;
  const service = initializeWorkspaceDocuments(db, dataDir); service.setDependencies(options);
  const { project, reqRow, kbRow, docRow, need, check, mapRequirement, mapKb, mapDocument, indexDocument } = service;
  const permission = (module, action) => options.requirePermission ? options.requirePermission(module, action) : (req, res, next) => req.user?.role === 'admin' || req.user?.permissions?.[module]?.[action] ? next() : res.status(403).json({ error: 'forbidden', message: '没有此模块的操作权限' });
  const wrap = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { if (!req.workspaceUploadsCommitted) await Promise.all((req.files || []).map((file) => fsp.unlink(file.path).catch(() => {}))); if (error instanceof WorkspaceError || Number.isInteger(error.status) && error.status >= 400 && error.status < 600) res.status(error.status || 400).json({ error: error.status === 409 ? 'conflict' : 'invalid_input', message: error.publicMessage || error.message }); else next(error); } };
  const route = (method, url, module, action, handler, upload = false) => app[method](url, permission(module, action), ...(upload ? [uploads] : []), wrap(handler));
  const upload = multer({ storage: multer.diskStorage({ destination: service.fileDir, filename: (req, file, done) => done(null, crypto.randomUUID() + '.bin') }), limits: { files: 24, fields: 16, fieldSize: 4 * 1024 * 1024 } });
  function uploads(req, res, next) { if (!req.is('multipart/form-data')) return next(); upload.array('file', 24)(req, res, (error) => error ? res.status(400).json({ error: 'upload_error', message: '文档上传失败，请检查文件数量和表单格式' }) : next()); }
  function fresh(req, module) { if (!authenticate) return; const user = authenticate(req); if (!user || user.id !== req.user.id) throw new WorkspaceError('登录已失效，请重新登录', 401); if (user.role !== 'admin' && !user.permissions?.[module]?.write) throw new WorkspaceError('权限已更新，没有写入权限', 403); }
  async function prepared(req, type, ownerId, projectId) {
    const groups = [];
    try { for (const file of req.files || []) groups.push(await prepareFile(file, service, type, ownerId, projectId)); return groups; }
    catch (error) { await Promise.all([...groups.flatMap((group) => group.files), ...(req.files || []).map((file) => file.path)].map((filename) => fsp.unlink(filename).catch(() => {}))); throw error; }
  }
  const saveAttachments = (groups) => { const insert = db.prepare('INSERT INTO workspace_attachments (id,project_id,owner_type,owner_id,parent_id,name,stored_name,mime_type,size,extracted_text,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'); for (const row of groups.flatMap((group) => group.rows)) insert.run(row.id, row.projectId, row.ownerType, row.ownerId, row.parentId, row.name, row.storedName, row.mimeType, row.size, row.extractedText, JSON.stringify(row.metadata), row.createdAt); };
  async function writeFiles(req, type, ownerId, projectId, module, operation) {
    const groups = await prepared(req, type, ownerId, projectId);
    try { fresh(req, module); project(projectId); const result = operation(groups); req.workspaceUploadsCommitted = true; return result; }
    catch (error) { await Promise.all(groups.flatMap((group) => group.files).map((filename) => fsp.unlink(filename).catch(() => {}))); throw error; }
  }
  async function sourceText(body, filesPresent, req, res) {
    let value = text(body.body, '正文'); const sourceUrl = sourceAddress(body.sourceUrl);
    let imported = null;
    if (!value && !filesPresent && sourceUrl) {
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnected);
      try {
        if (!browserService) throw new WorkspaceError('请管理员先连接服务器 Chrome 浏览器扩展，再导入飞书文档。', 503);
        imported = await browserService.read(sourceUrl, { requester: req.user, signal: controller.signal });
        value = imported.text;
      } catch (error) {
        if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) throw new WorkspaceError(error.message, error.status);
        if (error.name === 'AbortError') throw new WorkspaceError('飞书文档读取已取消。', 499);
        if (error.name === 'TimeoutError') throw new WorkspaceError('飞书来源读取超时，请稍后重试或下载原件后导入。', 504);
        throw new WorkspaceError('飞书来源暂时无法读取，请检查浏览器连接或下载原件后导入。', 502);
      } finally { res.off('close', disconnected); }
    }
    return { body: value, sourceUrl, imported };
  }
  async function attachImportedImages(req, imported) {
    if (!imported?.images?.length) return;
    const written = [];
    try {
      for (const image of imported.images) {
        const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[image.mimeType];
        if (!extension) throw new WorkspaceError('浏览器返回的图片格式不支持。');
        const name = uploadFilename(image.name, '飞书图片').replace(/\.[^.]+$/, '') + extension;
        const filePath = path.join(service.fileDir, crypto.randomUUID() + '.bin');
        await fsp.writeFile(filePath, image.buffer, { flag: 'wx' });
        written.push({ path: filePath, originalname: name, size: image.buffer.length });
      }
      req.files = [...(req.files || []), ...written];
    } catch (error) {
      await Promise.all(written.map((file) => fsp.unlink(file.path).catch(() => {})));
      throw error;
    }
  }
  function requirementValues(body, previous = {}) {
    const value = { title: text(body.title, '需求名称', 200, previous.title || ''), body: text(body.body, '正文', 1000000, previous.body || ''), analysis: text(body.analysis, '需求分析', 1000000, previous.analysis || ''), status: body.status ?? previous.status ?? '草稿', priority: body.priority ?? previous.priority ?? 'P2', sourceUrl: sourceAddress(body.sourceUrl, previous.source_url || '') };
    if (!value.title || !STATUS.includes(value.status) || !PRIORITIES.includes(value.priority)) throw new WorkspaceError('请填写需求名称并选择有效状态、优先级');
    return value;
  }
  const emit = (type, projectId, id) => broadcast(type, { projectId, id });

  route('get', '/api/requirements', 'requirements', 'view', (req, res) => { const projectId = project(req.query.projectId); const q = text(req.query.q, '搜索', 200).toLowerCase(); const status = text(req.query.status, '状态', 20); const rows = db.prepare('SELECT * FROM requirements WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(projectId); res.json({ requirements: rows.map(mapRequirement).filter((row) => (!status || row.status === status) && (!q || [row.title, row.body, row.analysis, ...row.attachments.map((attachment) => attachment.extractedText)].join('\n').toLowerCase().includes(q))) }); });
  route('get', '/api/requirements/:id', 'requirements', 'view', (req, res) => res.json({ requirement: mapRequirement(need(reqRow(project(req.query.projectId), req.params.id), '需求')) }));
  route('post', '/api/requirements', 'requirements', 'write', async (req, res) => {
    const projectId = project(req.body?.projectId); const id = crypto.randomUUID(); const source = await sourceText(req.body || {}, Boolean(req.files?.length), req, res); const value = requirementValues({ ...req.body, body: source.body, sourceUrl: source.sourceUrl, title: req.body?.title || source.imported?.name });
    if (!value.body && !req.files?.length && !source.imported?.images?.length) throw new WorkspaceError('正文或附件至少填写一项');
    fresh(req, 'requirements'); project(projectId);
    await attachImportedImages(req, source.imported);
    await writeFiles(req, 'requirement', id, projectId, 'requirements', (groups) => db.transaction(() => {
      const timestamp = now();
      db.prepare('INSERT INTO requirements (id,project_id,title,body,analysis,status,priority,source_url,source_warnings,source_completeness,source_import_mode,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)').run(id, projectId, value.title, appendExtracted(value.body, groups), value.analysis, value.status, value.priority, value.sourceUrl, JSON.stringify(source.imported?.warnings || []), source.imported?.completeness || 'unknown', source.imported ? 'browser' : '', req.user.id, timestamp, timestamp); saveAttachments(groups);
    })());
    emit('requirement.created', projectId, id); res.status(201).json({ requirement: mapRequirement(reqRow(projectId, id)) });
  }, true);
  route('put', '/api/requirements/:id', 'requirements', 'write', (req, res) => { const projectId = project(req.body?.projectId); const row = need(reqRow(projectId, req.params.id), '需求'); check(row, req.body.revision); const value = requirementValues(req.body, row); if (!value.body && !service.attachments('requirement', row.id, projectId).length) throw new WorkspaceError('正文或附件至少填写一项'); if (!db.prepare('UPDATE requirements SET title=?,body=?,analysis=?,status=?,priority=?,source_url=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(value.title, value.body, value.analysis, value.status, value.priority, value.sourceUrl, now(), row.id, row.revision).changes) conflict(); emit('requirement.updated', projectId, row.id); res.json({ requirement: mapRequirement(reqRow(projectId, row.id)) }); });
  route('delete', '/api/requirements/:id', 'requirements', 'write', (req, res) => { const projectId = project(req.body?.projectId); const row = need(reqRow(projectId, req.params.id), '需求'); check(row, req.body.revision); const timestamp = now(); db.transaction(() => { if (!db.prepare('UPDATE requirements SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(timestamp, timestamp, row.id, row.revision).changes) conflict(); if (db.prepare('PRAGMA table_info(cases)').all().some((column) => column.name === 'requirement_id')) db.prepare('UPDATE cases SET requirement_id=NULL WHERE requirement_id=?').run(row.id); })(); emit('requirement.deleted', projectId, row.id); res.json({ ok: true }); });
  route('post', '/api/requirements/:id/attachments', 'requirements', 'write', async (req, res) => { const projectId = project(req.body?.projectId); const row = need(reqRow(projectId, req.params.id), '需求'); check(row, req.body.revision); if (!req.files?.length) throw new WorkspaceError('请选择附件'); await writeFiles(req, 'requirement', row.id, projectId, 'requirements', (groups) => db.transaction(() => { if (!db.prepare('UPDATE requirements SET body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL').run(appendExtracted(row.body, groups), now(), row.id, row.revision).changes) conflict(); saveAttachments(groups); })()); emit('requirement.updated', projectId, row.id); res.json({ requirement: mapRequirement(reqRow(projectId, row.id)) }); }, true);

  function download(req, res, type) {
    const projectId = project(req.query.projectId); const owner = type === 'requirement' ? need(reqRow(projectId, req.params.id), '需求') : need(docRow(projectId, need(kbRow(projectId, req.params.kbId), '知识库').id, req.params.docId), '知识文档');
    const row = need(db.prepare('SELECT * FROM workspace_attachments WHERE id=? AND owner_id=? AND owner_type=? AND project_id=? AND deleted_at IS NULL').get(req.params.aid, owner.id, type, projectId), '附件');
    if (row.parent_id && !db.prepare('SELECT 1 FROM workspace_attachments WHERE id=? AND deleted_at IS NULL').get(row.parent_id)) throw new WorkspaceError('附件不存在', 404);
    res.set('X-Content-Type-Options', 'nosniff');
    const metadata = parsedMeta(row);
    if (req.query.inline === '1' && metadata.image && metadata.visionFile && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(row.mime_type)) { res.type('image/png'); res.sendFile(path.join(service.fileDir, metadata.visionFile)); }
    else if (req.query.inline === '1' && (metadata.image || row.mime_type === 'application/pdf')) { res.type(row.mime_type); res.sendFile(path.join(service.fileDir, row.stored_name)); }
    else res.download(path.join(service.fileDir, row.stored_name), row.name);
  }
  route('get', '/api/requirements/:id/attachments/:aid/download', 'requirements', 'view', (req, res) => download(req, res, 'requirement'));
  route('delete', '/api/requirements/:id/attachments/:aid', 'requirements', 'write', (req, res) => { const projectId = project(req.body?.projectId); const row = need(reqRow(projectId, req.params.id), '需求'); check(row, req.body.revision); const attachment = need(db.prepare('SELECT * FROM workspace_attachments WHERE id=? AND owner_type=? AND owner_id=? AND project_id=? AND parent_id IS NULL AND deleted_at IS NULL').get(req.params.aid, 'requirement', row.id, projectId), '附件'); if (!row.body && service.attachments('requirement', row.id, projectId).length < 2) throw new WorkspaceError('不能移除最后一份附件，请先补充正文'); db.transaction(() => { const timestamp = now(); if (!db.prepare('UPDATE requirements SET revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(timestamp, row.id, row.revision).changes) conflict(); db.prepare('UPDATE workspace_attachments SET deleted_at=? WHERE id=? OR parent_id=?').run(timestamp, attachment.id, attachment.id); })(); emit('requirement.updated', projectId, row.id); res.json({ requirement: mapRequirement(reqRow(projectId, row.id)) }); });

  const planRow = (projectId, id) => db.prepare('SELECT * FROM test_plans WHERE id=? AND project_id=? AND deleted_at IS NULL').get(id, projectId);
  const mapPlan = (row) => ({ id: row.id, projectId: row.project_id, requirementId: row.requirement_id, requirementTitle: db.prepare('SELECT title FROM requirements WHERE id=?').get(row.requirement_id)?.title || '', title: row.title, version: row.version, iteration: row.iteration, content: row.content, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
  route('get', '/api/test-plans', 'requirements', 'view', (req, res) => { const projectId = project(req.query.projectId); const requirementId = text(req.query.requirementId, '需求 ID', 100); res.json({ plans: db.prepare('SELECT * FROM test_plans WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(projectId).filter((row) => !requirementId || row.requirement_id === requirementId).map(mapPlan) }); });
  route('get', '/api/test-plans/:id', 'requirements', 'view', (req, res) => res.json({ plan: mapPlan(need(planRow(project(req.query.projectId), req.params.id), '测试计划')) }));
  for (const method of ['post', 'put']) route(method, '/api/test-plans' + (method === 'put' ? '/:id' : ''), 'requirements', 'write', (req, res) => { const projectId = project(req.body?.projectId); const previous = method === 'put' ? need(planRow(projectId, req.params.id), '测试计划') : {}; if (method === 'put') check(previous, req.body.revision); const requirementId = text(req.body.requirementId, '需求 ID', 100, previous.requirement_id || ''); if (requirementId !== previous.requirement_id || method === 'post') need(reqRow(projectId, requirementId), '关联需求'); const title = text(req.body.title, '计划名称', 200, previous.title || ''); if (!title) throw new WorkspaceError('请输入测试计划名称'); const version = text(req.body.version, '版本', 100, previous.version || ''); const iteration = text(req.body.iteration, '迭代', 100, previous.iteration || ''); const content = text(req.body.content, '测试计划', 1000000, previous.content || ''); const id = previous.id || crypto.randomUUID(); const timestamp = now(); if (method === 'post') db.prepare('INSERT INTO test_plans (id,project_id,requirement_id,title,version,iteration,content,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)').run(id, projectId, requirementId, title, version, iteration, content, req.user.id, timestamp, timestamp); else if (!db.prepare('UPDATE test_plans SET requirement_id=?,title=?,version=?,iteration=?,content=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(requirementId, title, version, iteration, content, timestamp, id, previous.revision).changes) conflict(); emit('plan.updated', projectId, id); res.status(method === 'post' ? 201 : 200).json({ plan: mapPlan(planRow(projectId, id)) }); });
  route('delete', '/api/test-plans/:id', 'requirements', 'write', (req, res) => { const projectId = project(req.body?.projectId); const row = need(planRow(projectId, req.params.id), '测试计划'); check(row, req.body.revision); if (!db.prepare('UPDATE test_plans SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(now(), now(), row.id, row.revision).changes) conflict(); emit('plan.deleted', projectId, row.id); res.json({ ok: true }); });

  route('get', '/api/knowledge-bases', 'knowledge', 'view', (req, res) => { const projectId = project(req.query.projectId); const query = text(req.query.q, '搜索', 200).toLowerCase(); res.json({ knowledgeBases: db.prepare('SELECT * FROM knowledge_bases WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(projectId).filter((row) => !query || [row.name, row.description, row.category].join(' ').toLowerCase().includes(query)).map(mapKb) }); });
  route('get', '/api/knowledge-bases/:kbId', 'knowledge', 'view', (req, res) => res.json({ knowledgeBase: mapKb(need(kbRow(project(req.query.projectId), req.params.kbId), '知识库')) }));
  for (const method of ['post', 'put']) route(method, '/api/knowledge-bases' + (method === 'put' ? '/:kbId' : ''), 'knowledge', 'write', (req, res) => { const projectId = project(req.body?.projectId); const previous = method === 'put' ? need(kbRow(projectId, req.params.kbId), '知识库') : {}; if (method === 'put') check(previous, req.body.revision); const name = text(req.body.name, '知识库名称', 200, previous.name || ''); if (!name) throw new WorkspaceError('请输入知识库名称'); const description = text(req.body.description, '知识库描述', 20000, previous.description || ''); const category = text(req.body.category, '分类', 100, previous.category || ''); const config = chunkConfig(req.body, previous); const id = previous.id || crypto.randomUUID(); const timestamp = now(); if (method === 'post') db.prepare('INSERT INTO knowledge_bases (id,project_id,name,description,category,chunk_mode,chunk_size,chunk_overlap,index_version,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,?,?,?)').run(id, projectId, name, description, category, config.chunkMode, config.chunkSize, config.chunkOverlap, req.user.id, timestamp, timestamp); else { const changed = config.chunkMode !== previous.chunk_mode || config.chunkSize !== previous.chunk_size || config.chunkOverlap !== previous.chunk_overlap; if (!db.prepare('UPDATE knowledge_bases SET name=?,description=?,category=?,chunk_mode=?,chunk_size=?,chunk_overlap=?,index_version=index_version+?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(name, description, category, config.chunkMode, config.chunkSize, config.chunkOverlap, changed ? 1 : 0, timestamp, id, previous.revision).changes) conflict(); } emit('knowledge.updated', projectId, id); res.status(method === 'post' ? 201 : 200).json({ knowledgeBase: mapKb(kbRow(projectId, id)) }); });
  route('delete', '/api/knowledge-bases/:kbId', 'knowledge', 'write', (req, res) => { const projectId = project(req.body?.projectId); const row = need(kbRow(projectId, req.params.kbId), '知识库'); check(row, req.body.revision); db.transaction(() => { if (!db.prepare('UPDATE knowledge_bases SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(now(), now(), row.id, row.revision).changes) conflict(); db.prepare('DELETE FROM knowledge_chunks WHERE knowledge_base_id=?').run(row.id); })(); emit('knowledge.deleted', projectId, row.id); res.json({ ok: true }); });
  route('get', '/api/knowledge-bases/:kbId/documents', 'knowledge', 'view', (req, res) => { const projectId = project(req.query.projectId); const kb = need(kbRow(projectId, req.params.kbId), '知识库'); const query = text(req.query.q, '搜索', 200).toLowerCase(); const category = text(req.query.category, '分类', 100); res.json({ documents: db.prepare('SELECT * FROM knowledge_documents WHERE knowledge_base_id=? AND project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(kb.id, projectId).filter((row) => (!category || row.category === category) && (!query || [row.title, row.body, row.category].join(' ').toLowerCase().includes(query))).map(mapDocument) }); });
  route('post', '/api/knowledge-bases/:kbId/documents', 'knowledge', 'write', async (req, res) => {
    const projectId = project(req.body?.projectId);
    const kb = need(kbRow(projectId, req.params.kbId), '知识库');
    const id = crypto.randomUUID();
    const source = await sourceText(req.body || {}, Boolean(req.files?.length), req, res);
    const title = text(req.body.title, '文档名称', 200, req.files?.[0] ? uploadFilename(req.files[0].originalname) : source.imported?.name || '');
    const category = text(req.body.category, '分类', 100);
    if (!title) throw new WorkspaceError('请输入文档名称');
    if (!source.body && !req.files?.length && !source.imported?.images?.length) throw new WorkspaceError('正文或附件至少填写一项');
    fresh(req, 'knowledge'); project(projectId);
    await attachImportedImages(req, source.imported);
    await writeFiles(req, 'knowledge', id, projectId, 'knowledge', (groups) => db.transaction(() => {
      const currentKb = need(kbRow(projectId, kb.id), '知识库');
      const timestamp = now();
      db.prepare('INSERT INTO knowledge_documents (id,project_id,knowledge_base_id,title,body,category,source_url,source_warnings,source_completeness,source_import_mode,revision,index_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?,?,?)').run(id, projectId, kb.id, title, appendExtracted(source.body, groups), category, source.sourceUrl, JSON.stringify(source.imported?.warnings || []), source.imported?.completeness || 'unknown', source.imported ? 'browser' : '', req.user.id, timestamp, timestamp);
      saveAttachments(groups);
      indexDocument(docRow(projectId, kb.id, id), currentKb);
    })());
    emit('knowledge.updated', projectId, kb.id);
    res.status(201).json({ document: mapDocument(docRow(projectId, kb.id, id)) });
  }, true);
  route('get', '/api/knowledge-bases/:kbId/documents/:docId', 'knowledge', 'view', (req, res) => { const projectId = project(req.query.projectId); need(kbRow(projectId, req.params.kbId), '知识库'); res.json({ document: mapDocument(need(docRow(projectId, req.params.kbId, req.params.docId), '知识文档')) }); });
  route('put', '/api/knowledge-bases/:kbId/documents/:docId', 'knowledge', 'write', (req, res) => {
    const projectId = project(req.body?.projectId);
    const kb = need(kbRow(projectId, req.params.kbId), '知识库');
    const row = need(docRow(projectId, kb.id, req.params.docId), '知识文档');
    check(row, req.body.revision);
    const title = text(req.body.title, '文档名称', 200, row.title);
    const body = text(req.body.body, '正文', 1000000, row.body);
    const category = text(req.body.category, '分类', 100, row.category);
    const sourceUrl = sourceAddress(req.body.sourceUrl, row.source_url);
    if (!title || !body && !service.attachments('knowledge', row.id, projectId, kb.id).length) throw new WorkspaceError('请填写文档名称，正文或附件至少一项');
    db.transaction(() => {
      if (!db.prepare('UPDATE knowledge_documents SET title=?,body=?,category=?,source_url=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(title, body, category, sourceUrl, now(), row.id, row.revision).changes) conflict();
      indexDocument(docRow(projectId, kb.id, row.id), kb);
    })();
    emit('knowledge.updated', projectId, kb.id);
    res.json({ document: mapDocument(docRow(projectId, kb.id, row.id)) });
  });
  route('delete', '/api/knowledge-bases/:kbId/documents/:docId', 'knowledge', 'write', (req, res) => { const projectId = project(req.body?.projectId); const kb = need(kbRow(projectId, req.params.kbId), '知识库'); const row = need(docRow(projectId, kb.id, req.params.docId), '知识文档'); check(row, req.body.revision); db.transaction(() => { if (!db.prepare('UPDATE knowledge_documents SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(now(), now(), row.id, row.revision).changes) conflict(); db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(row.id); })(); emit('knowledge.updated', projectId, kb.id); res.json({ ok: true }); });
  route('get', '/api/knowledge-bases/:kbId/documents/:docId/attachments/:aid/download', 'knowledge', 'view', (req, res) => download(req, res, 'knowledge'));
  route('get', '/api/knowledge-bases/:kbId/documents/:docId/chunks', 'knowledge', 'view', (req, res) => { const projectId = project(req.query.projectId); const kb = need(kbRow(projectId, req.params.kbId), '知识库'); const row = need(docRow(projectId, kb.id, req.params.docId), '知识文档'); res.json({ chunks: db.prepare('SELECT id,position,heading,content FROM knowledge_chunks WHERE document_id=? ORDER BY position').all(row.id), indexOutdated: row.index_version !== kb.index_version }); });
  route('post', '/api/knowledge-bases/:kbId/reindex', 'knowledge', 'write', (req, res) => { const projectId = project(req.body?.projectId); const kb = need(kbRow(projectId, req.params.kbId), '知识库'); check(kb, req.body.revision); let count = 0; const docs = db.prepare('SELECT * FROM knowledge_documents WHERE knowledge_base_id=? AND deleted_at IS NULL').all(kb.id); db.transaction(() => { for (const row of docs) count += indexDocument(row, kb); if (!db.prepare('UPDATE knowledge_bases SET revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(now(), kb.id, kb.revision).changes) conflict(); })(); emit('knowledge.updated', projectId, kb.id); res.json({ knowledgeBase: mapKb(kbRow(projectId, kb.id)), indexedDocuments: docs.length, indexedChunks: count }); });
  route('post', '/api/knowledge-bases/:kbId/documents/:docId/reindex', 'knowledge', 'write', (req, res) => { const projectId = project(req.body?.projectId); const kb = need(kbRow(projectId, req.params.kbId), '知识库'); const row = need(docRow(projectId, kb.id, req.params.docId), '知识文档'); check(row, req.body.revision); const count = db.transaction(() => indexDocument(row, kb))(); emit('knowledge.updated', projectId, kb.id); res.json({ document: mapDocument(docRow(projectId, kb.id, row.id)), indexedChunks: count }); });
  route('post', '/api/knowledge-bases/:kbId/search', 'knowledge', 'view', (req, res) => { const projectId = project(req.body?.projectId); if (!text(req.body?.query, '检索问题', 12000)) throw new WorkspaceError('请输入试检索问题'); const { images, ...result } = service.getKnowledgeContext(projectId, [req.params.kbId], req.body.query, { limit: req.body.limit, includeImages: false }); res.json({ ...result, imageCount: images.length }); });
  return service;
}
