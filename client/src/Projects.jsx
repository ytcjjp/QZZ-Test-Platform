import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ChevronRight, Folder, ImagePlus, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';

export function ProjectIcon({ project, small = false }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [project?.iconUrl]);
  return <span className={`project-icon ${small ? 'small' : ''}`}>{project?.iconUrl && !failed ? <img src={project.iconUrl} alt="" onError={() => setFailed(true)} /> : <Folder size={small ? 17 : 24} strokeWidth={1.7} />}</span>;
}

export function ProjectContext({ project, onBack }) {
  return <div className="project-context"><button type="button" className="button secondary" onClick={onBack}><ArrowLeft size={16} />切换项目组</button><ProjectIcon project={project} small /><strong title={project.name}>{project.name}</strong></div>;
}

function DeleteProjectDialog({ project, onClose, onDelete }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onDelete(project, name); onClose(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><div className="modal-head"><h2 id="delete-project-title">删除项目组</h2><button className="icon-button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div><form className="modal-form" onSubmit={submit}><p>“{project.name}”及其 {project.caseCount ?? 0} 个用例集、{project.defectCount ?? 0} 条缺陷将从工作区移除。admin 可在“已删除项目组”中完整恢复。</p><label className="field"><span>输入项目组名称确认</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={project.name} required disabled={busy} /></label>{error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}<div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={busy || name !== project.name}>{busy ? '删除中…' : '确认删除'}</button></div></form></div></div>;
}

function ProjectDialog({ initial, iconOnly, onClose, onCreate, onRename, onUpload, onRefresh }) {
  const [project, setProject] = useState(initial);
  const [name, setName] = useState(initial?.name || '');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (!file) { setPreview(''); return undefined; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function chooseFile(selected) {
    setError('');
    if (!selected) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(selected.type) || !/\.(png|jpe?g|webp|gif)$/i.test(selected.name)) { setFile(null); setError('请选择 PNG、JPG、WebP 或 GIF 图片'); return; }
    if (selected.size > 2 * 1024 * 1024) { setFile(null); setError('图标文件不能超过 2 MB'); return; }
    setFile(selected);
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    let current = project;
    try {
      if (!current) { current = await onCreate(name.trim()); setProject(current); }
      else if (!iconOnly) { current = await onRename(current, name.trim()); setProject(current); }
      if (file) { current = await onUpload(current, file); setProject(current); }
      onClose();
    } catch (failure) {
      if (failure.status === 409 && current) {
        try {
          const latest = (await onRefresh()).find((item) => item.id === current.id);
          if (latest) setProject(latest);
        } catch { /* Keep the entered name and file for another attempt. */ }
        setError(`${failure.message} 已刷新项目信息，你填写的内容已保留，请确认后再次保存。`);
      } else setError(failure.message);
    } finally { setBusy(false); }
  }
  const title = iconOnly ? '上传项目图标' : initial ? '重命名项目组' : '新建项目组';
  return <div className="modal-backdrop"><div className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><div className="modal-head"><h2 id="project-dialog-title">{title}</h2><button type="button" className="icon-button" title="关闭" aria-label="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div><form className="modal-form" onSubmit={submit}>
    {iconOnly ? <div className="project-dialog-name"><ProjectIcon project={project} small /><strong>{project.name}</strong></div> : <label className="field"><span>项目组名称 <em>*</em></span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required disabled={busy} placeholder="输入项目组名称" /></label>}
    {(iconOnly || !initial) && <div className="project-icon-editor"><div className="project-icon-preview">{preview ? <img src={preview} alt="所选项目图标预览" /> : <ProjectIcon project={project} />}</div><div><input ref={inputRef} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} /><button type="button" className="button secondary" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={16} />{file ? '重新选择图片' : '选择图标图片'}</button><span className="project-file-hint">PNG / JPG / WebP / GIF，最大 2 MB</span>{file && <span className="project-file-name" title={file.name}>{file.name}</span>}</div></div>}
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || (iconOnly ? !file : !name.trim())}>{busy ? '保存中…' : '保存'}</button></div>
  </form></div></div>;
}

