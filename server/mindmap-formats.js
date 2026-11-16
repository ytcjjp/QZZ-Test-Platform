import crypto from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const markdown = new MarkdownIt({ html: false, linkify: false, maxNesting: 256 });
export const TREE_LIMITS = { nodes: 5000, depth: 64, text: 500000, topic: 30000 };
export const FORMAT_LIMITS = { contentBytes: 8 * 1024 * 1024, markdownChars: 2 * 1024 * 1024, sheets: 100 };
export const blankTree = (title) => ({ id: crypto.randomUUID(), title, children: [] });

function transferLimit(message) { const error = new Error(message); error.status = 413; return error; }

export function assertTransferSize(sets, reimportIds = false) {
  let bytes = 0;
  for (const set of sets) {
    // Imports assign UUIDs, so short external IDs must not hide the reimport size.
    const json = JSON.stringify(set.tree, reimportIds ? (key, value) => key === 'id' ? '00000000-0000-0000-0000-000000000000' : value : undefined);
    bytes += Buffer.byteLength(json, 'utf8');
    if (bytes > FORMAT_LIMITS.contentBytes) throw transferLimit('思维导图总量超过 8 MB，请分批导入或导出');
  }
}

export function normalizeTree(value) {
  let count = 0;
  let text = 0;
  const ids = new Set();
  function visit(node, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > TREE_LIMITS.depth || ++count > TREE_LIMITS.nodes) throw new Error('思维导图过大或层级过深');
    if (typeof node.title !== 'string' || node.title.length > TREE_LIMITS.topic || /\u0000/.test(node.title)) throw new Error('思维导图节点内容不正确');
    text += node.title.length;
    if (text > TREE_LIMITS.text) throw new Error('思维导图文字总量超过限制');
    const id = node.id === undefined ? crypto.randomUUID() : node.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new Error('思维导图节点 ID 重复或格式不正确');
    ids.add(id);
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('思维导图子节点格式不正确');
    return { id, title: node.title, children: (node.children || []).map((child) => visit(child, depth + 1)) };
  }
  return visit(value, 0);
}

export function legacyTree(record) {
  const tree = blankTree(record.title);
  for (const [key, label] of [['module', '所属模块'], ['priority', '优先级'], ['status', '执行状态'], ['preconditions', '前置条件'], ['steps', '执行步骤'], ['expected', '预期结果'], ['notes', '备注']]) {
    if (record[key]) tree.children.push(blankTree(`${label}：${record[key]}`));
  }
  const tags = typeof record.tags === 'string' ? JSON.parse(record.tags) : record.tags;
  if (tags?.length) tree.children.push(blankTree(`标签：${tags.join('、')}`));
  return tree;
}

function plainInline(token) {
  if (!token.children) return token.content;
  return token.children.map((part) => ['softbreak', 'hardbreak'].includes(part.type) ? '\n' : ['text', 'code_inline', 'image'].includes(part.type) ? part.content : '').join('');
}

export function importMarkdown(source, fallback = '导入用例集') {
  if (typeof source !== 'string' || !source.trim() || source.length > FORMAT_LIMITS.markdownChars) throw new Error('Markdown 内容为空或超过 2 MB');
  const tokens = markdown.parse(source.replace(/^\uFEFF/, ''), {});
  const sets = [];
  let root = blankTree(fallback);
  let headings = [{ level: 0, node: root }];
  const lists = [];
  let item = null;
  let headingLevel = null;
  let hasContent = false;
  function finish() {
    if (hasContent) sets.push({ title: root.title.slice(0, 200) || fallback, tree: normalizeTree(root) });
  }
  for (const token of tokens) {
    if (token.type === 'heading_open') headingLevel = Number(token.tag.slice(1));
    else if (token.type === 'heading_close') headingLevel = null;
    else if (['bullet_list_open', 'ordered_list_open'].includes(token.type)) { lists.push({ parent: item || headings.at(-1).node, previous: item }); item = null; }
    else if (['bullet_list_close', 'ordered_list_close'].includes(token.type)) item = lists.pop()?.previous || null;
    else if (token.type === 'list_item_open') { item = blankTree(''); lists.at(-1).parent.children.push(item); hasContent = true; }
    else if (token.type === 'list_item_close') item = null;
    else if (token.type === 'inline') {
      const title = plainInline(token);
      if (headingLevel && !lists.length) {
        if (headingLevel === 1) {
          finish(); root = blankTree(title || fallback); headings = [{ level: 1, node: root }]; hasContent = true;
        } else {
          while (headings.length > 1 && headings.at(-1).level >= headingLevel) headings.pop();
          const node = blankTree(title); headings.at(-1).node.children.push(node); headings.push({ level: headingLevel, node }); hasContent = true;
        }
      } else if (item) item.title += (item.title ? '\n' : '') + title;
      else if (title.trim()) { headings.at(-1).node.children.push(blankTree(title)); hasContent = true; }
    } else if (token.type === 'fence' || token.type === 'code_block') {
      if (item) item.title += (item.title ? '\n' : '') + token.content.trimEnd();
      else { headings.at(-1).node.children.push(blankTree(token.content.trimEnd())); hasContent = true; }
    }
  }
  finish();
  if (!sets.length || sets.length > 100) throw new Error('Markdown 未包含可导入的主题，或用例集超过 100 个');
  assertTransferSize(sets);
  return sets;
}

