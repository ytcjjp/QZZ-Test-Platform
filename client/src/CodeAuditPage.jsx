import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowUpRight, Bug, CheckCircle2, ChevronRight, Clock3,
  FolderOpen, GitBranch, LoaderCircle, Plus, RefreshCw, ScanSearch, Square, Trash2, X,
} from 'lucide-react';
import './code-audit.css';

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const runState = {
  running: { text: '巡检中', icon: LoaderCircle },
  completed: { text: '已完成', icon: CheckCircle2 },
  failed: { text: '失败', icon: AlertCircle },
  interrupted: { text: '已中断', icon: AlertCircle },
};
const findingKinds = {
  verified: '已证实问题',
  candidate: '待人工核实',
  unverified: '无法静态验证',
};

function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function SourceDialog({ onClose, onSave }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('local');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try { await onSave({ label: label.trim(), kind, location: location.trim() }); }
    catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal ca-source-modal" role="dialog" aria-modal="true" aria-labelledby="ca-source-title">
    <div className="modal-head"><h2 id="ca-source-title">登记代码源</h2><button className="icon-button" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
    <form className="modal-form" onSubmit={submit}>
      <label className="field"><span>名称</span><input autoFocus required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} placeholder="例如：甜点项目主仓库" /></label>
      <div className="field"><span>来源</span><div className="ca-source-modes" role="group" aria-label="代码源类型"><button type="button" aria-pressed={kind === 'local'} onClick={() => { setKind('local'); setLocation(''); }} disabled={busy}><FolderOpen size={15} />本机目录</button><button type="button" aria-pressed={kind === 'git'} onClick={() => { setKind('git'); setLocation(''); }} disabled={busy}><GitBranch size={15} />Git 仓库</button></div></div>
      <label className="field"><span>{kind === 'local' ? '服务器上的目录路径' : '仓库 HTTPS 地址'}</span><input required maxLength={500} value={location} onChange={(event) => setLocation(event.target.value)} disabled={busy} placeholder={kind === 'local' ? 'D:\\projects\\game-client' : 'https://github.com/组织/仓库.git'} autoComplete="off" spellCheck={false} /></label>
      {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !label.trim() || !location.trim()}>{busy ? '登记中…' : '登记来源'}</button></div>
    </form>
  </div></div>;
}

function DefectLink({ id, onOpenDefect }) {
  if (!id) return null;
  return onOpenDefect
    ? <button type="button" className="text-button ca-defect-link" onClick={() => onOpenDefect(id)} title={`打开缺陷 ${id}`}><Bug size={14} />缺陷 #{id.slice(0, 8)}<ArrowUpRight size={13} /></button>
    : <span className="ca-defect-link"><Bug size={14} />缺陷 #{id.slice(0, 8)}</span>;
}

function Finding({ finding, run, canCreateDefect, creating, onCreateDefect, onOpenDefect }) {
  const kind = findingKinds[finding.kind] ? finding.kind : 'candidate';
  return <article className="ca-finding">
    <div className="ca-finding-title"><span className={`ca-tag ca-${kind}`}>{findingKinds[kind]}</span><h4>{finding.title || '未命名发现'}</h4></div>
    <div className="ca-finding-body">
      {finding.expected && <p><strong>预期</strong><span>{finding.expected}</span></p>}
      {finding.actual && <p><strong>代码现状</strong><span>{finding.actual}</span></p>}
    </div>
    {Array.isArray(finding.evidence) && finding.evidence.length > 0 && <div className="ca-evidence" aria-label="源码证据">{finding.evidence.map((item, index) => <div key={`${item.path}-${item.line}-${index}`}>
      <code>{item.path || '未知文件'}{item.line ? `:${item.line}` : ''}</code>
      {item.excerpt && <pre>{item.excerpt}</pre>}
    </div>)}</div>}
    <div className="ca-finding-actions">
      {finding.defectId ? <DefectLink id={finding.defectId} onOpenDefect={onOpenDefect} />
        : canCreateDefect && run.state === 'completed' && kind !== 'unverified' && <button type="button" className="button secondary" disabled={creating} onClick={() => onCreateDefect(finding)}><Bug size={15} />{creating ? '创建中…' : '确认并创建缺陷'}</button>}
    </div>
  </article>;
}

