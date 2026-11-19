import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { forgetLogin, readRememberedLogin, rememberLogin } from './remembered-login';
import ProjectsPage, { ProjectContext, ProjectIcon } from './Projects';
import CaseSetsPage from './CaseSetsPage';
import DefectsPage from './DefectsPage';
import { DEFECT_TYPES, defectTypeClass } from './defect-types';
import AiWorkspace from './AiWorkspace';
import CodeAuditPage from './CodeAuditPage';
import CloudFilesPage from './CloudFilesPage';
import BrandMark from './BrandMark';
import VersionHistory from './VersionHistory';
import { RequirementsPage, KnowledgePage } from './WorkspaceDocuments';
import { DEFECT_STATUSES, defectStatusClass } from './defect-status';
import {
  AlertCircle, ArrowUpRight, Bot, Bug, Check, Copy,
  ChevronDown, ChevronRight, CircleHelp, Database,
  Eye, EyeOff, FileText, Filter, FolderOpen, ImagePlus, LayoutDashboard, LogOut, Menu, ScanSearch,
  PanelLeftClose, PanelLeftOpen, Pencil, Plus,
  RefreshCw, Search, ShieldCheck, Sparkles, Trash2,
  Users, Wifi, WifiOff, X, KeyRound,
} from 'lucide-react';

const NAV = [
  { id: 'requirements', label: '需求管理', icon: FileText },
  { id: 'knowledge', label: '项目知识库', icon: FolderOpen },
  { id: 'cases', label: '测试用例库', icon: Database },
  { id: 'defects', label: '当前缺陷', icon: Bug },
  { id: 'ai', label: 'AI 用例生成', icon: Sparkles },
  { id: 'audit', label: 'AI 代码巡检', icon: ScanSearch },
  { id: 'files', label: '测试工具云盘', icon: FolderOpen },
];

const CASE_FIELDS = [
  { key: 'title', label: '用例标题', required: true, placeholder: '例如：活动结算后奖励正确入账', wide: true },
  { key: 'module', label: '所属模块', required: true, placeholder: '例如：活动中心' },
  { key: 'priority', label: '优先级', type: 'select', options: ['P0', 'P1', 'P2', 'P3'] },
  { key: 'status', label: '执行状态', type: 'select', options: ['未执行', '通过', '失败', '阻塞'] },
  { key: 'preconditions', label: '前置条件', type: 'textarea', placeholder: '账号、环境、数据准备等', wide: true },
  { key: 'steps', label: '操作步骤', type: 'textarea', required: true, placeholder: '逐步描述执行操作', wide: true },
  { key: 'expected', label: '预期结果', type: 'textarea', required: true, placeholder: '每一步或最终应出现的结果', wide: true },
  { key: 'tags', label: '标签', placeholder: '多个标签以逗号分隔', wide: true },
  { key: 'notes', label: '备注', type: 'textarea', placeholder: '补充信息', wide: true },
];

const DEFECT_FIELDS = [
  { key: 'title', label: '缺陷标题', placeholder: '简要描述问题', wide: true },
  { key: 'issueType', label: '问题类型', type: 'select', options: DEFECT_TYPES },
  { key: 'module', label: '所属模块', placeholder: '例如：活动中心' },
  { key: 'version', label: '发现版本', placeholder: '例如：1.0.0' },
  { key: 'severity', label: '严重程度', type: 'select', options: ['致命', '严重', '一般', '轻微'] },
  { key: 'status', label: '处理状态', type: 'select', options: DEFECT_STATUSES },
  { key: 'assignee', label: '负责人', placeholder: '姓名或账号' },
  { key: 'reproSteps', label: '复现步骤', type: 'textarea', placeholder: '环境、前置条件和复现路径', wide: true },
  { key: 'expected', label: '预期表现', type: 'textarea', placeholder: '正确行为', wide: true },
  { key: 'actual', label: '实际表现', type: 'textarea', placeholder: '实际发生的问题', wide: true },
  { key: 'notes', label: '备注', type: 'textarea', placeholder: '截图、日志路径等补充说明', wide: true },
];

const EMPTY_CASE = {
  title: '', module: '', priority: 'P2', status: '未执行',
  preconditions: '', steps: '', expected: '', tags: '', notes: '',
};
const EMPTY_DEFECT = {
  issueType: '版本问题', title: '', module: '', version: '', severity: '一般', status: '待处理',
  assignee: '', reproSteps: '', expected: '', actual: '', notes: '',
};
const DEFECT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFECT_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp)$/i;
const DEFECT_IMAGE_BYTES = 20 * 1024 * 1024;

