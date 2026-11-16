import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { forgetLogin, readRememberedLogin, rememberLogin } from './remembered-login';
import {
  AlertCircle, ArrowDownToLine, ArrowUpRight, Bot, Bug, Check, Copy,
  ChevronDown, ChevronRight, CircleHelp, CloudUpload, Database,
  Eye, EyeOff, FileText, Filter, FolderOpen, LayoutDashboard, LogOut, Menu,
  PanelLeftClose, PanelLeftOpen, Pencil, Plus,
  RefreshCw, Search, ShieldCheck, Sparkles, Trash2, Upload,
  Users, Wifi, WifiOff, X, KeyRound,
} from 'lucide-react';

const NAV = [
  { id: 'cases', label: '测试用例库', icon: Database },
  { id: 'defects', label: '当前缺陷', icon: Bug },
  { id: 'ai', label: 'AI 用例生成', icon: Sparkles },
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
  { key: 'title', label: '缺陷标题', required: true, placeholder: '简要描述问题', wide: true },
  { key: 'module', label: '所属模块', required: true, placeholder: '例如：活动中心' },
  { key: 'version', label: '发现版本', placeholder: '例如：1.0.0' },
  { key: 'severity', label: '严重程度', type: 'select', options: ['致命', '严重', '一般', '轻微'] },
  { key: 'status', label: '处理状态', type: 'select', options: ['待处理', '处理中', '待验证', '已解决', '已关闭'] },
  { key: 'assignee', label: '负责人', placeholder: '姓名或账号' },
  { key: 'reproSteps', label: '复现步骤', type: 'textarea', required: true, placeholder: '环境、前置条件和复现路径', wide: true },
  { key: 'expected', label: '预期表现', type: 'textarea', placeholder: '正确行为', wide: true },
  { key: 'actual', label: '实际表现', type: 'textarea', required: true, placeholder: '实际发生的问题', wide: true },
  { key: 'notes', label: '备注', type: 'textarea', placeholder: '截图、日志路径等补充说明', wide: true },
];

const EMPTY_CASE = {
  title: '', module: '', priority: 'P2', status: '未执行',
  preconditions: '', steps: '', expected: '', tags: '', notes: '',
};
const EMPTY_DEFECT = {
  title: '', module: '', version: '', severity: '一般', status: '待处理',
  assignee: '', reproSteps: '', expected: '', actual: '', notes: '',
};

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

