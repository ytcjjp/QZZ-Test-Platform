import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bug, ChevronRight, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import './defects-page.css';
import { DEFECT_STATUSES as STATUSES, defectStatusClass } from './defect-status';

const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function DefectsPage({ project, items, loading, canWrite, onNew, onSelect, onRefresh, showError, onNotice }) {
  const [query, setQuery] = useState('');
  const [module, setModule] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(new Map());
  const [bulkStatus, setBulkStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);
  const selectAll = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected((old) => new Map([...old].filter(([id]) => items.some((item) => item.id === id)))); }, [items]);
  const modules = [...new Set(items.map((item) => item.module).filter(Boolean))];
  const visible = useMemo(() => items.filter((item) => (!query || [item.title, item.module, item.assignee, item.version].join(' ').toLowerCase().includes(query.toLowerCase())) && (!module || item.module === module) && (!status || item.status === status)), [items, query, module, status]);
  const checkedCount = visible.filter((item) => selected.has(item.id)).length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = checkedCount > 0 && checkedCount < visible.length; }, [checkedCount, visible.length]);
  function toggle(item) { setSelected((old) => { const next = new Map(old); next.has(item.id) ? next.delete(item.id) : next.set(item.id, item.revision); return next; }); }
  async function operate(records, action, nextStatus) {
    if (!canWrite || busy || !records.length) return;
    setBusy(true);
    try {
      const response = await fetch('/api/defects/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, items: records.map(({ id, revision }) => ({ id, revision })), action, ...(nextStatus ? { status: nextStatus } : {}) }) });
      const data = await response.json();
      if (!response.ok) { const failure = new Error(data.message || '操作失败'); failure.status = response.status; throw failure; }
      if (!alive.current) return;
      setSelected(new Map()); setBulkStatus(''); setConfirmDelete(false);
      onNotice(action === 'delete' ? `已删除 ${records.length} 条缺陷` : `已更新 ${records.length} 条缺陷的状态`);
      await onRefresh();
    } catch (error) { if (alive.current) { if (error.status === 409) { setSelected(new Map()); setConfirmDelete(false); showError('有缺陷已被其他人修改，已刷新列表。请重新选择并确认操作。'); } else showError(error.message); await onRefresh(); } }
    finally { if (alive.current) setBusy(false); }
  }
  const chosen = items.filter((item) => selected.has(item.id)).map((item) => ({ ...item, revision: selected.get(item.id) }));
  return <section className="workspace-section">
    <div className="section-heading"><div><span className="eyebrow">ISSUE TRACKER</span><h1>当前缺陷</h1></div><div className="heading-actions"><button className="icon-button" title="刷新" aria-label="刷新" onClick={onRefresh} disabled={loading || busy}><RefreshCw size={17} /></button>{canWrite && <button className="button primary" onClick={onNew}><Plus size={17} />新建缺陷</button>}</div></div>
    <div className="summary-band"><div><span>缺陷总数</span><strong>{items.length}</strong></div><div><span>未关闭</span><strong>{items.filter((item) => !['已解决', '已关闭'].includes(item.status)).length}</strong></div><div><span>高严重度</span><strong>{items.filter((item) => ['致命', '严重'].includes(item.severity)).length}</strong></div></div>
    <div className="table-surface"><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="搜索当前缺陷" placeholder="搜索标题、模块、负责人" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="toolbar-filters"><select aria-label="模块筛选" value={module} onChange={(event) => setModule(event.target.value)}><option value="">全部模块</option>{modules.map((name) => <option key={name}>{name}</option>)}</select><select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{STATUSES.map((name) => <option key={name}>{name}</option>)}</select></div></div>
      {chosen.length > 0 && canWrite && <div className="defect-bulk" role="region" aria-label="缺陷批量操作"><strong>已选择 {chosen.length} 条</strong><select className={defectStatusClass(bulkStatus)} aria-label="批量目标状态" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)} disabled={busy}><option value="">选择状态</option>{STATUSES.map((name) => <option key={name}>{name}</option>)}</select><button className="button secondary" disabled={busy || !bulkStatus} onClick={() => operate(chosen, 'status', bulkStatus)}>更新状态</button><button className="button secondary danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={16} />删除</button><button className="icon-button" aria-label="取消选择" title="取消选择" disabled={busy} onClick={() => setSelected(new Map())}><X size={16} /></button></div>}
      <div className="table-caption">显示 {visible.length} / {items.length} 条</div>
      {visible.length ? <div className="table-scroll"><table className="defect-table"><thead><tr>{canWrite && <th className="select-col"><input ref={selectAll} type="checkbox" aria-label="全选当前列表缺陷" checked={visible.length > 0 && checkedCount === visible.length} disabled={busy} onChange={() => setSelected((old) => { const next = new Map(old); visible.forEach(({ id, revision }) => checkedCount === visible.length ? next.delete(id) : next.set(id, revision)); return next; })} /></th>}<th className="defect-title-col">缺陷标题</th><th>所属模块</th><th>严重度</th><th>状态</th><th>负责人</th><th>最近更新</th><th className="defect-actions-col" /></tr></thead><tbody>{visible.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'record-selected' : ''} onClick={() => onSelect(item)} tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') onSelect(item); }}>
        {canWrite && <td className="select-col" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`选择缺陷 ${item.title}`} checked={selected.has(item.id)} disabled={busy} onChange={() => toggle(item)} /></td>}<td className="defect-title-col"><div className="record-title">{item.title}</div><div className="record-meta">#{item.id.slice(0, 8)}</div></td><td>{item.module || '—'}</td><td><span className={`tone ${['致命', '严重'].includes(item.severity) ? 'tone-warning' : 'tone-neutral'}`}>{item.severity}</span></td><td onClick={(event) => event.stopPropagation()}>{canWrite ? <select className={`defect-status-select ${defectStatusClass(item.status)}`} aria-label={`修改缺陷状态 ${item.title}`} value={item.status} disabled={busy} onChange={(event) => operate([item], 'status', event.target.value)}>{!STATUSES.includes(item.status) && <option>{item.status}</option>}{STATUSES.map((name) => <option key={name}>{name}</option>)}</select> : <span className={`tone ${defectStatusClass(item.status)}`}>{item.status}</span>}</td><td>{item.assignee || '未指派'}</td><td className="date-cell">{date(item.updatedAt)}</td><td><button className="icon-button" title="查看详情" aria-label={`查看缺陷 ${item.title}`} onClick={(event) => { event.stopPropagation(); onSelect(item); }}><ChevronRight size={17} /></button></td>
      </tr>)}</tbody></table></div> : <div className="empty-state"><Bug size={28} /><h3>{loading ? '加载中…' : items.length ? '没有匹配的缺陷' : '还没有缺陷记录'}</h3></div>}
    </div>
    {confirmDelete && <div className="modal-backdrop"><div className="modal defect-delete-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title"><div className="modal-head"><h2 id="bulk-delete-title">删除所选缺陷</h2></div><div className="modal-form"><p>确定删除这 {chosen.length} 条缺陷？删除后无法撤销。</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button className="button primary" disabled={busy || !chosen.length} onClick={() => operate(chosen, 'delete')}>{busy ? '删除中…' : '确认删除'}</button></div></div></div></div>}
  </section>;
}