function AuditResult({ run, source, caseSet, canWrite, canCreateDefect, creating, cancelling, onCancel, onCreateDefect, onOpenDefect }) {
  const [filter, setFilter] = useState('all');
  useEffect(() => setFilter('all'), [run.id]);
  const findings = Array.isArray(run.findings) ? run.findings : [];
  const coverage = Array.isArray(run.coverage?.caseResults) ? run.coverage.caseResults : [];
  const filtered = filter === 'all' ? findings : findings.filter((item) => item.kind === filter);
  const groups = [];
  for (const finding of filtered) {
    const key = finding.caseId || finding.caseTitle || 'other';
    let group = groups.find((entry) => entry.key === key);
    if (!group) { group = { key, title: finding.caseTitle || '其他检查项', findings: [] }; groups.push(group); }
    group.findings.push(finding);
  }
  const state = runState[run.state] || { text: run.state || '等待中', icon: Clock3 };
  const StateIcon = state.icon;
  return <section className="ca-result" aria-label="巡检结果">
    <div className="ca-result-head"><div><div className="ca-run-status"><StateIcon size={17} className={run.state === 'running' ? 'spin' : undefined} /><strong>{state.text}</strong><span>{date(run.startedAt)}</span></div><h2>{caseSet?.title || run.caseTitle || '用例集巡检'}</h2><p>{source?.label || run.sourceLabel || '代码源'}{run.revision && <> · <code title={run.revision}>{run.revision.slice(0, 12)}</code></>}</p></div><span className="ca-result-count">{findings.length} 项发现</span></div>
    {run.summary && <p className="ca-run-summary">{run.summary}</p>}
    {run.error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{run.error}</span></div>}
    {Array.isArray(run.warnings) && run.warnings.map((warning, index) => <div className="ca-warning" key={index}><AlertCircle size={15} /><span>{typeof warning === 'string' ? warning : warning.message || String(warning)}</span></div>)}
    {Array.isArray(run.changedPaths) && run.changedPaths.length > 0 && <details className="ca-changed"><summary>变更文件 · {run.changedPaths.length}</summary><div>{run.changedPaths.map((path) => <code key={path}>{path}</code>)}</div></details>}
    {run.state === 'running' && <div className="ca-loading" role="status"><span><LoaderCircle size={18} className="spin" />正在检查代码和资源…</span>{canWrite && <button type="button" className="button secondary" disabled={cancelling} onClick={onCancel}><Square size={14} />{cancelling ? '取消中…' : '取消巡检'}</button>}</div>}
    {run.state === 'completed' && <>
      {coverage.length > 0 && <section className="ca-coverage" aria-label="用例静态检查范围"><div className="ca-coverage-head"><h3>用例检查范围</h3><span>{coverage.length} 条用例 · 扫描 {run.coverage.scannedFiles ?? 0} 个文件{run.coverage.truncated ? ' · 部分文件未纳入' : ''}</span></div><div className="ca-coverage-scroll"><table><tbody>{coverage.map((item, index) => <tr key={`${item.caseId || item.caseTitle}-${index}`}><td>{item.caseTitle || '未命名用例'}</td><td>{item.result || '未验证'}</td></tr>)}</tbody></table></div></section>}
      <div className="ca-filters" role="group" aria-label="发现类型筛选"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 <span>{findings.length}</span></button>{Object.entries(findingKinds).map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} <span>{findings.filter((item) => item.kind === key).length}</span></button>)}</div>
      {!filtered.length ? <div className="ca-empty">{findings.length ? '这一类暂无发现' : '本轮未发现可报告的问题；游戏内表现仍需实际执行验证。'}</div> : groups.map((group) => <section className="ca-case-group" key={group.key}><h3>{group.title}</h3>{group.findings.map((finding) => <Finding key={finding.id} finding={finding} run={run} canCreateDefect={canCreateDefect} creating={creating.has(finding.id)} onCreateDefect={onCreateDefect} onOpenDefect={onOpenDefect} />)}</section>)}
    </>}
  </section>;
}

