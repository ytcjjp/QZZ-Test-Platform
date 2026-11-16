import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import {
  AlertCircle, ArrowLeft, Bold, Check, ChevronRight, Download, Eraser, GitBranch,
  Italic, Maximize, PaintBucket, Pencil, Plus, Redo2, RefreshCw, Save, Search,
  Trash2, Type, Underline, Undo2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import './case-sets.css';

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin', ...options,
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const nodeId = () => globalThis.crypto?.randomUUID?.() || `node-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const blankTree = (title) => ({ id: nodeId(), title, children: [] });
const STYLE_RULES = {
  fontSize: /^(?:1[2-9]|[23]\d|4[0-8])px$/,
  color: /^#[\da-f]{6}$/i, background: /^#[\da-f]{6}$/i,
  fontWeight: /^(normal|bold)$/, fontStyle: /^(normal|italic)$/, textDecoration: /^(none|underline)$/,
};
function nodeStyle(style) {
  const result = {};
  for (const [key, pattern] of Object.entries(STYLE_RULES)) {
    if (typeof style?.[key] === 'string' && pattern.test(style[key])) result[key] = style[key].toLowerCase();
  }
  return Object.keys(result).length ? result : undefined;
}
const styleField = (style) => { const value = nodeStyle(style); return value ? { style: value } : {}; };
const toMindNode = (tree) => ({ id: tree.id, topic: tree.title, children: (tree.children || []).map(toMindNode), ...styleField(tree.style), expanded: true });
const fromMindNode = (node) => ({ id: node.id, title: node.topic, children: (node.children || []).map(fromMindNode), ...styleField(node.style) });
const canonicalTree = (tree) => ({ id: tree.id, title: tree.title, children: (tree.children || []).map(canonicalTree), ...styleField(tree.style) });
const countNodes = (tree) => tree ? 1 + (tree.children || []).reduce((sum, node) => sum + countNodes(node), 0) : 0;
const signature = (title, tree) => JSON.stringify([title, canonicalTree(tree)]);
const FONT_SIZES = Array.from({ length: 19 }, (_, index) => `${12 + index * 2}px`);
const EMPTY_FORMAT = { fontSize: null, color: null, background: null, bold: false, italic: false, underline: false };
const CLEAR_STYLE_PROPERTIES = ['font-size', 'color', 'background', 'font-weight', 'font-style', 'text-decoration'];

function cssColorHex(value, fallback) {
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = value.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return fallback;
  return `#${rgb.slice(1, 4).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('')}`;
}

function selectedFormat(nodes) {
  if (!nodes.length) return EMPTY_FORMAT;
  const formats = nodes.map((node) => {
    const computed = getComputedStyle(node);
    return {
      fontSize: `${Math.max(12, Math.min(48, Math.round(parseFloat(computed.fontSize) || 16)))}px`,
      color: cssColorHex(computed.color, '#29413d'),
      background: cssColorHex(computed.backgroundColor, '#ffffff'),
      bold: computed.fontWeight === 'bold' || Number(computed.fontWeight) >= 600,
      italic: computed.fontStyle === 'italic', underline: computed.textDecorationLine.includes('underline'),
    };
  });
  return Object.fromEntries(Object.keys(EMPTY_FORMAT).map((key) => {
    const value = formats[0][key];
    return [key, formats.every((format) => format[key] === value) ? value : ['bold', 'italic', 'underline'].includes(key) ? 'mixed' : null];
  }));
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function Tool({ icon: Icon, label, onClick, disabled, danger = false, pressed }) {
  return <button type="button" className={`icon-button ${danger ? 'danger' : ''} ${pressed === true ? 'case-format-active' : ''} ${pressed === 'mixed' ? 'case-format-mixed' : ''}`} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}><Icon size={17} /></button>;
}

function ColorTool({ icon: Icon, label, value, disabled, onChange }) {
  const lastApplied = useRef(value);
  useEffect(() => { lastApplied.current = value; }, [value]);
  function apply(event) {
    const color = event.currentTarget.value;
    if (color === lastApplied.current) return;
    lastApplied.current = color; onChange(color);
  }
  return <label className={`case-format-color ${disabled ? 'disabled' : ''}`} title={value ? label : `${label}：多种颜色`}><Icon size={16} /><span className={`case-color-swatch ${value ? '' : 'mixed'}`} style={value ? { backgroundColor: value } : undefined} /><input type="color" aria-label={label} value={value || '#ffffff'} disabled={disabled} onInput={apply} onChange={apply} /></label>;
}