function fileSize(bytes) {
  if (typeof bytes !== 'number') return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function prepareGenerated(record, module) {
  const priority = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' }[record.priority] || record.priority || 'P2';
  return { ...record, module: record.module || module, priority, status: '未执行' };
}

function Tone({ children, value }) {
  const text = String(value || children || '');
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
    <div className="login-top"><div className="brand-mark">Q</div><span>QZZ <strong>公共测试平台</strong></span></div>
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
    <div className="login-bottom">QZZ · 仅供内部测试协作使用</div>
  </div>;
}

function RecordForm({ kind, initial, mode, onClose, onSave, busy, error, onReload }) {
  const fields = kind === 'cases' ? CASE_FIELDS : DEFECT_FIELDS;
  const [values, setValues] = useState(() => ({ ...(kind === 'cases' ? EMPTY_CASE : EMPTY_DEFECT), ...initial, tags: Array.isArray(initial?.tags) ? initial.tags.join(', ') : initial?.tags || '' }));
  const title = kind === 'cases' ? '用例' : '缺陷';
  function submit(event) {
    event.preventDefault();
    const data = { ...values };
    if (kind === 'cases') data.tags = values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    onSave(data);
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="form-title">
      <div className="modal-head"><div><span className="eyebrow">{mode === 'edit' ? 'EDIT RECORD' : 'NEW RECORD'}</span><h2 id="form-title">{mode === 'edit' ? `编辑${title}` : `新建${title}`}</h2></div><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      <form onSubmit={submit} className="modal-form">
        <div className="form-grid">{fields.map((field) => <label key={field.key} className={`field ${field.wide ? 'field-wide' : ''}`}><span>{field.label}{field.required && <em> *</em>}</span>
          {field.type === 'textarea'
            ? <textarea value={values[field.key] ?? ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.placeholder} rows={field.key === 'steps' || field.key === 'reproSteps' ? 4 : 3} required={field.required} />
            : field.type === 'select'
              ? <select value={values[field.key] || field.options[0]} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}>{field.options.map((option) => <option key={option}>{option}</option>)}</select>
              : <input value={values[field.key] ?? ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.placeholder} required={field.required} />}
        </label>)}</div>
        {error && <div className="inline-error"><AlertCircle size={16} /><span>{error}</span>{error.includes('最新') && <button type="button" className="text-button" onClick={onReload}>查看最新记录</button>}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存'}</button></div>
      </form>
    </div>
  </div>;
}

function RecordDetail({ kind, record, onClose, onEdit, onDelete, canWrite }) {
  const fields = kind === 'cases' ? CASE_FIELDS : DEFECT_FIELDS;
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="detail-drawer" aria-label={kind === 'cases' ? '用例详情' : '缺陷详情'}>
      <div className="drawer-head"><div><span className="eyebrow">{kind === 'cases' ? 'TEST CASE' : 'DEFECT'}</span><span className="record-id">#{String(record.id).slice(0, 8)}</span></div><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      <div className="drawer-body"><h2>{record.title}</h2><div className="detail-pills"><Tone value={kind === 'cases' ? record.priority : record.severity} /><Tone value={record.status} /><span className="detail-module">{record.module || '未分类'}</span></div>
        <div className="detail-grid"><div><span>创建人</span><strong>{record.createdBy || '—'}</strong></div><div><span>更新时间</span><strong>{displayDate(record.updatedAt || record.createdAt)}</strong></div></div>
        <div className="detail-fields">{fields.filter((field) => !['title', 'module', 'priority', 'severity', 'status'].includes(field.key)).map((field) => <div key={field.key} className="detail-field"><span>{field.label}</span><p>{field.key === 'tags' ? (Array.isArray(record.tags) ? record.tags.join(' · ') : record.tags) || '—' : record[field.key] || '—'}</p></div>)}</div>
      </div>
      {canWrite && <div className="drawer-actions"><button className="button secondary" type="button" onClick={onDelete}><Trash2 size={16} /> 删除</button><button className="button primary" type="button" onClick={onEdit}><Pencil size={16} /> 编辑</button></div>}
    </aside>
  </div>;
}

function RecordPage({ kind, items, loading, onNew, onSelect, onRefresh, canWrite }) {
  const isCase = kind === 'cases';
  const [query, setQuery] = useState('');
  const [module, setModule] = useState('全部模块');
  const [status, setStatus] = useState('全部状态');
  const [sort, setSort] = useState('latest');
  const modules = useMemo(() => [...new Set(items.map((item) => item.module).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [items]);
  const statuses = isCase ? ['未执行', '通过', '失败', '阻塞'] : ['待处理', '处理中', '待验证', '已解决', '已关闭'];
  const visible = useMemo(() => items.filter((item) => {
    const haystack = [item.title, item.module, item.assignee, item.version, ...(Array.isArray(item.tags) ? item.tags : [])].join(' ').toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (module === '全部模块' || item.module === module) && (status === '全部状态' || item.status === status);
  }).sort((a, b) => sort === 'title' ? String(a.title).localeCompare(String(b.title), 'zh-CN') : new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)), [items, query, module, status, sort]);
  const heading = isCase ? '测试用例库' : '当前缺陷';
  const description = isCase ? '维护团队共用的测试资产' : '跟踪问题处理与验证进度';
  const openCount = items.filter((item) => isCase ? item.status === '未执行' : !['已解决', '已关闭'].includes(item.status)).length;
  const criticalCount = items.filter((item) => isCase ? ['P0', 'P1'].includes(item.priority) : ['致命', '严重'].includes(item.severity)).length;
  return <section className="workspace-section">
    <div className="section-heading"><div><span className="eyebrow">{isCase ? 'CASE LIBRARY' : 'ISSUE TRACKER'}</span><h1>{heading}</h1><p>{description}</p></div><div className="heading-actions"><IconButton icon={RefreshCw} label="刷新" onClick={onRefresh} disabled={loading} />{canWrite && <button className="button primary" type="button" onClick={onNew}><Plus size={17} /> 新建{isCase ? '用例' : '缺陷'}</button>}</div></div>
    <div className="summary-band"><div><span>记录总数</span><strong>{items.length}</strong></div><div><span>{isCase ? '待执行' : '未关闭'}</span><strong>{openCount}</strong></div><div><span>{isCase ? '高优先级' : '高严重度'}</span><strong>{criticalCount}</strong></div><div className="summary-note"><LayoutDashboard size={16} /><span>团队数据实时更新</span></div></div>
    <div className="table-surface">
      <div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label={`搜索${heading}`} placeholder={isCase ? '搜索标题、模块或标签' : '搜索标题、模块、负责人'} value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="toolbar-filters"><span className="filter-icon"><Filter size={16} /></span><select aria-label="模块筛选" value={module} onChange={(event) => setModule(event.target.value)}><option>全部模块</option>{modules.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option>全部状态</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value)}><option value="latest">最近更新</option><option value="title">按标题</option></select></div></div>
      <div className="table-caption">显示 {visible.length} / {items.length} 条</div>
      {loading && items.length === 0 ? <div className="loading-state"><RefreshCw size={18} className="spin" /> 加载中…</div> : visible.length === 0
        ? <Empty icon={isCase ? FileText : Bug} title={items.length ? '没有匹配的记录' : isCase ? '还没有测试用例' : '还没有缺陷记录'} detail={items.length ? '调整搜索或筛选条件后重试。' : '从团队的第一条记录开始。'} action={items.length || !canWrite ? null : <button className="button secondary" type="button" onClick={onNew}><Plus size={16} /> 新建{isCase ? '用例' : '缺陷'}</button>} />
        : <div className="table-scroll"><table><thead><tr><th>{isCase ? '用例标题' : '缺陷标题'}</th><th>所属模块</th><th>{isCase ? '优先级' : '严重度'}</th><th>状态</th>{!isCase && <th>负责人</th>}<th>最近更新</th><th className="actions-col">操作</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} onClick={() => onSelect(item)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(item); }}><td><div className="record-title">{item.title}</div><div className="record-meta">#{String(item.id).slice(0, 8)}{isCase && Array.isArray(item.tags) && item.tags.length ? ` · ${item.tags.slice(0, 2).join(' · ')}` : ''}</div></td><td>{item.module || '—'}</td><td><Tone value={isCase ? item.priority : item.severity} /></td><td><Tone value={item.status} /></td>{!isCase && <td>{item.assignee || '未指派'}</td>}<td className="date-cell">{displayDate(item.updatedAt || item.createdAt)}</td><td className="actions-col"><IconButton icon={ChevronRight} label="查看详情" onClick={(event) => { event.stopPropagation(); onSelect(item); }} /></td></tr>)}</tbody></table></div>}
    </div>
  </section>;
}

function AiPage({ config, onSave, onEdit, showError, canWrite, canSave }) {
  const [requirements, setRequirements] = useState('');
  const [module, setModule] = useState('');
  const [count, setCount] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState([]);
  const [saved, setSaved] = useState(new Set());
  const [saving, setSaving] = useState(-1);
  const [expanded, setExpanded] = useState(0);
  const configured = Boolean(config.aiConfigured) && canWrite;
  async function generate(event) {
    event.preventDefault();
    setGenerating(true); setGenerated([]); setSaved(new Set());
    try {
      const result = await api('/api/ai/generate', { method: 'POST', body: JSON.stringify({ requirements: requirements.trim(), module: module.trim(), count: Number(count) }) });
      setGenerated((result.cases || []).map((record) => prepareGenerated(record, module)));
      setExpanded(0);
    } catch (error) { showError(error.message); }
    finally { setGenerating(false); }
  }
  async function save(index) {
    setSaving(index);
    try { await onSave(generated[index]); setSaved((old) => new Set([...old, index])); }
    catch (error) { showError(error.message); }
    finally { setSaving(-1); }
  }
  return <section className="workspace-section ai-section">
    <div className="section-heading"><div><span className="eyebrow">AI ASSISTANT</span><h1>AI 用例生成</h1><p>从需求描述生成草稿，审核后保存到用例库</p></div><div className="heading-symbol"><Bot size={24} /></div></div>
    <div className="ai-layout"><form className="generator-panel" onSubmit={generate}><div className="panel-title"><Sparkles size={19} /><h2>需求输入</h2></div>
      {!configured && <div className="notice"><CircleHelp size={18} /><span>{canWrite ? 'AI 服务尚未配置，请联系平台管理员在服务器配置 API Key。' : '当前账号仅有查看权限，请联系管理员开放生成权限。'}</span></div>}
      <label className="field"><span>功能需求 <em>*</em></span><textarea rows={11} placeholder="粘贴需求描述、规则或验收标准…" value={requirements} onChange={(event) => setRequirements(event.target.value)} required disabled={!configured || generating} /></label>
      <div className="generator-row"><label className="field"><span>所属模块</span><input placeholder="例如：活动中心" value={module} onChange={(event) => setModule(event.target.value)} disabled={!configured || generating} /></label><label className="field count-field"><span>生成条数</span><input type="number" min="1" max="20" value={count} onChange={(event) => setCount(event.target.value)} disabled={!configured || generating} /></label></div>
      <button className="button primary generate-button" type="submit" disabled={!configured || generating || !requirements.trim()}>{generating ? <><RefreshCw size={17} className="spin" /> 正在生成…</> : <><Sparkles size={17} /> 生成用例草稿</>}</button>
    </form><div className="results-panel"><div className="results-head"><div><span className="eyebrow">REVIEW</span><h2>生成结果</h2></div><span>{generated.length} 条草稿</span></div>
      {generated.length === 0 ? <Empty icon={Bot} title="等待生成结果" detail="生成后逐条检查，再决定是否保存到用例库。" /> : <div className="result-list">{generated.map((item, index) => <div className="result-item" key={`${index}-${item.title}`}><button type="button" className="result-toggle" onClick={() => setExpanded(expanded === index ? -1 : index)} aria-expanded={expanded === index}><span className="result-number">{String(index + 1).padStart(2, '0')}</span><span className="result-name">{item.title || '未命名用例'}</span>{expanded === index ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{expanded === index && <div className="result-detail"><div className="result-tags"><Tone value={item.priority || 'P2'} /><span>{item.module || module || '未分类'}</span></div><div><strong>前置条件</strong><p>{item.preconditions || '—'}</p></div><div><strong>操作步骤</strong><p>{item.steps || '—'}</p></div><div><strong>预期结果</strong><p>{item.expected || '—'}</p></div><div className="result-actions"><button type="button" className="button secondary" onClick={() => onEdit(item, index, (savedIndex) => setSaved((old) => new Set([...old, savedIndex])))} disabled={!canSave || saved.has(index)}>编辑并保存</button><button type="button" className="button primary" onClick={() => save(index)} disabled={!canSave || saved.has(index) || saving === index}>{saved.has(index) ? <><Check size={16} /> 已保存</> : saving === index ? '保存中…' : '保存到用例库'}</button></div></div>}</div>)}</div>}
    </div></div>
  </section>;
}

function FilesPage({ files, loading, maxUploadMb, onUpload, onDelete, onRefresh, showError, canWrite }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  async function upload(file) {
    if (!file) return;
    if (maxUploadMb && file.size > maxUploadMb * 1024 * 1024) { showError(`文件不能超过 ${maxUploadMb} MB`); return; }
    setUploading(true);
    try { await onUpload(file); }
    catch (error) { showError(error.message); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  }
  return <section className="workspace-section files-section"><div className="section-heading"><div><span className="eyebrow">TEAM FILES</span><h1>测试工具云盘</h1><p>共享安装包、测试工具与团队资料</p></div><div className="heading-actions"><IconButton icon={RefreshCw} label="刷新" onClick={onRefresh} disabled={loading} /><button className="button primary" type="button" onClick={() => inputRef.current?.click()} disabled={!canWrite || uploading}><Upload size={17} /> 上传文件</button></div></div>
    <input ref={inputRef} type="file" hidden onChange={(event) => upload(event.target.files?.[0])} />
    {canWrite && <div className={`upload-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files?.[0]); }}><div className="upload-icon"><CloudUpload size={24} /></div><div><strong>{uploading ? '正在上传…' : '拖放文件到这里'}</strong><span>或 <button type="button" className="text-button" onClick={() => inputRef.current?.click()} disabled={!canWrite || uploading}>选择文件</button> 上传{maxUploadMb ? `，单个文件最大 ${maxUploadMb} MB` : ''}</span></div></div>}
    <div className="table-surface files-table"><div className="files-table-title"><h2>团队文件</h2><span>{files.length} 个文件</span></div>{loading && files.length === 0 ? <div className="loading-state"><RefreshCw size={18} className="spin" /> 加载中…</div> : files.length === 0 ? <Empty icon={FolderOpen} title="还没有共享文件" detail="上传工具或资料后，团队成员即可下载。" /> : <div className="table-scroll"><table><thead><tr><th>文件名</th><th>大小</th><th>上传人</th><th>上传时间</th><th className="actions-col">操作</th></tr></thead><tbody>{files.map((file) => <tr key={file.id}><td><div className="file-name"><span className="file-icon"><FileText size={19} /></span><span title={file.name}>{file.name}</span></div></td><td>{fileSize(file.size)}</td><td>{file.uploadedBy || file.createdBy || '—'}</td><td className="date-cell">{displayDate(file.createdAt || file.uploadedAt)}</td><td className="actions-col"><div className="row-actions"><a className="icon-button" href={`/api/files/${encodeURIComponent(file.id)}/download`} title={`下载 ${file.name}`} aria-label={`下载 ${file.name}`}><ArrowDownToLine size={17} /></a>{canWrite && <IconButton icon={Trash2} label={`删除 ${file.name}`} danger onClick={() => onDelete(file)} />}</div></td></tr>)}</tbody></table></div>}</div>
  </section>;
}


function permitted(user, module, action = 'view') {
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
  return <div className="modal-backdrop"><div className="modal users-modal account-users-modal" role="dialog" aria-modal="true" aria-labelledby="users-title"><div className="modal-head"><div><span className="eyebrow">TEAM ACCESS</span><h2 id="users-title">账号与权限管理</h2></div><IconButton icon={X} label="关闭" onClick={onClose} disabled={busy} /></div><div className="users-content"><div className="users-list-title"><h3>成员账号 · {users.length}</h3><button type="button" className="button secondary" disabled={busy} onClick={() => { setCreating(true); setDraft(null); setSelected(''); setPassword(''); setRevealed(null); setError(''); setMessage(''); }}><Plus size={15} />创建账号</button></div>{loading ? <div className="loading-state">加载中…</div> : <div className="member-picker">{users.map((member) => <button type="button" disabled={busy} key={member.id} className={`member-option ${selected === member.id ? 'selected' : ''}`} onClick={() => select(member)}><span className="avatar">{member.username.slice(0, 1).toUpperCase()}</span><strong>{member.username}</strong><span>{member.disabled ? '已停用' : member.role === 'admin' ? '管理员' : '成员'}</span></button>)}</div>}
      {(creating || draft) && <form className="account-editor" onSubmit={save}><h3>{creating ? '创建成员账号' : `管理 ${draft.username}`}</h3>{creating ? <label className="field"><span>账号</span><input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} minLength={2} maxLength={32} required autoComplete="off" /></label> : <div className="user-form-row"><label className="field"><span>账号角色</span><select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} disabled={busy}><option value="member">普通成员</option><option value="admin">管理员</option></select></label><label className="check-field"><input type="checkbox" checked={Boolean(draft.disabled)} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} disabled={busy} /><span>停用账号</span></label></div>}
      {!creating && <div className="permissions-table"><div className="permission-row permission-head"><span>模块权限</span><span>查看</span><span>编辑 / 操作</span></div>{NAV.map((module) => <div className="permission-row" key={module.id}><span>{module.label}</span>{['view', 'write'].map((action) => <input key={action} type="checkbox" aria-label={`${module.label}${action === 'view' ? '查看' : '编辑'}`} checked={draft.role === 'admin' || Boolean(draft.permissions?.[module.id]?.[action])} disabled={busy || draft.role === 'admin'} onChange={(event) => permission(module.id, action, event.target.checked)} />)}</div>)}</div>}
      <label className="field"><span>{creating ? '初始密码' : '设置新密码（留空则保留）'}</span><input type="password" autoComplete="new-password" minLength={6} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} required={creating} placeholder="至少 6 位" disabled={busy} /></label><div className="modal-actions"><button className="button primary" disabled={busy}>{busy ? '保存中…' : creating ? '创建账号' : '保存账号与权限'}</button></div></form>}
      {draft && !creating && <div className="password-reveal"><h3>查看账号密码</h3>{revealed !== null ? <div className="revealed-password"><code>{revealed}</code><IconButton icon={EyeOff} label="隐藏密码" onClick={() => setRevealed(null)} /></div> : <div className="reveal-controls"><label className="field"><span>验证当前管理员密码</span><input type="password" autoComplete="current-password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} maxLength={200} /></label><button type="button" className="button secondary" disabled={busy || !adminPassword} onClick={reveal}><Eye size={16} />查看密码</button></div>}</div>}
      {message && <div className="account-success" role="status"><Check size={16} />{message}</div>}{error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    </div></div></div>;
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [config, setConfig] = useState({ aiConfigured: false, maxUploadMb: null });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [active, setActive] = useState('cases');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('qzz-sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connection, setConnection] = useState('connecting');
  const [cases, setCases] = useState([]);
  const [defects, setDefects] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [usersOpen, setUsersOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => { localStorage.setItem('qzz-sidebar-collapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => {
    if (!user) return;
    if (!permitted(user, active)) {
      const first = NAV.find(({ id }) => permitted(user, id));
      if (first) setActive(first.id);
    }
    if (user.role !== 'admin') setUsersOpen(false);
    if (form && !permitted(user, form.kind, 'write')) setForm(null);
  }, [user, active, form]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    api('/api/session').then((data) => setUser(data.user || null)).catch((failure) => { setUser(null); setLoginError(failure.message); });
  }, []);

  const loadData = useCallback(async () => {
    try {
      const session = await api('/api/session');
      const currentUser = session.user;
      if (!currentUser) { setUser(null); return; }
      setUser((old) => JSON.stringify(old) === JSON.stringify(currentUser) ? old : currentUser);
      const [caseData, defectData, fileData] = await Promise.all(['cases', 'defects', 'files'].map((module) => permitted(currentUser, module) ? api(`/api/${module}`) : Promise.resolve({})));
      setCases(caseData.cases || []); setDefects(defectData.defects || []); setFiles(fileData.files || []);
      setError('');
    } catch (failure) {
      if (failure.status === 401) setUser(null);
      else setError(failure.message);
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    let socket;
    let retryTimer;
    setLoading(true);
    loadData().finally(() => { if (alive) setLoading(false); });
    api('/api/config').then((data) => { if (alive) setConfig(data); }).catch((failure) => { if (alive) setError(failure.message); });
    function connect() {
      if (!alive) return;
      setConnection('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/api/events`);
      socket.onopen = () => { if (alive) { setConnection('online'); loadData(); } };
      socket.onmessage = () => { if (alive) loadData(); };
      socket.onerror = () => { if (alive) setConnection('offline'); };
      socket.onclose = () => { if (alive) { setConnection('offline'); loadData(); retryTimer = setTimeout(connect, 3000); } };
    }
    connect();
    return () => { alive = false; clearTimeout(retryTimer); socket?.close(); };
  }, [user, loadData]);

  async function login(username, password, remember, register) {
    setLoginBusy(true); setLoginError('');
    try {
      const data = await api(register ? '/api/register' : '/api/session', { method: 'POST', body: JSON.stringify({ username, password, remember }) });
      try { if (remember) await rememberLogin(username, password); else await forgetLogin(); }
      catch { setToast('登录成功，但浏览器未允许保存账号密码'); }
      setUser(data.user);
    }
    catch (failure) { setLoginError(failure.message); }
    finally { setLoginBusy(false); }
  }
  async function logout() {
    try { await api('/api/session', { method: 'DELETE' }); setUser(null); setCases([]); setDefects([]); setFiles([]); setDetail(null); setForm(null); setUsersOpen(false); setPasswordOpen(false); }
    catch (failure) { setError(failure.message); }
  }
  function navigate(next) { setActive(next); setMobileOpen(false); setError(''); setDetail(null); }
  function openForm(kind, record = null, sourceIndex = null, onSaved = null) { setForm({ kind, record, sourceIndex, onSaved }); setDetail(null); setFormError(''); }
  async function saveForm(values) {
    setFormBusy(true); setFormError('');
    const { kind, record, sourceIndex, onSaved } = form;
    try {
      const isEdit = Boolean(record?.id);
      const payload = { ...values };
      if (isEdit) payload.revision = record.revision;
      else delete payload.revision;
      await api(`/api/${kind}${isEdit ? `/${encodeURIComponent(record.id)}` : ''}`, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setForm(null); setToast(isEdit ? '已保存修改' : kind === 'cases' ? '用例已添加' : '缺陷已添加');
      if (sourceIndex !== null) onSaved?.(sourceIndex);
      await loadData();
    } catch (failure) {
      setFormError(failure.status === 409 ? '记录已被他人修改，请查看最新记录后重新编辑。' : failure.message);
      if (failure.status === 409) await loadData();
    } finally { setFormBusy(false); }
  }
  async function deleteRecord(kind, record) {
    if (!window.confirm(`确定删除“${record.title}”吗？此操作无法撤销。`)) return;
    try { await api(`/api/${kind}/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: record.revision }) }); setDetail(null); setToast('记录已删除'); await loadData(); }
    catch (failure) { if (failure.status === 409) await loadData(); setError(failure.status === 409 ? '记录已被他人修改，请查看最新内容后重新确认删除。' : failure.message); }
  }
  async function saveGenerated(record) {
    const payload = { ...record }; delete payload.id; delete payload.revision; delete payload.createdAt; delete payload.updatedAt;
    await api('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
    setToast('用例已添加'); await loadData();
  }
  async function upload(file) {
    const body = new FormData(); body.append('file', file);
    await api('/api/files', { method: 'POST', body }); setToast('文件已上传'); await loadData();
  }
  async function deleteFile(file) {
    if (!window.confirm(`确定删除“${file.name}”吗？此操作无法撤销。`)) return;
    try { await api(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); setToast('文件已删除'); await loadData(); }
    catch (failure) { setError(failure.message); }
  }

  if (user === undefined) return <div className="boot-screen"><div className="brand-mark">Q</div><RefreshCw className="spin" size={20} /><span>正在连接平台…</span></div>;
  if (!user) return <Login onLogin={login} busy={loginBusy} error={loginError} />;
  const currentNav = NAV.find((item) => item.id === active);
  const canView = permitted(user, active);
  const canWrite = permitted(user, active, 'write');
  const selectedRecord = detail && (detail.kind === 'cases' ? cases : defects).find((item) => item.id === detail.id);
  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
    {mobileOpen && <button type="button" className="mobile-shade" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark">Q</div><div className="brand-words"><strong>QZZ</strong><span>公共测试平台</span></div><IconButton icon={X} label="关闭导航" onClick={() => setMobileOpen(false)} className="mobile-close" /></div>
      <div className="sidebar-label">工作空间</div><nav aria-label="主导航">{NAV.filter(({ id }) => permitted(user, id)).map(({ id, label, icon: Icon }) => <button className={`nav-item ${active === id ? 'active' : ''}`} type="button" key={id} onClick={() => navigate(id)} title={collapsed ? label : undefined} aria-current={active === id ? 'page' : undefined}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{active === id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-hint"><ShieldCheck size={17} /><span>公司内网工作区</span></div><button type="button" className="collapse-control" title={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>收起侧边栏</span></button></div>
    </aside>
      <div className="main-column"><header className="topbar"><div className="topbar-left"><IconButton icon={Menu} label="打开导航" className="mobile-menu" onClick={() => setMobileOpen(true)} /><span className="breadcrumb-parent">工作空间</span><ChevronRight size={15} className="breadcrumb-chevron" /><strong>{currentNav.label}</strong></div><div className="topbar-right"><div className={`connection ${connection}`} title={connection === 'online' ? '实时连接已建立' : '实时连接未建立，正在重试'}>{connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{connection === 'online' ? '实时在线' : connection === 'connecting' ? '连接中' : '重连中'}</span></div><span className="topbar-divider" /><div className="user-menu"><span className="avatar">{String(user.username || '用').slice(0, 1).toUpperCase()}</span><span className="user-name">{user.username}</span></div>{user.role === 'admin' && <IconButton icon={Users} label="账号管理" onClick={() => setUsersOpen(true)} />}<IconButton icon={KeyRound} label="修改我的密码" onClick={() => setPasswordOpen(true)} /><IconButton icon={LogOut} label="退出登录" onClick={logout} /></div></header>
      {error && <div className="global-error"><AlertCircle size={17} /><span>{error}</span><IconButton icon={X} label="关闭错误提示" onClick={() => setError('')} /></div>}
      <main className={`content ${canWrite ? '' : 'read-only-module'}`}>{!canView ? <Empty icon={ShieldCheck} title="暂未开放模块权限" detail="请联系管理员分配工作区权限。" action={<button className="button secondary" type="button" onClick={() => setPasswordOpen(true)}><KeyRound size={16} />修改我的密码</button>} /> : active === 'cases' || active === 'defects' ? <RecordPage canWrite={canWrite} key={active} kind={active} items={active === 'cases' ? cases : defects} loading={loading} onNew={() => canWrite && openForm(active)} onSelect={(record) => setDetail({ kind: active, id: record.id })} onRefresh={loadData} /> : active === 'ai' ? <AiPage canWrite={canWrite} canSave={permitted(user, 'cases', 'write')} config={config} onSave={saveGenerated} onEdit={(record, index, onSaved) => permitted(user, 'cases', 'write') && openForm('cases', record, index, onSaved)} showError={setError} /> : <FilesPage canWrite={canWrite} files={files} loading={loading} maxUploadMb={config.maxUploadMb} onUpload={upload} onDelete={deleteFile} onRefresh={loadData} showError={setError} />}</main>
      {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
    </div>
    {selectedRecord && permitted(user, detail.kind) && <RecordDetail kind={detail.kind} record={selectedRecord} canWrite={permitted(user, detail.kind, 'write')} onClose={() => setDetail(null)} onEdit={() => openForm(detail.kind, selectedRecord)} onDelete={() => deleteRecord(detail.kind, selectedRecord)} />}
    {form && <RecordForm key={`${form.kind}-${form.record?.id || 'new'}-${form.sourceIndex ?? ''}`} kind={form.kind} initial={form.record} mode={form.record?.id ? 'edit' : 'new'} onClose={() => setForm(null)} onSave={saveForm} busy={formBusy} error={formError} onReload={() => setForm(null)} />}
    {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} onSaved={() => { setPasswordOpen(false); setToast('密码已修改，请在下次登录时使用新密码'); }} />}
    {usersOpen && user.role === 'admin' && <UsersDialog onClose={() => setUsersOpen(false)} onChanged={loadData} />}
  </div>;
}
