import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronRight, CloudUpload, FileText, FolderInput, FolderOpen,
  FolderPlus, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { collectDroppedItems, collectSelectedItems, uploadFolderPaths } from './cloud-upload.js';
import './CloudFilesPage.css';

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...options,
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `请求失败 (${response.status})`), { status: response.status });
  return data;
}

function displaySize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function IconButton({ icon: Icon, label, onClick, danger = false, disabled = false }) {
  return <button type="button" className={`icon-button ${danger ? 'danger' : ''}`} onClick={onClick}
    disabled={disabled} title={label} aria-label={label}><Icon size={17} /></button>;
}

export default function CloudFilesPage({ canWrite, refreshToken, showError, onNotice }) {
  const [folderId, setFolderId] = useState(null);
  const [listing, setListing] = useState({ files: [], folders: [], path: [], allFolders: [] });
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState('');
  const [targetId, setTargetId] = useState('');
  const fileInput = useRef(null);
  const folderInput = useRef(null);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    request(`/api/files${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`)
      .then((data) => { if (!canceled) setListing(data); })
      .catch((error) => {
        if (canceled) return;
        if (error.status === 404 && folderId) setFolderId(null);
        else showError(error.message);
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [folderId, refresh, refreshToken, showError]);

  const destinations = useMemo(() => {
    const byId = new Map(listing.allFolders.map((folder) => [folder.id, folder]));
    const label = (folder) => {
      const segments = [folder.name];
      let parent = byId.get(folder.parentId);
      while (parent) { segments.unshift(parent.name); parent = byId.get(parent.parentId); }
      return segments.join(' / ');
    };
    return listing.allFolders.map((folder) => ({ id: folder.id, name: label(folder) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [listing.allFolders]);

  async function uploadItems(itemsPromise) {
    if (busy) return;
    setBusy(true);
    let completed = 0;
    let createdFolders = 0;
    try {
      const items = await itemsPromise;
      if (!items.files.length && !items.folders.length) throw new Error('未读取到文件或文件夹，请使用 Chrome / Edge 重新拖入，或点击上传文件夹');
      setUploadProgress({ completed: 0, total: items.files.length });
      const listing = await request('/api/files');
      const known = new Map(listing.allFolders.map((folder) => [`${folder.parentId || ''}\0${folder.name.toLowerCase()}`, folder.id]));
      const ids = new Map([['', folderId]]);
      for (const relativePath of uploadFolderPaths(items)) {
        const parts = relativePath.split('/');
        const parent = ids.get(parts.slice(0, -1).join('/'));
        const name = parts.at(-1);
        const key = `${parent || ''}\0${name.toLowerCase()}`;
        let id = known.get(key);
        if (!id) {
          try {
            const result = await request('/api/files/folders', { method: 'POST', body: JSON.stringify({ name, parentId: parent }) });
            id = result.folder.id;
            createdFolders += 1;
          } catch (error) {
            if (error.status !== 409) throw error;
            const refreshed = await request('/api/files');
            id = refreshed.allFolders.find((folder) => folder.parentId === parent && folder.name.toLowerCase() === name.toLowerCase())?.id;
            if (!id) throw error;
          }
          known.set(key, id);
        }
        ids.set(relativePath, id);
      }
      const groups = new Map();
      for (const item of items.files) {
        const directory = item.relativePath.split('/').slice(0, -1).join('/');
        if (!groups.has(directory)) groups.set(directory, []);
        groups.get(directory).push(item.file);
      }
      for (const [directory, files] of groups) {
        const target = ids.get(directory);
        for (let index = 0; index < files.length; index += 24) {
          const batch = files.slice(index, index + 24);
          const body = new FormData();
          for (const file of batch) body.append('file', file);
          await request(`/api/files${target ? `?folderId=${encodeURIComponent(target)}` : ''}`, { method: 'POST', body });
          completed += batch.length;
          setUploadProgress({ completed, total: items.files.length });
        }
      }
      onNotice(`已上传 ${completed} 个文件${createdFolders ? `，创建 ${createdFolders} 个文件夹` : ''}`);
    } catch (error) { showError(completed ? `已上传 ${completed} 个文件，后续处理失败：${error.message}` : error.message); }
    finally {
      setBusy(false);
      setUploadProgress(null);
      if (completed || createdFolders) setRefresh((value) => value + 1);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.type === 'move') {
        await request(`/api/files/${encodeURIComponent(dialog.file.id)}`, {
          method: 'PATCH', body: JSON.stringify({ folderId: targetId || null }),
        });
        onNotice('文件已移动');
      } else {
        const creating = dialog.type === 'create';
        await request(creating ? '/api/files/folders' : `/api/files/folders/${encodeURIComponent(dialog.folder.id)}`, {
          method: creating ? 'POST' : 'PUT',
          body: JSON.stringify(creating ? { name: name.trim(), parentId: folderId } : { name: name.trim() }),
        });
        onNotice(creating ? '文件夹已创建' : '文件夹已重命名');
      }
      setDialog(null); setRefresh((value) => value + 1);
    } catch (error) { showError(error.message); }
    finally { setBusy(false); }
  }

  async function remove(item, type) {
    if (!window.confirm(`确定删除“${item.name}”吗？${type === 'folder' ? '只能删除空文件夹。' : '此操作无法撤销。'}`)) return;
    setBusy(true);
    try {
      await request(type === 'folder' ? `/api/files/folders/${encodeURIComponent(item.id)}` : `/api/files/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      onNotice(type === 'folder' ? '文件夹已删除' : '文件已删除'); setRefresh((value) => value + 1);
    } catch (error) { showError(error.message); }
    finally { setBusy(false); }
  }

  const total = listing.folders.length + listing.files.length;
  return <section className="workspace-section files-section cloud-files-section">
    <div className="section-heading"><div><span className="eyebrow">TEAM FILES</span><h1>测试工具云盘</h1><p>共享安装包、测试工具与团队资料</p></div>
      <div className="heading-actions"><IconButton icon={RefreshCw} label="刷新" onClick={() => setRefresh((value) => value + 1)} disabled={loading} />
        {canWrite && <><button className="button secondary" type="button" onClick={() => { setName(''); setDialog({ type: 'create' }); }} disabled={busy}><FolderPlus size={17} /> 新建文件夹</button>
          <button className="button secondary" type="button" onClick={() => folderInput.current?.click()} disabled={busy}><FolderOpen size={17} /> 上传文件夹</button>
          <button className="button primary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}><Upload size={17} /> 上传文件</button></>}</div></div>
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => uploadItems(Promise.resolve(collectSelectedItems(event.target.files)))} />
    <input ref={folderInput} type="file" multiple webkitdirectory="" directory="" hidden onChange={(event) => uploadItems(Promise.resolve(collectSelectedItems(event.target.files)))} />
    <nav className="cloud-breadcrumbs" aria-label="云盘目录"><button type="button" onClick={() => setFolderId(null)} aria-current={folderId === null ? 'page' : undefined}>团队文件</button>
      {listing.path.map((folder) => <React.Fragment key={folder.id}><ChevronRight size={15} /><button type="button" onClick={() => setFolderId(folder.id)} aria-current={folder.id === folderId ? 'page' : undefined}>{folder.name}</button></React.Fragment>)}</nav>
    {canWrite && <div className={`upload-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; if (!busy) setDragging(true); }}
      onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) uploadItems(collectDroppedItems(event.dataTransfer)); }}>
      <div className="upload-icon"><CloudUpload size={24} /></div><div><strong>{uploadProgress ? `已上传 ${uploadProgress.completed} / ${uploadProgress.total} 个文件` : busy ? '正在处理…' : '拖放文件或文件夹到这里'}</strong><span>或 <button type="button" className="text-button" onClick={() => fileInput.current?.click()} disabled={busy}>选择文件</button>、<button type="button" className="text-button" onClick={() => folderInput.current?.click()} disabled={busy}>选择文件夹</button> 上传到当前文件夹</span></div></div>}
    <div className="table-surface files-table"><div className="files-table-title"><h2>{listing.path.at(-1)?.name || '团队文件'}</h2><span>{listing.folders.length} 个文件夹 · {listing.files.length} 个文件</span></div>
      {loading && total === 0 ? <div className="loading-state"><RefreshCw size={18} className="spin" /> 加载中…</div>
        : total === 0 ? <div className="empty-state"><div className="empty-icon"><FolderOpen size={26} /></div><h3>当前文件夹为空</h3></div>
          : <div className="table-scroll"><table><thead><tr><th>名称</th><th>大小</th><th>创建人</th><th>创建时间</th><th className="actions-col">操作</th></tr></thead><tbody>
            {listing.folders.map((folder) => <tr key={folder.id}><td><button className="cloud-folder-name" type="button" onClick={() => setFolderId(folder.id)} title={`打开 ${folder.name}`}><span className="file-icon cloud-folder-icon"><FolderOpen size={19} /></span><span>{folder.name}</span></button></td><td>文件夹</td><td>{folder.createdBy}</td><td className="date-cell">{displayDate(folder.createdAt)}</td><td className="actions-col"><div className="row-actions"><IconButton icon={FolderOpen} label={`打开 ${folder.name}`} onClick={() => setFolderId(folder.id)} />{canWrite && <><IconButton icon={Pencil} label={`重命名 ${folder.name}`} disabled={busy} onClick={() => { setName(folder.name); setDialog({ type: 'rename', folder }); }} /><IconButton icon={Trash2} label={`删除 ${folder.name}`} danger disabled={busy} onClick={() => remove(folder, 'folder')} /></>}</div></td></tr>)}
            {listing.files.map((file) => <tr key={file.id}><td><div className="file-name"><span className="file-icon"><FileText size={19} /></span><span title={file.name}>{file.name}</span></div></td><td>{displaySize(file.size)}</td><td>{file.uploadedBy}</td><td className="date-cell">{displayDate(file.createdAt)}</td><td className="actions-col"><div className="row-actions"><a className="icon-button" href={file.downloadUrl} title={`下载 ${file.name}`} aria-label={`下载 ${file.name}`}><ArrowDownToLine size={17} /></a>{canWrite && <><IconButton icon={FolderInput} label={`移动 ${file.name}`} disabled={busy} onClick={() => { setTargetId(file.folderId || ''); setDialog({ type: 'move', file }); }} /><IconButton icon={Trash2} label={`删除 ${file.name}`} danger disabled={busy} onClick={() => remove(file, 'file')} /></>}</div></td></tr>)}
          </tbody></table></div>}</div>
    {dialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialog(null); }}><div className="modal cloud-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
      <div className="modal-head"><h2 id="cloud-dialog-title">{dialog.type === 'move' ? `移动 ${dialog.file.name}` : dialog.type === 'rename' ? '重命名文件夹' : '新建文件夹'}</h2><IconButton icon={X} label="关闭" onClick={() => setDialog(null)} disabled={busy} /></div>
      <form className="modal-form" onSubmit={submitDialog}>{dialog.type === 'move'
        ? <label className="field"><span>目标文件夹</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">团队文件（根目录）</option>{destinations.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label>
        : <label className="field"><span>文件夹名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></label>}
        <div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button primary" type="submit" disabled={busy || (dialog.type === 'move' ? targetId === (dialog.file.folderId || '') : !name.trim())}>{busy ? '处理中…' : '确定'}</button></div></form>
    </div></div>}
  </section>;
}