function NameDialog({ initial = '', title, onClose, onSave }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave(name.trim()); }
    catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal case-set-name-dialog" role="dialog" aria-modal="true" aria-labelledby="case-set-dialog-title"><div className="modal-head"><h2 id="case-set-dialog-title">{title}</h2><Tool icon={X} label="关闭" disabled={busy} onClick={onClose} /></div><form className="modal-form" onSubmit={submit}><label className="field"><span>用例集名称</span><input autoFocus aria-label="用例集名称" value={name} maxLength={200} required disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="输入用例集名称" /></label>{error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</button></div></form></div></div>;
}

function MindMapEditor({ record, latest, canWrite, projectId, onBack, onSaved, onRefresh, onNotice }) {
  const container = useRef(null);
  const mind = useRef(null);
  const ready = useRef(false);
  const mounted = useRef(true);
  const writable = useRef(canWrite);
  const currentTitle = useRef(record.title);
  const base = useRef(record);
  const baseline = useRef(signature(record.title, record.tree || blankTree(record.title)));
  const state = useRef({ dirty: false, saving: false });
  const [title, setTitle] = useState(record.title);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [selected, setSelected] = useState(false);
  const [isRoot, setIsRoot] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [nodeCount, setNodeCount] = useState(countNodes(record.tree));
  const [mapReady, setMapReady] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [format, setFormat] = useState(EMPTY_FORMAT);
  const [selectedCount, setSelectedCount] = useState(0);
  currentTitle.current = title;
  writable.current = canWrite;
  state.current = { dirty, saving };

  const updateDirty = useCallback(() => {
    if (!ready.current || !mind.current) return;
    const tree = fromMindNode(mind.current.getData().nodeData);
    setDirty(signature(currentTitle.current, tree) !== baseline.current);
    setNodeCount(countNodes(tree));
  }, []);
  const updateFormat = useCallback(() => {
    const nodes = mind.current?.currentNodes || [];
    setSelectedCount(nodes.length); setFormat(selectedFormat(nodes));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const instance = new MindElixir({
      el: container.current, direction: MindElixir.RIGHT, editable: canWrite,
      toolBar: false, keypress: canWrite, contextMenu: false, allowUndo: true,
      newTopicName: '新主题', scaleMin: 0.2, scaleMax: 2,
      theme: {
        ...MindElixir.THEME, name: 'QZZ',
        palette: ['#238d7d', '#df775e', '#638bc4', '#a676ae', '#78a666'],
        cssVar: {
          ...MindElixir.THEME?.cssVar, '--bgcolor': '#ffffff', '--color': '#29413d',
          '--main-color': '#29413d', '--main-bgcolor': '#edf6f2',
          '--root-color': '#ffffff', '--root-bgcolor': '#238d7d',
          '--root-border-color': '#238d7d', '--root-radius': '5px', '--main-radius': '4px',
          '--selected': '#df775e', '--accent-color': '#238d7d',
        },
      },
    });
    mind.current = instance;
    const startingTree = record.tree || blankTree(record.title);
    baseline.current = signature(record.title, startingTree);
    const operation = () => { updateDirty(); updateFormat(); };
    const selection = () => { const nodes = instance.currentNodes; setSelected(Boolean(nodes.length)); setIsRoot(!nodes.length || nodes.some((node) => !node.nodeObj.parent)); updateFormat(); };
    const typing = () => setDirty(true);
    instance.bus.addListener('operation', operation);
    instance.bus.addListener('selectNodes', selection);
    instance.bus.addListener('unselectNodes', selection);
    instance.bus.addListener('scale', (value) => setZoom(Math.round(value * 100)));
    instance.nodes.addEventListener('input', typing);
    let unsubscribeHistory = () => {};
    let resizeFrame = 0;
    let canvasWidth = 0;
    let canvasHeight = 0;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0 || (Math.abs(width - canvasWidth) < 1 && Math.abs(height - canvasHeight) < 1)) return;
      canvasWidth = width; canvasHeight = height;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (mounted.current && ready.current && mind.current === instance) instance.scaleFit();
      });
    });
    resizeObserver.observe(container.current);
    Promise.resolve(instance.init({ nodeData: toMindNode(startingTree) })).then((failure) => {
      if (!mounted.current || mind.current !== instance) return;
      if (failure instanceof Error) throw failure;
      ready.current = true; setMapReady(true); setNodeCount(countNodes(startingTree));
      unsubscribeHistory = instance.historyStack?.subscribe(() => {
        updateDirty(); updateFormat(); setHistory({ undo: instance.historyStack.canUndo, redo: instance.historyStack.canRedo });
      }) || (() => {});
      instance.scaleFit();
      const root = instance.findEle(startingTree.id);
      if (root) instance.selectNode(root);
    }).catch((failure) => { if (mounted.current) setError(`思维导图加载失败：${failure.message}`); });
    return () => { mounted.current = false; ready.current = false; mind.current = null; resizeObserver.disconnect(); cancelAnimationFrame(resizeFrame); unsubscribeHistory(); instance.nodes.removeEventListener('input', typing); instance.destroy(); };
  }, [record.id, updateDirty, updateFormat]);

  useEffect(() => {
    if (!mind.current || !ready.current) return;
    if (canWrite) { mind.current.enableEdit(); mind.current.keypress = true; }
    else { mind.current.disableEdit(); mind.current.keypress = false; }
  }, [canWrite, mapReady]);

  useEffect(() => {
    function beforeUnload(event) { if (state.current.dirty || state.current.saving) { event.preventDefault(); event.returnValue = ''; } }
    function beforeNavigate(event) {
      if (state.current.saving || (state.current.dirty && !window.confirm('用例集尚未保存，确定放弃修改并离开吗？'))) event.preventDefault();
    }
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('qzz-before-navigate', beforeNavigate);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('qzz-before-navigate', beforeNavigate); };
  }, []);

  useEffect(() => {
    const changed = !latest || latest.revision !== base.current.revision;
    if (changed && latest && mapReady && !dirty && !saving) {
      loadSnapshot(latest);
    } else setRemoteChanged(changed);
  }, [latest, mapReady, dirty, saving]);

  function leave() {
    if (!saving && (!dirty || window.confirm('用例集尚未保存，确定放弃修改并返回吗？'))) onBack();
  }
  async function act(action) {
    if (!canWrite || !ready.current || saving) return;
    try { mind.current.container.focus(); await action(mind.current); if (mounted.current) { updateDirty(); updateFormat(); } }
    catch (failure) { if (mounted.current) setError(failure.message || '操作未完成'); }
  }
  async function applyFormat(patch) {
    if (!writable.current || !ready.current || state.current.saving) return;
    const instance = mind.current;
    const nodes = [...instance.currentNodes];
    if (!nodes.length) return;
    container.current.querySelector('#input-box')?.blur();
    try {
      for (const node of nodes) {
        if (patch) await instance.reshapeNode(node, { style: { ...patch } });
        else if (node.nodeObj.style) {
          await instance.reshapeNode(node, { style: undefined });
          // The library records style removal but leaves existing inline CSS in this operation.
          CLEAR_STYLE_PROPERTIES.forEach((property) => node.style.removeProperty(property));
        }
      }
      if (mounted.current) { updateDirty(); updateFormat(); }
    } catch (failure) { if (mounted.current) setError(failure.message || '格式修改失败'); }
  }
  async function save(asCopy = false) {
    if (!canWrite || !ready.current || state.current.saving || !title.trim()) return;
    container.current.querySelector('#input-box')?.blur();
    mind.current.disableEdit();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!mounted.current || !mind.current) return;
    const tree = fromMindNode(mind.current.getData().nodeData);
    const savedTitle = title.trim();
    const savedSignature = signature(savedTitle, tree);
    const original = base.current;
    setSaving(true); setError('');
    state.current.saving = true;
    try {
      const result = await request(`/api/cases${asCopy ? '' : `/${encodeURIComponent(original.id)}`}`, {
        method: asCopy ? 'POST' : 'PUT',
        body: JSON.stringify({ title: savedTitle, tree, projectId, ...(asCopy ? {} : { revision: original.revision }) }),
      });
      if (!mounted.current) return;
      base.current = result.case; baseline.current = savedSignature;
      setTitle(savedTitle); setDirty(false); setRemoteChanged(false);
      onNotice?.(asCopy ? '已另存为新用例集' : '用例集已保存');
      onSaved(result.case, asCopy);
      await onRefresh();
    } catch (failure) {
      if (!mounted.current) return;
      if (failure.status === 409 || failure.status === 404) { setRemoteChanged(true); await onRefresh(); }
      setError(failure.status === 409 ? '此用例集已被其他人修改。当前编辑已保留，可载入最新版本，或另存为新用例集。' : failure.message);
    } finally {
      if (mounted.current) { setSaving(false); state.current.saving = false; if (writable.current) mind.current?.enableEdit(); }
    }
  }
  function loadSnapshot(snapshot) {
    const tree = snapshot.tree || blankTree(snapshot.title);
    base.current = snapshot; baseline.current = signature(snapshot.title, tree);
    setTitle(snapshot.title); currentTitle.current = snapshot.title;
    mind.current.refresh({ nodeData: toMindNode(tree) }); mind.current.clearHistory?.();
    mind.current.toCenter(); setNodeCount(countNodes(tree)); setDirty(false); setError(''); setRemoteChanged(false);
  }
  function reloadLatest() {
    if (!latest || saving || (dirty && !window.confirm('载入最新版本会放弃当前未保存的修改，确定继续吗？'))) return;
    loadSnapshot(latest);
  }
  function changeZoom(delta) {
    if (!ready.current) return;
    const value = Math.max(0.2, Math.min(2, mind.current.scaleVal + delta));
    mind.current.scale(value); setZoom(Math.round(value * 100));
  }

  return <section className="case-set-editor" onKeyDownCapture={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); save(); } }}>
    <div className="case-editor-heading"><Tool icon={ArrowLeft} label="返回用例集列表" onClick={leave} disabled={saving} /><div className="case-editor-name"><label htmlFor="case-set-name">用例集名称</label><input id="case-set-name" value={title} maxLength={200} readOnly={!canWrite} disabled={saving} onChange={(event) => { const value = event.target.value; setTitle(value); currentTitle.current = value; updateDirty(); }} /></div><span className={`case-save-state ${dirty ? 'dirty' : ''}`}>{saving ? '保存中' : dirty ? '未保存' : <><Check size={14} />已保存</>}</span>{canWrite && <button type="button" className="button primary" onClick={() => save()} disabled={saving || !mapReady || !title.trim() || !dirty}><Save size={16} />保存</button>}</div>
    {remoteChanged && <div className="case-editor-warning" role="status"><AlertCircle size={16} /><span>{latest ? '此用例集已有其他人的更新。' : '此用例集已不在当前列表中。'}当前编辑已保留。</span>{latest && <button type="button" className="text-button" onClick={reloadLatest} disabled={saving || !mapReady}>载入最新版本</button>}{canWrite && <button type="button" className="text-button" onClick={() => save(true)} disabled={saving || !mapReady || !title.trim()}>另存为新用例集</button>}</div>}
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}
    <div className="case-map-toolbar" aria-label="思维导图工具栏"><div>{canWrite && <><Tool icon={GitBranch} label="添加子主题" disabled={!mapReady || saving || !selected} onClick={() => act((instance) => instance.addChild())} /><Tool icon={Plus} label="添加同级主题" disabled={!mapReady || saving || !selected || isRoot} onClick={() => act((instance) => instance.insertSibling('after'))} /><Tool icon={Pencil} label="编辑主题" disabled={!mapReady || saving || !selected} onClick={() => act((instance) => instance.beginEdit())} /><Tool icon={Trash2} label="删除选中主题" danger disabled={!mapReady || saving || !selected || isRoot} onClick={() => act((instance) => instance.removeNodes(instance.currentNodes))} /><span className="case-tool-divider" /><Tool icon={Undo2} label="撤销" disabled={!mapReady || saving || !history.undo} onClick={() => act((instance) => instance.undo())} /><Tool icon={Redo2} label="重做" disabled={!mapReady || saving || !history.redo} onClick={() => act((instance) => instance.redo())} /></>}</div><div><Tool icon={ZoomOut} label="缩小" disabled={!mapReady} onClick={() => changeZoom(-0.1)} /><span className="case-zoom-value">{zoom}%</span><Tool icon={ZoomIn} label="放大" disabled={!mapReady} onClick={() => changeZoom(0.1)} /><Tool icon={Maximize} label="适应画布" disabled={!mapReady} onClick={() => { mind.current.scaleFit(); setZoom(Math.round(mind.current.scaleVal * 100)); }} /></div></div>
    {canWrite && <div className="case-format-toolbar" role="toolbar" aria-label="主题格式工具栏">
      <div className="case-format-group"><select aria-label="字体大小" title="字体大小" value={format.fontSize || ''} disabled={!mapReady || saving || !selected} onChange={(event) => applyFormat({ fontSize: event.target.value })}><option value="" disabled>{selected ? '混合' : '字号'}</option>{[...new Set([...FONT_SIZES, ...(format.fontSize ? [format.fontSize] : [])])].sort((a, b) => parseInt(a) - parseInt(b)).map((value) => <option key={value} value={value}>{parseInt(value)} px</option>)}</select><Tool icon={Bold} label="加粗" pressed={format.bold} disabled={!mapReady || saving || !selected} onClick={() => applyFormat({ fontWeight: format.bold === true ? 'normal' : 'bold' })} /><Tool icon={Italic} label="斜体" pressed={format.italic} disabled={!mapReady || saving || !selected} onClick={() => applyFormat({ fontStyle: format.italic === true ? 'normal' : 'italic' })} /><Tool icon={Underline} label="下划线" pressed={format.underline} disabled={!mapReady || saving || !selected} onClick={() => applyFormat({ textDecoration: format.underline === true ? 'none' : 'underline' })} /></div>
      <span className="case-tool-divider" /><div className="case-format-group"><ColorTool icon={Type} label="文字颜色" value={format.color} disabled={!mapReady || saving || !selected} onChange={(value) => applyFormat({ color: value })} /><ColorTool icon={PaintBucket} label="背景颜色" value={format.background} disabled={!mapReady || saving || !selected} onChange={(value) => applyFormat({ background: value })} /><Tool icon={Eraser} label="清除格式" disabled={!mapReady || saving || !selected} onClick={() => applyFormat(null)} /></div>{selectedCount > 1 && <span className="case-format-selection">{selectedCount} 个主题</span>}
    </div>}
    <div className="case-map-canvas" ref={container} role="region" aria-label="用例思维导图" />
    <div className="case-editor-footer"><span>{nodeCount} 个主题</span><span>{canWrite ? '可编辑' : '只读'} · 版本 {base.current.revision}</span></div>
  </section>;
}