const defectVersionKey = (userId, projectId) => `qzz-defect-version:${userId}:${projectId}`;
function lastDefectVersion(userId, projectId) {
  try { return localStorage.getItem(defectVersionKey(userId, projectId)) || ''; }
  catch { return ''; }
}
function rememberDefectVersion(userId, projectId, version) {
  if (!version?.trim()) return;
  try { localStorage.setItem(defectVersionKey(userId, projectId), version.trim()); }
  catch { /* Storage can be unavailable in private browsing; saving the defect still succeeds. */ }
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? options.headers
    : { 'Content-Type': 'application/json', ...options.headers };
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error?.message || (typeof data.error === 'string' ? data.error : null);
    const error = new Error(message || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function displayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function prepareGenerated(record, module) {
  const priority = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' }[record.priority] || record.priority || 'P2';
  return { ...record, module: record.module || module, priority, status: '未执行' };
}

function Tone({ children, value }) {
  const text = String(value || children || '');
  const statusClass = defectStatusClass(text);
  if (statusClass) return <span className={`tone ${statusClass}`}>{children || value}</span>;
  let tone = 'neutral';
  if (/^(P0|致命|失败)$/.test(text)) tone = 'danger';
  else if (/^(P1|严重|阻塞|待处理)$/.test(text)) tone = 'warning';
  else if (/^(通过|已解决|已关闭)$/.test(text)) tone = 'success';
  else if (/^(处理中|待验证)$/.test(text)) tone = 'info';
  return <span className={`tone tone-${tone}`}>{children || value || '—'}</span>;
}

function IconButton({ icon: Icon, label, onClick, danger = false, disabled = false, className = '' }) {
  return <button type="button" className={`icon-button ${danger ? 'danger' : ''} ${className}`} onClick={onClick} disabled={disabled} title={label} aria-label={label}><Icon size={17} strokeWidth={1.9} /></button>;
}

function Empty({ icon: Icon, title, detail, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={26} strokeWidth={1.6} /></div><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>;
}

function Login({ onLogin, busy, error }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [register, setRegister] = useState(false);
  const [remember, setRemember] = useState(false);
  const [localError, setLocalError] = useState('');
  useEffect(() => { let alive = true; readRememberedLogin().then((saved) => { if (saved && alive) { setUsername(saved.username); setPassword(saved.password); setRemember(true); } }); return () => { alive = false; }; }, []);
  async function submit(event) {
    event.preventDefault(); setLocalError('');
    if (register && password !== confirmPassword) { setLocalError('两次输入的密码不一致'); return; }
    await onLogin(username.trim(), password, remember, register);
  }
  return <div className="login-page">
    <div className="login-top"><BrandMark /><span>QZZ <strong>公共测试平台</strong></span></div>
    <main className="login-main">
      <div className="login-intro"><span className="eyebrow">INTERNAL WORKSPACE</span><h1>游戏测试协作平台</h1><p>用例、缺陷与工具集中管理，团队进度实时同步。</p></div>
      <form className="login-panel" onSubmit={submit}>
        <div className="login-panel-title"><ShieldCheck size={22} /><div><h2>{register ? '注册账号' : '登录工作区'}</h2><span>{register ? '创建团队成员账号' : '使用平台账号访问'}</span></div></div>
        <div className="auth-tabs"><button type="button" className={!register ? 'selected' : ''} disabled={busy} onClick={() => { setRegister(false); setLocalError(''); }}>登录</button><button type="button" className={register ? 'selected' : ''} disabled={busy} onClick={() => { setRegister(true); setPassword(''); setLocalError(''); }}>注册账号</button></div>
        <label className="field"><span>账号</span><input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={register ? '2-32 位文字、数字或 ._-' : '请输入账号'} minLength={register ? 2 : undefined} maxLength={32} required /></label>
        <label className="field"><span>密码</span><input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={register ? '设置至少 6 位密码' : '请输入密码'} minLength={register ? 6 : undefined} maxLength={200} required /></label>
        {register && <label className="field"><span>确认密码</span><input name="confirmPassword" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={6} maxLength={200} placeholder="再次输入密码" required /></label>}
        <label className="check-field"><input type="checkbox" checked={remember} onChange={(event) => { setRemember(event.target.checked); if (!event.target.checked) forgetLogin().catch(() => setLocalError('无法清除记录，请检查浏览器存储权限')); }} /><span>在此浏览器记住账号和密码</span></label>
        {(localError || error) && <div className="inline-error"><AlertCircle size={16} />{localError || error}</div>}
        <button className="button primary login-submit" type="submit" disabled={busy || !username.trim() || !password}>{busy ? '正在处理…' : <>{register ? '注册并进入' : '进入平台'} <ArrowUpRight size={17} /></>}</button>
      </form>
    </main>
    <div className="login-bottom"><VersionHistory /><span>QZZ · 仅供内部测试协作使用</span></div>
  </div>;
}

function RecordForm({ kind, initial, mode, project, userId, onClose, onSave, busy, error, onReload }) {
  const fields = kind === 'cases' ? CASE_FIELDS : DEFECT_FIELDS;
  const [values, setValues] = useState(() => ({ ...(kind === 'cases' ? EMPTY_CASE : { ...EMPTY_DEFECT, version: mode === 'new' ? lastDefectVersion(userId, project.id) : '' }), ...initial, tags: Array.isArray(initial?.tags) ? initial.tags.join(', ') : initial?.tags || '' }));
  const [members, setMembers] = useState([]);
  const [pendingImages, setPendingImages] = useState([]);
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef(null);
  const imageUrls = useRef(new Set());
  const imageSequence = useRef(0);
  const dragDepth = useRef(0);
  const title = kind === 'cases' ? '用例' : '缺陷';
  useEffect(() => {
    if (kind !== 'defects') return undefined;
    let active = true;
    api('/api/members').then((result) => { if (active) setMembers(result.members || []); }).catch(() => {});
    return () => { active = false; };
  }, [kind]);
  useEffect(() => () => { for (const url of imageUrls.current) URL.revokeObjectURL(url); }, []);
  function addImages(items) {
    if (kind !== 'defects' || busy) return;
    const files = Array.from(items || []);
    if (!files.length) return;
    if (files.some((file) => !(DEFECT_IMAGE_TYPES.has(file.type) || (!file.type && DEFECT_IMAGE_EXTENSIONS.test(file.name))))) {
      setImageError('图片仅支持 PNG、JPEG、WebP'); return;
    }
    if (files.some((file) => !file.size || file.size > DEFECT_IMAGE_BYTES)) {
      setImageError('单张图片须小于 20 MB 且不能是空文件'); return;
    }
    if (pendingImages.length + files.length > 12 || (initial?.images?.length || 0) + pendingImages.length + files.length > 24) {
      setImageError('每次最多上传 12 张，每条缺陷最多保留 24 张图片'); return;
    }
    const added = files.map((file) => {
      const url = URL.createObjectURL(file);
      imageUrls.current.add(url);
      return { key: ++imageSequence.current, file, url };
    });
    setPendingImages((current) => [...current, ...added]);
    setImageError('');
  }
  function removePendingImage(key) {
    setPendingImages((current) => {
      const removed = current.find((image) => image.key === key);
      if (removed) { URL.revokeObjectURL(removed.url); imageUrls.current.delete(removed.url); }
      return current.filter((image) => image.key !== key);
    });
    setImageError('');
  }
  function hasDraggedFiles(event) { return kind === 'defects' && Array.from(event.dataTransfer?.types || []).includes('Files'); }
  function enterDrag(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault(); dragDepth.current += 1; setDragging(true);
  }
  function leaveDrag(event) {
    if (kind !== 'defects' || !dragDepth.current) return;
    event.preventDefault(); dragDepth.current -= 1;
    if (!dragDepth.current) setDragging(false);
  }
  function dropImages(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    addImages(event.dataTransfer.files);
  }
  function submit(event) {
    event.preventDefault();
    const data = { ...values };
    if (kind === 'cases') data.tags = values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    else delete data.images;
    onSave(data, pendingImages.map((image) => image.file));
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="form-title" onDragEnter={enterDrag} onDragOver={(event) => { if (hasDraggedFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDragLeave={leaveDrag} onDrop={dropImages}>
      <div className="modal-head"><div><span className="eyebrow">{mode === 'edit' ? 'EDIT RECORD' : 'NEW RECORD'}</span><h2 id="form-title">{mode === 'edit' ? `编辑${title}` : `新建${title}`}</h2></div><IconButton icon={X} label="关闭" onClick={onClose} disabled={busy} /></div>
      <form onSubmit={submit} className="modal-form">
        {project && <div className="record-form-project"><ProjectIcon project={project} small /><span>{project.name}</span></div>}
        <div className="form-grid">{fields.map((field) => <label key={field.key} className={`field ${field.wide ? 'field-wide' : ''}`}><span>{field.label}{field.required && <em> *</em>}</span>
          {field.type === 'textarea'
            ? <textarea value={values[field.key] ?? ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.placeholder} rows={field.key === 'steps' || field.key === 'reproSteps' ? 4 : 3} required={field.required} />
            : field.type === 'select'
              ? <select className={kind === 'defects' && field.key === 'status' ? defectStatusClass(values[field.key] || field.options[0]) : undefined} value={values[field.key] || field.options[0]} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}>{field.options.map((option) => <option key={option}>{option}</option>)}</select>
              : <input value={values[field.key] ?? ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.placeholder} required={field.required} list={kind === 'defects' && field.key === 'assignee' ? 'defect-member-usernames' : undefined} autoComplete={kind === 'defects' && field.key === 'assignee' ? 'off' : undefined} />}
        </label>)}</div>
        {kind === 'defects' && <>
          <datalist id="defect-member-usernames">{members.map((member) => <option key={member.id} value={member.username} />)}</datalist>
          <section className={`defect-image-section ${dragging ? 'dragging' : ''}`} aria-label="缺陷图片">
            <div className="defect-image-heading"><strong>图片</strong><button className="button secondary" type="button" disabled={busy} onClick={() => imageInput.current?.click()}><ImagePlus size={16} />添加图片</button></div>
            <input ref={imageInput} className="defect-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} aria-label="选择缺陷图片" onChange={(event) => { addImages(event.target.files); event.target.value = ''; }} />
            {(initial?.images?.length || pendingImages.length) ? <div className="defect-image-grid">
              {(initial?.images || []).map((image) => <div className="defect-image-item" key={image.id}><a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`查看图片 ${image.name}`}><img src={image.thumbnailUrl || image.url} alt={image.name} /></a><span title={image.name}>{image.name}</span></div>)}
              {pendingImages.map((image) => <div className="defect-image-item" key={image.key}><a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`预览图片 ${image.file.name}`}><img src={image.url} alt={image.file.name} /></a><span title={image.file.name}>{image.file.name}</span><IconButton icon={X} label={`移除 ${image.file.name}`} className="defect-image-remove" disabled={busy} onClick={() => removePendingImage(image.key)} /></div>)}
            </div> : <div className="defect-image-empty"><ImagePlus size={22} aria-hidden="true" /></div>}
          </section>
        </>}
        {imageError && <div className="inline-error"><AlertCircle size={16} /><span>{imageError}</span></div>}
        {error && <div className="inline-error"><AlertCircle size={16} /><span>{error}</span>{error.includes('最新') && <button type="button" className="text-button" onClick={onReload}>查看最新记录</button>}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存'}</button></div>
      </form>
    </div>
  </div>;
}

function RecordDetail({ kind, record, onClose, onEdit, onDelete, onDeleteImage, canWrite }) {
  const fields = kind === 'cases' ? CASE_FIELDS : DEFECT_FIELDS;
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="detail-drawer" aria-label={kind === 'cases' ? '用例详情' : '缺陷详情'}>
      <div className="drawer-head"><div><span className="eyebrow">{kind === 'cases' ? 'TEST CASE' : 'DEFECT'}</span><span className="record-id">#{String(record.id).slice(0, 8)}</span></div><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      <div className="drawer-body"><h2 className={kind === 'defects' ? 'defect-detail-title' : undefined}>{kind === 'defects' && <span className={`defect-type-tag ${defectTypeClass(record.issueType)}`}>{record.issueType || '版本问题'}</span>}<span>{record.title || (kind === 'defects' ? '未命名缺陷' : '未命名用例')}</span></h2><div className="detail-pills"><Tone value={kind === 'cases' ? record.priority : record.severity} /><Tone value={record.status} /><span className="detail-module">{record.module || '未分类'}</span></div>
        <div className="detail-grid"><div><span>创建人</span><strong>{record.createdBy || '—'}</strong></div><div><span>更新时间</span><strong>{displayDate(record.updatedAt || record.createdAt)}</strong></div></div>
        <div className="detail-fields">{fields.filter((field) => !['title', 'module', 'priority', 'severity', 'status', 'issueType'].includes(field.key)).map((field) => <div key={field.key} className="detail-field"><span>{field.label}</span><p>{field.key === 'tags' ? (Array.isArray(record.tags) ? record.tags.join(' · ') : record.tags) || '—' : record[field.key] || '—'}</p></div>)}</div>
        {kind === 'defects' && Boolean(record.images?.length) && <section className="defect-detail-images" aria-label="缺陷图片"><h3>图片</h3><div className="defect-image-grid">{record.images.map((image) => <div className="defect-image-item" key={image.id}><a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`查看图片 ${image.name}`}><img src={image.thumbnailUrl || image.url} alt={image.name} /></a><span title={image.name}>{image.name}</span>{canWrite && <IconButton icon={Trash2} label={`删除图片 ${image.name}`} className="defect-image-remove" onClick={() => onDeleteImage(record, image)} />}</div>)}</div></section>}
      </div>
      {canWrite && <div className="drawer-actions"><button className="button secondary" type="button" onClick={onDelete}><Trash2 size={16} /> 删除</button><button className="button primary" type="button" onClick={onEdit}><Pencil size={16} /> 编辑</button></div>}
    </aside>
  </div>;
}


function permitted(user, module, action = 'view') {
  if (module === 'audit') return permitted(user, 'ai', action) && permitted(user, 'cases', 'view');
  return user?.role === 'admin' || Boolean(user?.permissions?.[module]?.[action]);
}

function PasswordDialog({ onClose, onSaved }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError('');
    if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      const saved = await readRememberedLogin();
      if (saved) await forgetLogin().catch(() => {});
      onSaved();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="password-title"><div className="modal-head"><h2 id="password-title">修改我的密码</h2><IconButton icon={X} label="关闭" onClick={onClose} disabled={busy} /></div><form className="modal-form account-form" onSubmit={submit}><label className="field"><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrent(event.target.value)} required maxLength={200} /></label><label className="field"><span>新密码</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNew(event.target.value)} required minLength={6} maxLength={200} placeholder="至少 6 位" /></label><label className="field"><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={6} maxLength={200} /></label>{error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}<div className="modal-actions"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存密码'}</button></div></form></div></div>;
}

function UsersDialog({ onClose, onChanged }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState(null);
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [revealed, setRevealed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  async function load() { const data = await api('/api/users'); setUsers(data.users || []); }
  useEffect(() => { load().catch((failure) => setError(failure.message)).finally(() => setLoading(false)); }, []);
  function select(member) { setSelected(member.id); setDraft(structuredClone(member)); setPassword(''); setAdminPassword(''); setRevealed(null); setMessage(''); setError(''); setCreating(false); }
  function permission(module, action, value) {
    setDraft((old) => { const permissions = structuredClone(old.permissions || {}); permissions[module] = { view: false, write: false, ...permissions[module], [action]: value }; if (action === 'write' && value) permissions[module].view = true; if (action === 'view' && !value) permissions[module].write = false; return { ...old, permissions }; });
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (creating) {
        await api('/api/users', { method: 'POST', body: JSON.stringify({ username: newUsername.trim(), password }) });
        setCreating(false); setNewUsername(''); setPassword(''); setMessage('成员账号已创建');
      } else {
        await api(`/api/users/${encodeURIComponent(selected)}`, { method: 'PUT', body: JSON.stringify({ role: draft.role, disabled: Boolean(draft.disabled), permissions: draft.permissions, ...(password ? { password } : {}) }) });
        setPassword(''); setRevealed(null); setMessage('账号和权限已保存');
      }
      await load(); await onChanged();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function reveal() {
    setBusy(true); setError(''); setRevealed(null);
    try { const result = await api(`/api/users/${encodeURIComponent(selected)}/reveal-password`, { method: 'POST', body: JSON.stringify({ currentPassword: adminPassword }) }); setRevealed(result.available ? result.password : '旧账号密码无法查看，请先设置新密码。'); setAdminPassword(''); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function removeMember() {
    if (!draft || !window.confirm(`确定删除成员账号“${draft.username}”吗？该账号将立即退出并无法恢复，历史记录会保留为已删除成员。`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/users/${encodeURIComponent(selected)}`, { method: 'DELETE' });
      setSelected(''); setDraft(null); setPassword(''); setAdminPassword(''); setRevealed(null);
      await load(); await onChanged(); setMessage('成员账号已删除，历史记录已保留');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal users-modal account-users-modal" role="dialog" aria-modal="true" aria-labelledby="users-title"><div className="modal-head"><div><span className="eyebrow">TEAM ACCESS</span><h2 id="users-title">账号与权限管理</h2></div><IconButton icon={X} label="关闭" onClick={onClose} disabled={busy} /></div><div className="users-content"><div className="users-list-title"><h3>成员账号 · {users.length}</h3><button type="button" className="button secondary" disabled={busy} onClick={() => { setCreating(true); setDraft(null); setSelected(''); setPassword(''); setRevealed(null); setError(''); setMessage(''); }}><Plus size={15} />创建账号</button></div>{loading ? <div className="loading-state">加载中…</div> : <div className="member-picker">{users.map((member) => <button type="button" disabled={busy} key={member.id} className={`member-option ${selected === member.id ? 'selected' : ''}`} onClick={() => select(member)}><span className="avatar">{member.username.slice(0, 1).toUpperCase()}</span><strong>{member.username}</strong><span>{member.disabled ? '已停用' : member.role === 'admin' ? '管理员' : '成员'}</span></button>)}</div>}
      {(creating || draft) && <form className="account-editor" onSubmit={save}><h3>{creating ? '创建成员账号' : `管理 ${draft.username}`}</h3>{creating ? <label className="field"><span>账号</span><input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} minLength={2} maxLength={32} required autoComplete="off" /></label> : <div className="user-form-row"><label className="field"><span>账号角色</span><select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} disabled={busy}><option value="member">普通成员</option><option value="admin">管理员</option></select></label><label className="check-field"><input type="checkbox" checked={Boolean(draft.disabled)} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} disabled={busy} /><span>停用账号</span></label></div>}
      {!creating && <div className="permissions-table"><div className="permission-row permission-head"><span>模块权限</span><span>查看</span><span>编辑 / 操作</span></div>{NAV.filter((module) => module.id !== 'audit').map((module) => <div className="permission-row" key={module.id}><span>{module.label}</span>{['view', 'write'].map((action) => <input key={action} type="checkbox" aria-label={`${module.label}${action === 'view' ? '查看' : '编辑'}`} checked={draft.role === 'admin' || Boolean(draft.permissions?.[module.id]?.[action])} disabled={busy || draft.role === 'admin'} onChange={(event) => permission(module.id, action, event.target.checked)} />)}</div>)}</div>}
      <label className="field"><span>{creating ? '初始密码' : '设置新密码（留空则保留）'}</span><input type="password" autoComplete="new-password" minLength={6} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} required={creating} placeholder="至少 6 位" disabled={busy} /></label><div className="modal-actions">{!creating && draft.role === 'member' && users.find((member) => member.id === selected)?.role === 'member' && <button type="button" className="button secondary account-delete" disabled={busy} onClick={removeMember}><Trash2 size={16} />删除成员</button>}<button className="button primary" disabled={busy}>{busy ? '保存中…' : creating ? '创建账号' : '保存账号与权限'}</button></div></form>}
      {draft && !creating && <div className="password-reveal"><h3>查看账号密码</h3>{revealed !== null ? <div className="revealed-password"><code>{revealed}</code><IconButton icon={EyeOff} label="隐藏密码" onClick={() => setRevealed(null)} /></div> : <div className="reveal-controls"><label className="field"><span>验证当前管理员密码</span><input type="password" autoComplete="current-password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} maxLength={200} /></label><button type="button" className="button secondary" disabled={busy || !adminPassword} onClick={reveal}><Eye size={16} />查看密码</button></div>}</div>}
      {message && <div className="account-success" role="status"><Check size={16} />{message}</div>}{error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    </div></div></div>;
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [config, setConfig] = useState({ aiConfigured: false });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [active, setActive] = useState('cases');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('qzz-sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connection, setConnection] = useState('connecting');
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [cases, setCases] = useState([]);
  const [defects, setDefects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [usersOpen, setUsersOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [aiRequirement, setAiRequirement] = useState(null);
  const [caseRequirementFilter, setCaseRequirementFilter] = useState(null);
  const contextRef = useRef({ user, active, projectId: selectedProjectId });
  const authEpoch = useRef(0);
  const scopeEpoch = useRef(0);
  const loadSequence = useRef(0);
  contextRef.current = { user, active, projectId: selectedProjectId };

  const changeProject = useCallback((projectId) => {
    scopeEpoch.current += 1; loadSequence.current += 1;
    contextRef.current.projectId = projectId;
    setSelectedProjectId(projectId); setCases([]); setDefects([]);
    setAiRequirement(null); setCaseRequirementFilter(null);
    setDetail(null); setForm(null); setFormError(''); setFormBusy(false); setError('');
  }, []);

  const applyUser = useCallback((next) => {
    const previous = contextRef.current.user;
    if (previous?.id !== next?.id || !next) {
      authEpoch.current += 1;
      changeProject(null); setProjects([]);
      setUsersOpen(false); setPasswordOpen(false);
    } else if (!permitted(next, contextRef.current.active) && contextRef.current.projectId) changeProject(null);
    contextRef.current.user = next;
    setUser((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
  }, [changeProject]);

  useEffect(() => { localStorage.setItem('qzz-sidebar-collapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => {
    if (!user) return;
    if (!permitted(user, active)) {
      const first = NAV.find(({ id }) => permitted(user, id));
      if (first) { contextRef.current.active = first.id; changeProject(null); setActive(first.id); }
    }
    if (user.role !== 'admin') setUsersOpen(false);
    if (form && !permitted(user, form.kind, 'write')) setForm(null);
    if (detail && !permitted(user, detail.kind)) setDetail(null);
  }, [user, active, form, detail, changeProject]);
  useEffect(() => { if (form && !projects.some((project) => project.id === form.projectId)) setForm(null); }, [projects, form]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    api('/api/session').then((data) => applyUser(data.user || null)).catch((failure) => { applyUser(null); setLoginError(failure.message); });
  }, [applyUser]);

  const loadData = useCallback(async () => {
    const snapshot = { ...contextRef.current };
    if (!snapshot.user) return [];
    const auth = authEpoch.current;
    const scope = scopeEpoch.current;
    const sequence = ++loadSequence.current;
    const current = () => authEpoch.current === auth && scopeEpoch.current === scope && loadSequence.current === sequence;
    setLoading(true);
    try {
      const session = await api('/api/session');
      if (!current()) return [];
      const currentUser = session.user;
      if (!currentUser) { applyUser(null); return []; }
      applyUser(currentUser);
      if (!current()) return [];
      const canLoadProjects = currentUser.role === 'admin' || ['cases', 'defects', 'requirements', 'knowledge', 'ai'].some((module) => permitted(currentUser, module));
      const scoped = ['cases', 'defects'].includes(snapshot.active) && snapshot.projectId && permitted(currentUser, snapshot.active);
      const [projectData, recordData] = await Promise.all([
        canLoadProjects ? api('/api/projects') : Promise.resolve({ projects: [] }),
        scoped ? api(`/api/${snapshot.active}?projectId=${encodeURIComponent(snapshot.projectId)}`) : Promise.resolve({}),
      ]);
      if (!current()) return [];
      const latestProjects = projectData.projects || [];
      setProjects(latestProjects);
      if (snapshot.projectId && !latestProjects.some((project) => project.id === snapshot.projectId)) { changeProject(null); return latestProjects; }
      setCases(snapshot.active === 'cases' ? recordData.cases || [] : []);
      setDefects(snapshot.active === 'defects' ? recordData.defects || [] : []);
      setDataVersion((value) => value + 1);
      setError('');
      return latestProjects;
    } catch (failure) {
      if (authEpoch.current === auth && failure.status === 401) applyUser(null);
      else if (current()) setError(failure.message);
      return [];
    } finally { if (current()) setLoading(false); }
  }, [applyUser, changeProject]);

  useEffect(() => { if (user) loadData(); }, [user?.id, active, selectedProjectId, loadData]);

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    let socket;
    let retryTimer;
    const auth = authEpoch.current;
    api('/api/config').then((data) => { if (alive) setConfig(data); }).catch((failure) => { if (alive) setError(failure.message); });
    function connect() {
      if (!alive) return;
      setConnection('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/api/events`);
      socket.onopen = () => { if (alive && authEpoch.current === auth) { setConnection('online'); loadData(); } };
      socket.onmessage = () => { if (alive && authEpoch.current === auth) loadData(); };
      socket.onerror = () => { if (alive) setConnection('offline'); };
      socket.onclose = () => { if (alive) { setConnection('offline'); loadData(); retryTimer = setTimeout(connect, 3000); } };
    }
    connect();
    return () => { alive = false; clearTimeout(retryTimer); socket?.close(); };
  }, [user?.id, loadData]);

  async function login(username, password, remember, register) {
    setLoginBusy(true); setLoginError('');
    try {
      const data = await api(register ? '/api/register' : '/api/session', { method: 'POST', body: JSON.stringify({ username, password, remember }) });
      try { if (remember) await rememberLogin(username, password); else await forgetLogin(); }
      catch { setToast('登录成功，但浏览器未允许保存账号密码'); }
      applyUser(data.user);
    }
    catch (failure) { setLoginError(failure.message); }
    finally { setLoginBusy(false); }
  }
  async function logout() {
    if (!window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return;
    try { await api('/api/session', { method: 'DELETE' }); applyUser(null); }
    catch (failure) { setError(failure.message); }
  }
  function navigate(next) { if (!window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return; contextRef.current.active = next; if (next === 'ai') setAiRequirement(null); changeProject(null); setActive(next); setMobileOpen(false); }
  function selectProject(projectId) { if (window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) changeProject(projectId); }
  function openRequirementAi(requirement) {
    if (!permitted(user, 'ai') || !window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return;
    contextRef.current.active = 'ai'; setAiRequirement(requirement); setCaseRequirementFilter(null); setActive('ai');
  }
  function openRequirementCases(requirementId) {
    if (!permitted(user, 'cases') || !window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return;
    contextRef.current.active = 'cases'; setCaseRequirementFilter(requirementId); setActive('cases');
  }
  function openRequirements() {
    if (!permitted(user, 'requirements') || !window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return;
    contextRef.current.active = 'requirements'; setActive('requirements');
  }
  function openAuditDefect(defectId) {
    if (!permitted(user, 'defects') || !window.dispatchEvent(new Event('qzz-before-navigate', { cancelable: true }))) return;
    contextRef.current.active = 'defects'; changeProject(selectedProjectId); setActive('defects');
    setDetail({ kind: 'defects', id: defectId });
  }
  function openForm(kind, record = null, projectId = selectedProjectId, sourceIndex = null, onSaved = null) {
    if (!projectId || !projects.some((project) => project.id === projectId) || !permitted(user, kind, 'write')) return;
    setForm({ kind, record, projectId, sourceIndex, onSaved }); setDetail(null); setFormError('');
  }
  async function saveForm(values, images = []) {
    setFormBusy(true); setFormError('');
    const submittedForm = form;
    const { kind, record, projectId, sourceIndex, onSaved } = submittedForm;
    const auth = authEpoch.current; const scope = scopeEpoch.current;
    const current = () => authEpoch.current === auth && scopeEpoch.current === scope;
    try {
      const isEdit = Boolean(record?.id);
      const payload = { ...values, projectId };
      if (isEdit) payload.revision = record.revision;
      else delete payload.revision;
      const body = kind === 'defects' && images.length ? new FormData() : JSON.stringify(payload);
      if (body instanceof FormData) {
        body.append('payload', JSON.stringify(payload));
        for (const image of images) body.append('image', image, image.name);
      }
      await api(`/api/${kind}${isEdit ? `/${encodeURIComponent(record.id)}` : ''}`, { method: isEdit ? 'PUT' : 'POST', body });
      if (!current()) return;
      if (kind === 'defects') rememberDefectVersion(user.id, projectId, values.version);
      setForm(null); setToast(isEdit ? '已保存修改' : kind === 'cases' ? '用例已添加' : '缺陷已添加');
      if (sourceIndex !== null) onSaved?.(sourceIndex);
      await loadData();
    } catch (failure) {
      if (!current()) return;
      setFormError(failure.status === 409 ? '记录已被他人修改，请查看最新记录后重新编辑。' : failure.message);
      if (failure.status === 409) await loadData();
    } finally { if (current()) setFormBusy(false); }
  }
  async function deleteRecord(kind, record) {
    if (!window.confirm(`确定删除“${record.title || '未命名缺陷'}”吗？此操作无法撤销。`)) return;
    const auth = authEpoch.current; const scope = scopeEpoch.current;
    const current = () => authEpoch.current === auth && scopeEpoch.current === scope;
    try { await api(`/api/${kind}/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: record.revision, projectId: record.projectId }) }); if (!current()) return; setDetail(null); setToast('记录已删除'); await loadData(); }
    catch (failure) { if (!current()) return; if (failure.status === 409) await loadData(); if (current()) setError(failure.status === 409 ? '记录已被他人修改，请查看最新内容后重新确认删除。' : failure.message); }
  }
  async function deleteDefectImage(record, image) {
    if (!window.confirm(`删除图片“${image.name}”？`)) return;
    const auth = authEpoch.current; const scope = scopeEpoch.current;
    const current = () => authEpoch.current === auth && scopeEpoch.current === scope;
    try {
      await api(`/api/defects/${encodeURIComponent(record.id)}/images/${encodeURIComponent(image.id)}`, {
        method: 'DELETE', body: JSON.stringify({ projectId: record.projectId, revision: record.revision }),
      });
      if (!current()) return;
      setToast('图片已删除'); await loadData();
    } catch (failure) {
      if (!current()) return;
      if (failure.status === 409) await loadData();
      if (current()) setError(failure.status === 409 ? '缺陷已被他人修改，请刷新后重试。' : failure.message);
    }
  }
  async function saveGenerated(record, projectId) {
    if (!projectId || !projects.some((project) => project.id === projectId)) throw new Error('请先选择保存到的项目组');
    const auth = authEpoch.current; const scope = scopeEpoch.current;
    const payload = { ...record, projectId }; delete payload.id; delete payload.revision; delete payload.createdAt; delete payload.updatedAt;
    await api('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
    if (authEpoch.current !== auth || scopeEpoch.current !== scope) return;
    setToast('用例已添加'); await loadData();
  }
  async function createProject(name) {
    const auth = authEpoch.current;
    const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    if (authEpoch.current === auth) { await loadData(); setToast('项目组已创建'); }
    return result.project;
  }
  async function renameProject(project, name) {
    const auth = authEpoch.current;
    const result = await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify({ name, revision: project.revision }) });
    if (authEpoch.current === auth) { await loadData(); setToast('项目组已重命名'); }
    return result.project;
  }
  async function uploadProjectIcon(project, file) {
    const auth = authEpoch.current;
    const body = new FormData(); body.append('file', file); body.append('revision', String(project.revision));
    const result = await api(`/api/projects/${encodeURIComponent(project.id)}/icon`, { method: 'POST', body });
    if (authEpoch.current === auth) { await loadData(); setToast('项目图标已更新'); }
    return result.project;
  }
  async function deleteProject(project, confirmationName) {
    const auth = authEpoch.current;
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: project.revision, confirmationName }) });
    if (authEpoch.current === auth) { await loadData(); setToast('项目组已删除，可在已删除项目组中恢复'); }
  }
  async function restoreProject(project) {
    const auth = authEpoch.current;
    await api(`/api/projects/${encodeURIComponent(project.id)}/restore`, { method: 'POST', body: JSON.stringify({ revision: project.revision }) });
    if (authEpoch.current === auth) { await loadData(); setToast('项目组已恢复'); }
  }
  async function listArchivedProjects() { return (await api('/api/projects?archived=1')).projects; }
  if (user === undefined) return <div className="boot-screen"><BrandMark /><RefreshCw className="spin" size={20} /><span>正在连接平台…</span></div>;
  if (!user) return <Login onLogin={login} busy={loginBusy} error={loginError} />;
  const currentNav = NAV.find((item) => item.id === active);
  const canView = permitted(user, active);
  const canWrite = permitted(user, active, 'write');
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const formProject = form && projects.find((project) => project.id === form.projectId);
  const selectedRecord = detail && (detail.kind === 'cases' ? cases : defects).find((item) => item.id === detail.id);
  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
    {mobileOpen && <button type="button" className="mobile-shade" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <aside className="sidebar"><div className="sidebar-brand"><BrandMark /><div className="brand-words"><strong>QZZ</strong><span>公共测试平台</span></div><IconButton icon={X} label="关闭导航" onClick={() => setMobileOpen(false)} className="mobile-close" /></div>
      <div className="sidebar-label">工作空间</div><nav aria-label="主导航">{NAV.filter(({ id }) => permitted(user, id)).map(({ id, label, icon: Icon }) => <button className={`nav-item ${active === id ? 'active' : ''}`} type="button" key={id} onClick={() => navigate(id)} title={collapsed ? label : undefined} aria-current={active === id ? 'page' : undefined}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{active === id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><VersionHistory /><div className="sidebar-hint"><ShieldCheck size={17} /><span>公司内网工作区</span></div><button type="button" className="collapse-control" title={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>收起侧边栏</span></button></div>
    </aside>
      <div className="main-column"><header className="topbar"><div className="topbar-left"><IconButton icon={Menu} label="打开导航" className="mobile-menu" onClick={() => setMobileOpen(true)} /><span className="breadcrumb-parent">工作空间</span><ChevronRight size={15} className="breadcrumb-chevron" /><strong>{currentNav.label}</strong>{selectedProject && <><ChevronRight size={15} className="breadcrumb-chevron" /><span className="breadcrumb-project"><ProjectIcon project={selectedProject} small /><strong title={selectedProject.name}>{selectedProject.name}</strong></span></>}</div><div className="topbar-right"><div className={`connection ${connection}`} title={connection === 'online' ? '实时连接已建立' : '实时连接未建立，正在重试'}>{connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{connection === 'online' ? '实时在线' : connection === 'connecting' ? '连接中' : '重连中'}</span></div><span className="topbar-divider" /><div className="user-menu"><span className="avatar">{String(user.username || '用').slice(0, 1).toUpperCase()}</span><span className="user-name">{user.username}</span></div>{user.role === 'admin' && <IconButton icon={Users} label="账号管理" onClick={() => setUsersOpen(true)} />}<IconButton icon={KeyRound} label="修改我的密码" onClick={() => setPasswordOpen(true)} /><IconButton icon={LogOut} label="退出登录" onClick={logout} /></div></header>
      {error && <div className="global-error"><AlertCircle size={17} /><span>{error}</span><IconButton icon={X} label="关闭错误提示" onClick={() => setError('')} /></div>}
      <main className={`content ${canWrite ? '' : 'read-only-module'}`}>
        {!canView ? <Empty icon={ShieldCheck} title="暂未开放模块权限" detail="请联系管理员分配工作区权限。" action={<button className="button secondary" type="button" onClick={() => setPasswordOpen(true)}><KeyRound size={16} />修改我的密码</button>} />
          : ['cases', 'defects', 'requirements', 'knowledge', 'ai', 'audit'].includes(active) ? selectedProject ? <><ProjectContext project={selectedProject} onBack={() => selectProject(null)} />{active === 'cases' ? <>{caseRequirementFilter && <div className="project-context"><FileText size={16} /><span>仅查看此需求关联的用例集</span><button type="button" className="text-button" onClick={() => setCaseRequirementFilter(null)}>显示全部</button></div>}<CaseSetsPage requirementId={permitted(user, 'requirements') ? caseRequirementFilter : null} canLinkRequirements={permitted(user, 'requirements')} key={`cases-${selectedProject.id}-${caseRequirementFilter || 'all'}`} project={selectedProject} items={caseRequirementFilter ? cases.filter((item) => item.requirementId === caseRequirementFilter) : cases} loading={loading} canWrite={canWrite} refreshToken={dataVersion} onRefresh={loadData} showError={setError} onNotice={setToast} /></> : active === 'defects' ? <DefectsPage key={`defects-${selectedProject.id}`} project={selectedProject} items={defects} loading={loading} canWrite={canWrite} onNew={() => canWrite && openForm('defects')} onSelect={(record) => setDetail({ kind: 'defects', id: record.id })} onRefresh={loadData} showError={setError} onNotice={setToast} /> : active === 'requirements' ? <RequirementsPage isAdmin={user.role === 'admin'} userId={user.id} key={`requirements-${selectedProject.id}`} project={selectedProject} canWrite={canWrite} canAi={permitted(user, 'ai', 'write')} canCasesView={permitted(user, 'cases')} canGenerate={permitted(user, 'ai')} config={config} onGenerate={openRequirementAi} onOpenCases={openRequirementCases} refreshToken={dataVersion} onNotice={setToast} showError={setError} /> : active === 'knowledge' ? <KnowledgePage isAdmin={user.role === 'admin'} key={`knowledge-${selectedProject.id}`} project={selectedProject} canWrite={canWrite} config={config} refreshToken={dataVersion} onNotice={setToast} showError={setError} /> : active === 'audit' ? <CodeAuditPage key={`audit-${selectedProject.id}`} project={selectedProject} isAdmin={user.role === 'admin'} canWrite={canWrite} canCreateDefect={permitted(user, 'defects', 'write')} showError={setError} onNotice={setToast} onOpenDefect={openAuditDefect} /> : <AiWorkspace userId={user.id} key={`ai-${user.id}-${selectedProject.id}-${aiRequirement?.id || 'default'}`} project={selectedProject} projects={projects} isAdmin={user.role === 'admin'} canWrite={canWrite} canSave={permitted(user, 'cases', 'write')} canRequirements={permitted(user, 'requirements')} canKnowledge={permitted(user, 'knowledge')} config={config} initialRequirement={aiRequirement} refreshToken={dataVersion} onCreateRequirement={openRequirements} onRefresh={loadData} showError={setError} onNotice={setToast} />}</>
            : <ProjectsPage key={active} kind={active} projects={projects} loading={loading} canManage={user.role === 'admin'} onSelect={(project) => selectProject(project.id)} onRefresh={loadData} onCreate={createProject} onRename={renameProject} onUpload={uploadProjectIcon} onDelete={deleteProject} onRestore={restoreProject} onListArchived={listArchivedProjects} />
          : <CloudFilesPage canWrite={canWrite} refreshToken={dataVersion} showError={setError} onNotice={setToast} />}
      </main>
      {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
    </div>
    {selectedRecord && permitted(user, detail.kind) && <RecordDetail kind={detail.kind} record={selectedRecord} canWrite={permitted(user, detail.kind, 'write')} onClose={() => setDetail(null)} onEdit={() => openForm(detail.kind, selectedRecord)} onDelete={() => deleteRecord(detail.kind, selectedRecord)} onDeleteImage={deleteDefectImage} />}
    {form && formProject && <RecordForm key={`${form.kind}-${form.projectId}-${form.record?.id || 'new'}-${form.sourceIndex ?? ''}`} kind={form.kind} initial={form.record} project={formProject} userId={user.id} mode={form.record?.id ? 'edit' : 'new'} onClose={() => { if (!formBusy) setForm(null); }} onSave={saveForm} busy={formBusy} error={formError} onReload={() => setForm(null)} />}
    {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} onSaved={() => { setPasswordOpen(false); setToast('密码已修改，请在下次登录时使用新密码'); }} />}
    {usersOpen && user.role === 'admin' && <UsersDialog onClose={() => setUsersOpen(false)} onChanged={loadData} />}
  </div>;
}