function escapeMarkdown(title) {
  return title.replace(/[\\`*_[\]{}()#!+\-.|~]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n?|\n/g, '&#10;');
}

export function exportMarkdown(tree) {
  if (!tree.title.trim()) throw new Error('请填写中心主题后再导出 Markdown');
  const lines = [`# ${escapeMarkdown(tree.title)}`];
  function descendants(node, depth) {
    lines.push(`${'  '.repeat(depth)}- ${escapeMarkdown(node.title)}`);
    for (const child of node.children) descendants(child, depth + 1);
  }
  if (tree.children.some((branch) => !branch.title.trim())) for (const branch of tree.children) descendants(branch, 0);
  else for (const branch of tree.children) {
      lines.push('', `## ${escapeMarkdown(branch.title)}`);
      for (const child of branch.children) descendants(child, 0);
    }
  const result = lines.join('\n') + '\n';
  if (result.length > FORMAT_LIMITS.markdownChars) throw transferLimit('Markdown 转义后的文字超过 2 MB，请减少主题内容后导出');
  return result;
}

function archiveContent(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 10 * 1024 * 1024) throw new Error('XMind 文件不能超过 10 MB');
  let entries = 0;
  let total = 0;
  return unzipSync(bytes, { filter(file) {
    if (++entries > 2000 || file.originalSize > 20 * 1024 * 1024 || (total += file.originalSize) > 40 * 1024 * 1024) throw new Error('XMind 解压后过大');
    if (!['content.json', 'content.xml'].includes(file.name)) return false;
    if (file.originalSize > FORMAT_LIMITS.contentBytes) throw transferLimit('XMind 主题内容超过 8 MB，请分批导入或导出');
    return true;
  } });
}

export function importXmind(bytes) {
  const files = archiveContent(bytes);
  let sheets;
  if (files['content.json']) {
    const content = JSON.parse(strFromU8(files['content.json']));
    if (!Array.isArray(content) || !content.length || content.length > 100) throw new Error('XMind 画布格式不正确');
    let count = 0;
    function topic(node, depth = 0) {
      if (++count > TREE_LIMITS.nodes) throw new Error('XMind 节点过多');
      if (!node || depth > TREE_LIMITS.depth || typeof node.title !== 'string') throw new Error('XMind 节点格式不正确');
      const children = [...(node.children?.attached || []), ...(node.children?.detached || [])];
      if (children.length > TREE_LIMITS.nodes) throw new Error('XMind 节点过多');
      return { id: crypto.randomUUID(), title: node.title, children: children.map((child) => topic(child, depth + 1)) };
    }
    sheets = content.map((sheet) => { count = 0; return { title: String(sheet.title || sheet.rootTopic?.title || '导入用例集').slice(0, 200), tree: normalizeTree(topic(sheet.rootTopic)) }; });
  } else if (files['content.xml']) {
    const xml = strFromU8(files['content.xml']);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('XMind XML 格式不正确');
    const content = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: true }).parse(xml);
    const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
    const legacySheets = array(content['xmap-content']?.sheet);
    if (!legacySheets.length || legacySheets.length > 100) throw new Error('XMind 画布格式不正确');
    let count = 0;
    function topic(node, depth = 0) {
      if (++count > TREE_LIMITS.nodes) throw new Error('XMind 节点过多');
      if (!node || depth > TREE_LIMITS.depth || typeof node.title !== 'string') throw new Error('XMind 节点格式不正确');
      const children = array(node.children?.topics).flatMap((group) => array(group.topic));
      if (children.length > TREE_LIMITS.nodes) throw new Error('XMind 节点过多');
      return { id: crypto.randomUUID(), title: node.title, children: children.map((child) => topic(child, depth + 1)) };
    }
    sheets = legacySheets.map((sheet) => { count = 0; return { title: String(sheet.title || sheet.topic?.title || '导入用例集').slice(0, 200), tree: normalizeTree(topic(sheet.topic)) }; });
  } else throw new Error('文件中未找到 XMind 主题数据');
  assertTransferSize(sheets);
  return sheets;
}

export function exportXmind(sets) {
  if (!sets.length || sets.length > FORMAT_LIMITS.sheets) throw transferLimit('XMind 一次最多导出 100 个画布，请分批导出');
  assertTransferSize(sets);
  assertTransferSize(sets, true);
  function topic(node) { return { id: crypto.randomUUID(), class: 'topic', title: node.title, ...(node.children.length ? { children: { attached: node.children.map(topic) } } : {}) }; }
  const sheets = sets.map((set) => ({ id: crypto.randomUUID(), class: 'sheet', title: set.title, rootTopic: { ...topic(set.tree), structureClass: 'org.xmind.ui.map.unbalanced' } }));
  const content = strToU8(JSON.stringify(sheets));
  if (content.byteLength > FORMAT_LIMITS.contentBytes) throw transferLimit('XMind 主题内容超过 8 MB，请分批导出');
  return zipSync({
    'content.json': content,
    'metadata.json': strToU8(JSON.stringify({ creator: { name: 'QZZ Test Platform', version: '1.0' }, activeSheetId: sheets[0]?.id })),
    'manifest.json': strToU8(JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } })),
  });
}

export function exportMarkdownZip(sets) {
  return zipSync(Object.fromEntries(sets.map((set, index) => [`${index + 1}-${safeFilename(set.title)}.md`, strToU8(exportMarkdown(set.tree))])));
}

export function safeFilename(title) { return String(title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100).trim() || '用例集'; }