export default function CaseSetsPage({ project, items, loading, canWrite, onRefresh, showError, onNotice }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('latest');
  const [selection, setSelection] = useState(new Map());
  const [editor, setEditor] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const input = useRef(null);
  const alive = useRef(true);
  const projectId = project.id;
  const visible = useMemo(() => items.filter((item) => [item.title, item.createdBy].some((text) => String(text || '').toLowerCase().includes(query.toLowerCase()))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : new Date(b.updatedAt) - new Date(a.updatedAt)), [items, query, sort]);
  const selectedItems = [...selection].map(([id, revision]) => ({ id, revision }));
  const allChecked = visible.length > 0 && visible.every((item) => selection.has(item.id));
  const selectAllRef = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelection((previous) => new Map([...previous].filter(([id]) => items.some((item) => item.id === id)))); }, [items]);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = !allChecked && visible.some((item) => selection.has(item.id)); }, [allChecked, visible, selection]);
  function fail(failure) { if (alive.current) { setMessage(failure.message); showError?.(failure.message); } }
  function notice(text) { if (alive.current) { setMessage(''); onNotice?.(text); } }
  function toggle(item) { setSelection((previous) => { const next = new Map(previous); if (next.has(item.id)) next.delete(item.id); else next.set(item.id, item.revision); return next; }); }
  async function saveName(name) {
    const editing = dialog?.record;
    const result = await request(`/api/cases${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify({ projectId, title: name, ...(editing ? { revision: editing.revision } : { tree: blankTree(name) }) }),
    });
    if (!alive.current) return;
    setDialog(null); if (!editing) setEditor(result.case);
    notice(editing ? '用例集已重命名' : '用例集已创建'); await onRefresh();
  }
  async function remove(records) {
    if (!canWrite || !records.length || !window.confirm(records.length === 1 ? `确定删除用例集“${records[0].title || items.find((item) => item.id === records[0].id)?.title}”吗？此操作无法撤销。` : `确定删除已选的 ${records.length} 个用例集吗？此操作无法撤销。`)) return;
    setBusy(true); setMessage('');
    try {
      await request('/api/cases/batch', { method: 'POST', body: JSON.stringify({ projectId, items: records.map(({ id, revision }) => ({ id, revision })), action: 'delete' }) });
      if (!alive.current) return;
      setSelection(new Map()); notice('用例集已删除'); await onRefresh();
    } catch (failure) {
      if (failure.status === 409) {
        if (alive.current) setSelection(new Map());
        fail(new Error('所选用例集已被其他人修改，已取消选择。请核对最新内容后重新选择并确认删除。'));
        await onRefresh();
      } else fail(failure);
    }
    finally { if (alive.current) setBusy(false); }
  }
  async function importFiles(files) {
    if (!canWrite || busy || !files.length) return;
    if (files.length > 10) { fail(new Error('一次最多导入 10 个文件')); return; }
    if (files.some((file) => !/\.(md|xmind)$/i.test(file.name))) { fail(new Error('请选择 Markdown 或 XMind 文件')); return; }
    setBusy(true); setMessage(''); let imported = 0;
    try {
      for (const file of files) {
        const form = new FormData(); form.append('file', file); form.append('projectId', projectId);
        const result = await request('/api/cases/import', { method: 'POST', body: form });
        imported += result.cases?.length || 0;
        if (!alive.current) return;
      }
      setSelection(new Map()); notice(`已导入 ${imported} 个用例集`);
    } catch (failure) { fail(new Error(`${imported ? `已导入 ${imported} 个用例集。` : ''}${failure.message}`)); }
    finally { if (alive.current) { await onRefresh(); setBusy(false); } }
  }
  async function exportSets(records, format) {
    if (!records.length) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/cases/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, items: records.map(({ id, revision }) => ({ id, revision })), format }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const failure = new Error(body.message || '导出失败');
        failure.status = response.status;
        throw failure;
      }
      const blob = await response.blob();
      if (!alive.current) return;
      const disposition = response.headers.get('content-disposition') || '';
      const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fallback = disposition.match(/filename="([^"]+)"/i)?.[1];
      let filename = fallback || `${records.length === 1 ? items.find((item) => item.id === records[0].id)?.title || '用例集' : '用例集'}.${format === 'md' && records.length > 1 ? 'zip' : format}`;
      if (utf8Name) { try { filename = decodeURIComponent(utf8Name); } catch { /* Keep the fallback filename. */ } }
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); notice('用例集已导出');
    } catch (failure) {
      if (failure.status === 409) {
        if (alive.current) setSelection(new Map());
        fail(new Error('所选用例集已被其他人修改，已取消选择。请核对最新内容后重新选择导出。'));
        await onRefresh();
      } else fail(failure);
    }
    finally { if (alive.current) setBusy(false); }
  }

  if (editor) return <MindMapEditor key={editor.id} record={editor} latest={items.find((item) => item.id === editor.id)} canWrite={canWrite} projectId={projectId} onBack={() => setEditor(null)} onSaved={(record, asCopy) => { if (asCopy) setEditor(record); }} onRefresh={onRefresh} onNotice={onNotice} />;

  return <section className={`workspace-section case-sets-section ${dragging ? 'case-import-dragging' : ''}`} onDragOver={(event) => { if (canWrite && [...event.dataTransfer.types].includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (canWrite) importFiles([...event.dataTransfer.files]); }}>
    <div className="section-heading"><div><span className="eyebrow">CASE COLLECTIONS</span><h1>测试用例库</h1><p>{project.name}</p></div><div className="heading-actions"><Tool icon={RefreshCw} label="刷新用例集" onClick={onRefresh} disabled={loading || busy} />{canWrite && <><button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={16} />导入</button><button type="button" className="button primary" disabled={busy} onClick={() => setDialog({})}><Plus size={16} />新建用例集</button></>}</div></div>
    <input type="file" accept=".md,.xmind" aria-label="导入用例集文件" multiple hidden ref={input} onChange={(event) => { importFiles([...event.target.files]); event.target.value = ''; }} />
    {dragging && <div className="case-drop-indicator"><Upload size={20} />导入用例集</div>}
    {message && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{message}</span><Tool icon={X} label="关闭用例集提示" onClick={() => setMessage('')} /></div>}
    <div className="table-surface"><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="搜索用例集" placeholder="搜索名称或创建人" value={query} onChange={(event) => { setQuery(event.target.value); setSelection(new Map()); }} /></div><select aria-label="用例集排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="latest">最近更新</option><option value="title">按名称</option></select></div>
      <div className="case-batch-bar"><span>{selection.size ? `已选择 ${selection.size} 个用例集` : `${items.length} 个用例集`}</span>{selection.size > 0 && <><Tool icon={X} label="取消选择用例集" disabled={busy} onClick={() => setSelection(new Map())} /><span className="case-tool-divider" /><button type="button" className="button secondary" disabled={busy} onClick={() => exportSets(selectedItems, 'xmind')}><Download size={15} />XMind</button><button type="button" className="button secondary" disabled={busy} onClick={() => exportSets(selectedItems, 'md')}><Download size={15} />Markdown</button>{canWrite && <Tool icon={Trash2} label="删除选中用例集" danger disabled={busy} onClick={() => remove(selectedItems)} />}</>}{busy && <RefreshCw className="spin" size={16} />}</div>
      {loading && !items.length ? <div className="loading-state"><RefreshCw className="spin" size={18} />加载中…</div> : !visible.length ? <div className="empty-state"><div className="empty-icon"><GitBranch size={25} /></div><h3>{items.length ? '没有匹配的用例集' : '暂无用例集'}</h3>{canWrite && !items.length && <button className="button secondary" type="button" onClick={() => setDialog({})}><Plus size={16} />新建用例集</button>}</div> : <div className="table-scroll"><table className="case-sets-table"><thead><tr><th className="case-check-cell"><input ref={selectAllRef} type="checkbox" aria-label="全选当前用例集" checked={allChecked} disabled={busy} onChange={() => setSelection((previous) => { const next = new Map(previous); visible.forEach((item) => allChecked ? next.delete(item.id) : next.set(item.id, item.revision)); return next; })} /></th><th>用例集名称</th><th>主题数</th><th>创建人</th><th>最近更新</th><th>操作</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} className={selection.has(item.id) ? 'case-row-selected' : ''} onClick={() => setEditor(item)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) setEditor(item); }}><td className="case-check-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`选择用例集 ${item.title}`} checked={selection.has(item.id)} disabled={busy} onChange={() => toggle(item)} /></td><td><button type="button" className="case-set-open" onClick={(event) => { event.stopPropagation(); setEditor(item); }}><GitBranch size={18} /><strong>{item.title}</strong></button></td><td>{item.nodeCount ?? countNodes(item.tree)}</td><td>{item.createdBy || '-'}</td><td className="date-cell">{dateLabel(item.updatedAt)}</td><td onClick={(event) => event.stopPropagation()}><div className="case-row-actions"><Tool icon={Download} label={`导出 ${item.title} 为 XMind`} disabled={busy} onClick={() => exportSets([item], 'xmind')} />{canWrite && <><Tool icon={Pencil} label={`重命名用例集 ${item.title}`} disabled={busy} onClick={() => setDialog({ record: item })} /><Tool icon={Trash2} label={`删除用例集 ${item.title}`} danger disabled={busy} onClick={() => remove([item])} /></>}<Tool icon={ChevronRight} label={`打开用例集 ${item.title}`} onClick={() => setEditor(item)} /></div></td></tr>)}</tbody></table></div>}
    </div>
    {dialog && canWrite && <NameDialog initial={dialog.record?.title} title={dialog.record ? '重命名用例集' : '新建用例集'} onClose={() => setDialog(null)} onSave={saveName} />}
  </section>;
}