export default function CodeAuditPage({ project, isAdmin, canWrite, canCreateDefect, showError, onNotice, onOpenDefect }) {
  const [sources, setSources] = useState([]);
  const [cases, setCases] = useState([]);
  const [runs, setRuns] = useState([]);
  const [sourceId, setSourceId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sourceDialog, setSourceDialog] = useState(false);
  const [autoCreateVerified, setAutoCreateVerified] = useState(false);
  const [creating, setCreating] = useState(new Set());
  const [refreshSerial, setRefreshSerial] = useState(0);
  const projectId = project.id;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([
      request(`/api/code-audit/sources?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal }),
      request(`/api/cases?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal }),
      request(`/api/code-audit/runs?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal }),
    ]).then(([sourceData, caseData, runData]) => {
      if (!active) return;
      const nextSources = sourceData.sources || [];
      const nextCases = caseData.cases || [];
      const nextRuns = runData.runs || [];
      setSources(nextSources); setCases(nextCases); setRuns(nextRuns);
      setSourceId((current) => nextSources.some((item) => item.id === current) ? current : nextSources[0]?.id || '');
      setCaseId((current) => nextCases.some((item) => item.id === current) ? current : nextCases[0]?.id || '');
      setSelectedRunId((current) => nextRuns.some((item) => item.id === current) ? current : nextRuns[0]?.id || '');
    }).catch((failure) => { if (active && failure.name !== 'AbortError') { setError(failure.message); showError?.(failure.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [projectId, refreshSerial]);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    let active = true; let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const result = await request(`/api/code-audit/runs/${encodeURIComponent(selectedRunId)}?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal });
        if (!active) return;
        setRun(result.run);
        setRuns((old) => old.map((item) => item.id === result.run.id ? result.run : item));
        setError('');
        if (result.run.state === 'running') timer = setTimeout(poll, 3000);
      } catch (failure) {
        if (!active || failure.name === 'AbortError') return;
        setError(failure.message);
        timer = setTimeout(poll, 5000);
      }
    }
    setRun(null); void poll();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [projectId, selectedRunId]);

  async function registerSource(input) {
    const result = await request('/api/code-audit/sources', { method: 'POST', body: JSON.stringify({ projectId, ...input }) });
    setSources((old) => [...old, result.source]); setSourceId(result.source.id); setSourceDialog(false);
    onNotice?.('代码源已登记');
  }

  async function deleteSource(source) {
    if (!isAdmin || !window.confirm(`删除代码源“${source.label}”？历史巡检记录会保留。`)) return;
    setError('');
    try {
      await request(`/api/code-audit/sources/${encodeURIComponent(source.id)}`, {
        method: 'DELETE', body: JSON.stringify({ projectId }),
      });
      const remaining = sources.filter((item) => item.id !== source.id);
      setSources(remaining);
      setSourceId((current) => current === source.id ? remaining[0]?.id || '' : current);
      onNotice?.('代码源已删除，历史巡检记录保留');
    } catch (failure) { setError(failure.message); showError?.(failure.message); }
  }

  async function start() {
    if (!sourceId || !caseId || !canWrite || starting) return;
    setStarting(true); setError('');
    try {
      const result = await request('/api/code-audit/runs', { method: 'POST', body: JSON.stringify({ projectId, sourceId, caseId, autoCreateVerified: autoCreateVerified && canCreateDefect }) });
      setRuns((old) => [result.run, ...old.filter((item) => item.id !== result.run.id)]);
      setSelectedRunId(result.run.id); setRun(result.run);
      onNotice?.('巡检已开始');
    } catch (failure) { setError(failure.message); showError?.(failure.message); }
    finally { setStarting(false); }
  }

  async function createDefect(finding) {
    if (creating.has(finding.id)) return;
    setCreating((old) => new Set(old).add(finding.id)); setError('');
    try {
      const result = await request(`/api/code-audit/runs/${encodeURIComponent(run.id)}/findings/${encodeURIComponent(finding.id)}/defect`, {
        method: 'POST', body: JSON.stringify({ projectId }),
      });
      setRun((old) => old?.id === run.id ? result.run || { ...old, findings: old.findings.map((item) => item.id === finding.id ? { ...item, defectId: result.defect.id } : item) } : old);
      onNotice?.(`缺陷 #${result.defect.id.slice(0, 8)} 已创建`);
    } catch (failure) { setError(failure.message); showError?.(failure.message); }
    finally { setCreating((old) => { const next = new Set(old); next.delete(finding.id); return next; }); }
  }

  async function cancelRun() {
    if (!run || run.state !== 'running' || cancelling) return;
    setCancelling(true); setError('');
    try {
      const result = await request(`/api/code-audit/runs/${encodeURIComponent(run.id)}`, {
        method: 'DELETE', body: JSON.stringify({ projectId }),
      });
      if (result.run) {
        setRun(result.run);
        setRuns((old) => old.map((item) => item.id === result.run.id ? result.run : item));
      }
      onNotice?.('巡检已取消');
    } catch (failure) { setError(failure.message); showError?.(failure.message); }
    finally { setCancelling(false); }
  }

  const currentRun = run?.id === selectedRunId ? run : null;
  const selectedSource = sources.find((item) => item.id === sourceId);
  const activeRunSource = sources.find((item) => item.id === currentRun?.sourceId);
  const activeRunCase = cases.find((item) => item.id === currentRun?.caseId);
  const hasRunning = runs.some((item) => item.state === 'running');
  const sortedRuns = useMemo(() => [...runs].sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0)), [runs]);

  return <section className="workspace-section ca-page">
    <div className="section-heading"><div><span className="eyebrow">CODE AUDIT</span><h1>AI 代码巡检</h1></div><div className="heading-actions"><button className="icon-button" type="button" title="刷新巡检记录" aria-label="刷新巡检记录" disabled={loading} onClick={() => setRefreshSerial((value) => value + 1)}><RefreshCw size={16} className={loading ? 'spin' : undefined} /></button>{isAdmin && <button className="button secondary" type="button" onClick={() => setSourceDialog(true)}><Plus size={16} />登记代码源</button>}</div></div>
    <section className="ca-controls" aria-label="巡检配置"><div className="ca-control-grid"><label className="field"><span>代码源</span><select value={sourceId} disabled={loading || starting} onChange={(event) => setSourceId(event.target.value)}><option value="">选择代码源</option>{sources.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="field"><span>用例集</span><select value={caseId} disabled={loading || starting} onChange={(event) => setCaseId(event.target.value)}><option value="">选择用例集</option>{cases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      {selectedSource && <div className="ca-source-detail">{selectedSource.kind === 'git' ? <GitBranch size={15} /> : <FolderOpen size={15} />}<span>{selectedSource.label}</span>{selectedSource.location && <code title={selectedSource.location}>{selectedSource.location}</code>}{selectedSource.lastRevision && <small>上次检查 {selectedSource.lastRevision.slice(0, 12)}</small>}{isAdmin && <button className="icon-button" type="button" title={`删除代码源 ${selectedSource.label}`} aria-label={`删除代码源 ${selectedSource.label}`} onClick={() => deleteSource(selectedSource)}><Trash2 size={15} /></button>}</div>}
      <div className="ca-control-actions"><label className="check-field"><input type="checkbox" checked={autoCreateVerified && canCreateDefect} disabled={!canWrite || !canCreateDefect || starting} onChange={(event) => setAutoCreateVerified(event.target.checked)} /><span>自动创建已证实的资源缺陷</span></label><button className="button primary" type="button" disabled={!canWrite || !sourceId || !caseId || loading || starting || hasRunning} onClick={start}>{starting ? <LoaderCircle size={16} className="spin" /> : <ScanSearch size={16} />}{starting ? '启动中…' : '检查更新并巡检'}</button></div>
      {autoCreateVerified && canCreateDefect && <p className="ca-notice">自动创建的缺陷会进入“当前缺陷”，并按已配置的规则通知飞书群。</p>}
    </section>
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" title="关闭" onClick={() => setError('')}><X size={15} /></button></div>}
    <section className="ca-history" aria-label="巡检历史"><div className="ca-history-head"><h2>巡检记录</h2><span>{runs.length} 次</span></div>
      {loading ? <div className="ca-empty"><LoaderCircle size={16} className="spin" />正在加载…</div> : !sortedRuns.length ? <div className="ca-empty">暂无巡检记录</div> : <div className="ca-history-list">{sortedRuns.map((item) => {
        const status = runState[item.state] || { text: item.state || '等待中', icon: Clock3 };
        const StatusIcon = status.icon;
        return <button key={item.id} type="button" className={`ca-history-item ${selectedRunId === item.id ? 'selected' : ''}`} onClick={() => setSelectedRunId(item.id)} aria-current={selectedRunId === item.id ? 'true' : undefined}><span className="ca-history-main"><strong>{cases.find((entry) => entry.id === item.caseId)?.title || item.caseTitle || '用例集巡检'}</strong><small>{sources.find((entry) => entry.id === item.sourceId)?.label || item.sourceLabel || '代码源'} · {date(item.startedAt)}</small></span><span className={`ca-history-state state-${item.state}`}><StatusIcon size={15} className={item.state === 'running' ? 'spin' : undefined} />{status.text}</span><ChevronRight size={17} /></button>;
      })}</div>}
    </section>
    {selectedRunId && (currentRun ? <AuditResult key={currentRun.id} run={currentRun} source={activeRunSource} caseSet={activeRunCase} canWrite={canWrite} canCreateDefect={canCreateDefect} creating={creating} cancelling={cancelling} onCancel={cancelRun} onCreateDefect={createDefect} onOpenDefect={onOpenDefect} /> : <div className="ca-empty" role="status"><LoaderCircle size={17} className="spin" />正在读取巡检结果…</div>)}
    {sourceDialog && isAdmin && <SourceDialog onClose={() => setSourceDialog(false)} onSave={registerSource} />}
  </section>;
}