export default function ProjectsPage({ kind, projects, loading, canManage, onSelect, onRefresh, onCreate, onRename, onUpload, onDelete, onRestore, onListArchived }) {
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const [archived, setArchived] = useState(false);
  const [deleted, setDeleted] = useState([]);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!canManage) { setDialog(null); setArchived(false); setDeleted([]); } }, [canManage]);
  const isCase = kind === 'cases';
  const source = archived ? deleted : projects;
  const visible = source.filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function refreshArchive() {
    setArchiveBusy(true); setError('');
    try { const rows = await onListArchived(); if (alive.current) setDeleted(rows); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setArchiveBusy(false); }
  }
  async function restore(project) {
    setArchiveBusy(true); setError('');
    try { await onRestore(project); if (alive.current) await refreshArchive(); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setArchiveBusy(false); }
  }
  return <section className="workspace-section projects-section"><div className="section-heading"><div><span className="eyebrow">{isCase ? 'CASE LIBRARY' : 'ISSUE TRACKER'}</span><h1>{archived ? '已删除项目组' : isCase ? '测试用例库' : '当前缺陷'}</h1><p>{archived ? '恢复项目组及其关联数据' : '选择项目组'}</p></div><div className="heading-actions"><button className="icon-button" type="button" aria-label="刷新项目组" title="刷新项目组" disabled={loading || archiveBusy} onClick={archived ? refreshArchive : onRefresh}><RefreshCw size={17} className={loading || archiveBusy ? 'spin' : ''} /></button>{canManage && <>{archived ? <button className="button secondary" onClick={() => { setArchived(false); setError(''); }}><ArrowLeft size={16} />返回项目组</button> : <><button className="button secondary" onClick={() => { setArchived(true); refreshArchive(); }}><Trash2 size={16} />已删除项目组</button><button type="button" className="button primary" onClick={() => setDialog({})}><Plus size={17} />新建项目组</button></>}</>}</div></div>
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}
    <div className="projects-toolbar"><div className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索项目组" placeholder="搜索项目组" /></div><span>{visible.length} 个项目组</span></div>
    {(loading || archiveBusy) && !source.length ? <div className="loading-state"><RefreshCw size={18} className="spin" />加载项目组…</div> : !visible.length ? <div className="empty-state"><div className="empty-icon"><Folder size={26} /></div><h3>{source.length ? '没有匹配的项目组' : archived ? '没有已删除项目组' : '暂无项目组'}</h3>{!source.length && canManage && !archived && <button type="button" className="button secondary" onClick={() => setDialog({})}><Plus size={16} />新建项目组</button>}</div> : <div className="project-grid">{visible.map((project) => <article className="project-item" key={project.id}><button type="button" className="project-open" disabled={archived} onClick={() => onSelect(project)} aria-label={`进入项目组 ${project.name}`}><ProjectIcon project={project} /><span className="project-item-text"><strong>{project.name}</strong><span>{isCase ? project.caseCount ?? '—' : project.defectCount ?? '—'} {isCase ? '个用例集' : '条缺陷'}</span></span>{!archived && <ChevronRight size={18} />}</button>{canManage && <div className="project-item-actions">{archived ? <button className="icon-button" type="button" title={`恢复 ${project.name}`} aria-label={`恢复 ${project.name}`} disabled={archiveBusy} onClick={() => restore(project)}><RotateCcw size={17} /></button> : <><button className="icon-button" type="button" title={`重命名 ${project.name}`} aria-label={`重命名 ${project.name}`} onClick={() => setDialog({ project })}><Pencil size={16} /></button><button className="icon-button" type="button" title={`上传 ${project.name} 的图标`} aria-label={`上传 ${project.name} 的图标`} onClick={() => setDialog({ project, iconOnly: true })}><ImagePlus size={17} /></button><button className="icon-button danger" type="button" title={`删除项目组 ${project.name}`} aria-label={`删除项目组 ${project.name}`} onClick={() => setDialog({ project, delete: true })}><Trash2 size={16} /></button></>}</div>}</article>)}</div>}
    {dialog && canManage && (dialog.delete ? <DeleteProjectDialog project={dialog.project} onClose={() => setDialog(null)} onDelete={onDelete} /> : <ProjectDialog initial={dialog.project} iconOnly={dialog.iconOnly} onClose={() => setDialog(null)} onCreate={onCreate} onRename={onRename} onUpload={onUpload} onRefresh={onRefresh} />)}
  </section>;
}
