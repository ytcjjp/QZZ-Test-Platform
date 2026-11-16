import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, ChevronRight, FileText, Link2, LoaderCircle, Plus, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import './ai-documents.css';

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...options,
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '请求失败，请稍后重试');
  return data;
}

function MapBranch({ node, root = false }) {
  return <li className={root ? 'ai-preview-root' : ''}>
    {node.children?.length ? <details open={root || node.children.some((child) => child.children?.length)}><summary>{node.title}</summary><ul>{node.children.map((child) => <MapBranch key={child.id} node={child} />)}</ul></details> : <span>{node.title}</span>}
  </li>;
}

function FeishuConfig({ onClose, onSaved }) {
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    request('/api/ai/feishu-config', { signal: controller.signal }).then((data) => {
      if (alive.current) { setAppId(data.appId); setConfigured(data.configured); }
    }).catch((failure) => { if (alive.current && failure.name !== 'AbortError') setError(failure.message); }).finally(() => { if (alive.current) setBusy(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request('/api/ai/feishu-config', { method: 'PUT', body: JSON.stringify({ appId: appId.trim(), appSecret: secret }) });
      if (alive.current) { setSecret(''); onSaved(); onClose(); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal ai-feishu-modal" role="dialog" aria-modal="true" aria-labelledby="feishu-config-title">
    <div className="modal-head"><h2 id="feishu-config-title">飞书文档连接</h2><button type="button" className="icon-button" title="关闭" aria-label="关闭飞书配置" onClick={onClose} disabled={busy}><X size={17} /></button></div>
    <form className="modal-form" onSubmit={save}>
      <label className="field"><span>App ID</span><input value={appId} placeholder="cli_…" required maxLength={125} disabled={busy} onChange={(event) => setAppId(event.target.value)} autoComplete="off" /></label>
      <label className="field"><span>App Secret</span><input type="password" value={secret} placeholder={configured ? '已配置，留空保留' : '输入应用密钥'} required={!configured} maxLength={500} disabled={busy} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label>
      <p className="ai-config-note">应用需开通云文档读取权限；知识库地址还需知识库读取权限。请将目标文档共享给该应用。</p>
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '处理中…' : '保存配置'}</button></div>
    </form>
  </div></div>;
}

export default function AiDocuments({ config = {}, projects = [], canWrite, canSave, isAdmin = false, onRefresh, showError, onNotice }) {
  const [documents, setDocuments] = useState([]);
  const [previewId, setPreviewId] = useState('');
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [answers, setAnswers] = useState('');
  const [projectId, setProjectId] = useState('');
  const [savedTargets, setSavedTargets] = useState(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const input = useRef(null);
  const alive = useRef(true);
  const pending = useRef(new Set());
  const operation = useRef(0);
  const locked = useRef(false);
  const previousWrite = useRef(canWrite);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operation.current += 1; pending.current.forEach((controller) => controller.abort()); };
  }, []);
  useEffect(() => {
    const token = ++operation.current;
    locked.current = true;
    call('/api/ai/documents').then((data) => {
      if (alive.current && operation.current === token) setDocuments(data.documents || []);
    }).catch((failure) => { if (operation.current === token) report(failure); })
      .finally(() => { if (alive.current && operation.current === token) { locked.current = false; setBusy(''); } });
  }, []);
  useEffect(() => { if (projectId && !projects.some((project) => project.id === projectId)) setProjectId(''); }, [projects, projectId]);
  useEffect(() => {
    if (previousWrite.current && !canWrite) { operation.current += 1; pending.current.forEach((controller) => controller.abort()); locked.current = false; setBusy(''); }
    previousWrite.current = canWrite;
  }, [canWrite]);
  async function call(path, options = {}) {
    const controller = new AbortController(); pending.current.add(controller);
    try { return await request(path, { ...options, signal: controller.signal }); }
    finally { pending.current.delete(controller); }
  }
  function report(failure) {
    if (failure.name === 'AbortError' || !alive.current) return;
    setError(failure.message); showError?.(failure.message);
  }
  function invalidateResult() { setResult(null); setAnswers(''); setSavedTargets(new Set()); }
  async function importSources(files, link) {
    if (!canWrite || locked.current) return;
    const selected = files ? Array.from(files) : [];
    if (!selected.length && !link?.trim()) return;
    if (selected.length + documents.length + (link ? 1 : 0) > 5) { setError('每次最多使用 5 份策划文档'); return; }
    if (selected.some((file) => !/\.(docx?|pdf|md|markdown|txt)$/i.test(file.name))) { setError('请选择 Word、PDF、Markdown 或 TXT 文档'); return; }
    const token = ++operation.current;
    locked.current = true; setBusy('import'); setError('');
    try {
      const sources = link ? [link.trim()] : selected;
      for (const source of sources) {
        let body;
        if (typeof source === 'string') body = JSON.stringify({ url: source });
        else { body = new FormData(); body.append('file', source); }
        const data = await call('/api/ai/documents', { method: 'POST', body });
        if (!alive.current || operation.current !== token) return;
        setDocuments((current) => [...current, data.document]); setPreviewId(data.document.id); invalidateResult();
      }
      if (link) setUrl('');
    } catch (failure) { if (operation.current === token) report(failure); }
    finally { if (alive.current && operation.current === token) { locked.current = false; setBusy(''); if (input.current) input.current.value = ''; } }
  }
  async function removeDocument(document) {
    if (!canWrite || locked.current) return;
    locked.current = true; setBusy('remove'); setError('');
    try {
      await call(`/api/ai/documents/${encodeURIComponent(document.id)}`, { method: 'DELETE' });
      if (!alive.current) return;
      setDocuments((current) => current.filter((doc) => doc.id !== document.id));
      if (previewId === document.id) setPreviewId(''); invalidateResult();
    } catch (failure) { report(failure); }
    finally { if (alive.current) { locked.current = false; setBusy(''); } }
  }
  async function generate(confirmed = false) {
    if (!canWrite || locked.current || !config.aiConfigured || !documents.length) return;
    const token = ++operation.current;
    locked.current = true; setBusy('generate'); setError('');
    try {
      const data = await call('/api/ai/generate', { method: 'POST', body: JSON.stringify({ documentIds: documents.map((doc) => doc.id), clarifications: answers.trim(), confirmed }) });
      if (!alive.current || operation.current !== token) return;
      setResult(data); setSavedTargets(new Set());
    } catch (failure) { if (operation.current === token) report(failure); }
    finally { if (alive.current && operation.current === token) { locked.current = false; setBusy(''); } }
  }
  async function save() {
    if (!canSave || locked.current || !projectId || !result?.tree || savedTargets.has(projectId)) return;
    if (!result.title.trim()) { setError('请输入用例集名称'); return; }
    const target = projectId; const token = ++operation.current;
    locked.current = true; setBusy('save'); setError('');
    try {
      await call('/api/cases', { method: 'POST', body: JSON.stringify({ projectId: target, title: result.title.trim(), tree: { ...result.tree, title: result.title.trim() } }) });
      if (!alive.current || operation.current !== token) return;
      setSavedTargets((previous) => new Set([...previous, target])); onNotice?.('用例集已保存'); await onRefresh?.();
    } catch (failure) { if (operation.current === token) report(failure); }
    finally { if (alive.current && operation.current === token) { locked.current = false; setBusy(''); } }
  }
  function drop(event) {
    event.preventDefault(); setDragging(false);
    if (event.dataTransfer.files.length) importSources(event.dataTransfer.files);
    else {
      const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
      const link = text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim();
      if (link) { setUrl(link); importSources(null, link); }
    }
  }
  const preview = documents.find((doc) => doc.id === previewId) || documents[0];
  const noGenerate = !canWrite || !config.aiConfigured || !documents.length || Boolean(busy);
  return <section className="workspace-section ai-documents-section">
    <div className="section-heading"><div><span className="eyebrow">AI ASSISTANT</span><h1>AI 用例生成</h1><p>策划文档 · 点点消用例规范</p></div>{isAdmin && <button type="button" className="button secondary" onClick={() => setSettingsOpen(true)} disabled={Boolean(busy)}><Settings2 size={16} />飞书文档连接</button>}</div>
    {!config.aiConfigured && <div className="notice"><AlertCircle size={17} /><span>AI 服务尚未配置，请联系管理员在服务控制器中配置 API Key 和模型。</span></div>}
    {!canWrite && <div className="notice"><AlertCircle size={17} /><span>当前账号没有生成权限，请联系管理员。</span></div>}
    {error && <div className="inline-error ai-document-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" className="icon-button" title="关闭错误提示" aria-label="关闭文档错误" onClick={() => setError('')}><X size={15} /></button></div>}
    <div className="ai-document-columns"><div className="ai-source-column">
      <div className="ai-source-heading"><h2>策划文档</h2><span>{documents.length} / 5</span></div>
      <input ref={input} type="file" accept=".doc,.docx,.pdf,.md,.markdown,.txt" multiple hidden onChange={(event) => importSources(event.target.files)} />
      <div className={`ai-document-drop ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); if (canWrite && !busy) setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={drop}>
        {busy === 'import' ? <LoaderCircle size={27} className="spin" /> : <Upload size={27} />}
        <strong>{busy === 'import' ? '正在读取策划文档…' : '拖入策划文档或飞书地址'}</strong><span>Word / PDF / Markdown / TXT</span>
        <button type="button" className="button secondary" disabled={!canWrite || Boolean(busy) || documents.length >= 5} onClick={() => input.current?.click()}><Plus size={16} />选择文档</button>
      </div>
      <form className="ai-link-form" onSubmit={(event) => { event.preventDefault(); importSources(null, url); }}>
        <label className="field"><span>飞书云文档地址</span><div className="ai-link-input"><Link2 size={16} /><input type="url" placeholder="https://…feishu.cn/docx/…" value={url} onChange={(event) => setUrl(event.target.value)} disabled={!canWrite || Boolean(busy)} aria-label="飞书云文档地址" required maxLength={2000} /></div></label>
        <button type="submit" className="button secondary" disabled={!canWrite || Boolean(busy) || !url.trim() || documents.length >= 5}>导入链接</button>
      </form>
      {documents.length > 0 && <div className="ai-document-list">{documents.map((document) => <div className={`ai-source-item ${preview?.id === document.id ? 'selected' : ''}`} key={document.id}>
        <button type="button" onClick={() => setPreviewId(document.id)} title={document.name}><FileText size={18} /><span><strong>{document.name}</strong><small>{document.chars.toLocaleString()} 字</small></span><ChevronRight size={15} /></button>
        {canWrite && <button type="button" className="icon-button danger" title={`移除 ${document.name}`} aria-label={`移除 ${document.name}`} disabled={Boolean(busy)} onClick={() => removeDocument(document)}><Trash2 size={16} /></button>}
      </div>)}</div>}
      {preview && <details className="ai-source-preview"><summary>文档内容 · {preview.name}</summary><pre>{preview.text}</pre></details>}
      <button type="button" className="button primary ai-document-generate" onClick={() => generate(false)} disabled={noGenerate}>{busy === 'generate' ? <><LoaderCircle size={17} className="spin" />正在生成…</> : <><Sparkles size={17} />生成用例集</>}</button>
    </div><div className="ai-output-column">
      <div className="ai-source-heading"><h2>用例集草稿</h2><Bot size={20} /></div>
      {!result && <div className="ai-document-empty"><FileText size={32} /><span>{busy === 'generate' ? '正在分析策划文档…' : '暂无草稿'}</span></div>}
      {result?.questions?.length > 0 && <div className="ai-clarifications"><h3>待确认规则</h3><ol>{result.questions.map((question, index) => <li key={index}>{question}</li>)}</ol>
        <label className="field"><span>规则确认回答</span><textarea rows={4} value={answers} onChange={(event) => setAnswers(event.target.value)} maxLength={12000} disabled={Boolean(busy) || !canWrite} placeholder="按问题编号补充已确认的规则" /></label>
        <div className="ai-clarification-actions"><button type="button" className="button primary" disabled={noGenerate || !answers.trim()} onClick={() => generate(false)}>提交回答并生成</button><button type="button" className="button secondary" disabled={noGenerate} onClick={() => generate(true)}>仅按明确规则生成</button></div>
      </div>}
      {result?.tree && <>
        <div className="ai-save-controls"><label className="field"><span>用例集名称</span><input value={result.title} onChange={(event) => { setResult((previous) => ({ ...previous, title: event.target.value })); setSavedTargets(new Set()); }} maxLength={200} disabled={Boolean(busy)} /></label>
          <label className="field"><span>保存到项目组</span><select aria-label="保存到项目组" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={Boolean(busy) || !canSave}><option value="">请选择项目组</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
          <button className="button primary" type="button" onClick={save} disabled={!canSave || !projectId || Boolean(busy) || !result.title.trim() || savedTargets.has(projectId)}>{savedTargets.has(projectId) ? <><Check size={16} />已保存</> : busy === 'save' ? '保存中…' : '保存用例集'}</button>
        </div>
        <div className="ai-map-preview" aria-label="用例集草稿预览"><ul><MapBranch node={{ ...result.tree, title: result.title || result.tree.title }} root /></ul></div>
      </>}
    </div></div>
    {settingsOpen && isAdmin && <FeishuConfig onClose={() => setSettingsOpen(false)} onSaved={() => onNotice?.('飞书文档连接已保存')} />}
  </section>;
}
