import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import FeishuConnection, { FeishuBrowserStatus, FeishuConnectionHelp } from "./FeishuConnection";
import "./ai-documents.css";

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "请求失败，请稍后重试");
  return data;
}

function MapBranch({ node, root = false }) {
  return (
    <li className={root ? "ai-preview-root" : ""}>
      {node.children?.length ? (
        <details
          open={root || node.children.some((child) => child.children?.length)}
        >
          <summary>{node.title}</summary>
          <ul>
            {node.children.map((child) => (
              <MapBranch key={child.id} node={child} />
            ))}
          </ul>
        </details>
      ) : (
        <span>{node.title}</span>
      )}
    </li>
  );
}

export default function AiDocuments({
  config = {},
  projects = [],
  userId,
  activeProjectId,
  registerCloseGuard,
  canWrite,
  canSave,
  isAdmin = false,
  onRefresh,
  showError,
  onNotice,
}) {
  const [documents, setDocuments] = useState([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(new Set());
  const [previewId, setPreviewId] = useState("");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("load");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [answers, setAnswers] = useState("");
  const [projectId, setProjectId] = useState("");
  const [savedTargets, setSavedTargets] = useState(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const [cacheStatus, setCacheStatus] = useState("loading");
  const [cacheRetry, setCacheRetry] = useState(0);
  const [recovery, setRecovery] = useState(null);
  const input = useRef(null);
  const alive = useRef(true);
  const pending = useRef(new Set());
  const operation = useRef(0);
  const locked = useRef(false);
  const previousWrite = useRef(canWrite);
  const draftSnapshot = useRef(null);
  const draftVersion = useRef(null);
  const saveQueue = useRef(Promise.resolve());
  const saveRevision = useRef(0);
  const skipFirstSave = useRef(false);
  const localBackup = useRef(true);
  const cloudBackup = useRef(true);
  const recovering = useRef(false);
  const localKey = `qzz-ai-documents:${userId || "anonymous"}:${activeProjectId}`;
  useEffect(() => {
    alive.current = true;
    const unsafe = () => Boolean(draftSnapshot.current && !localBackup.current && !cloudBackup.current);
    const beforeClose = () => !unsafe() || window.confirm("临时文档草稿未能保存，关闭会丢失当前修改。确定关闭？");
    const navigation = (event) => { if (!beforeClose()) event.preventDefault(); };
    const unload = (event) => { if (unsafe()) { event.preventDefault(); event.returnValue = ""; } };
    registerCloseGuard?.(beforeClose);
    window.addEventListener("qzz-before-navigate", navigation);
    window.addEventListener("beforeunload", unload);
    return () => {
      if (draftSnapshot.current && !cloudBackup.current) queueDraftSave(draftSnapshot.current);
      registerCloseGuard?.(null);
      window.removeEventListener("qzz-before-navigate", navigation);
      window.removeEventListener("beforeunload", unload);
      alive.current = false;
      operation.current += 1;
      pending.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    const token = ++operation.current;
    locked.current = true;
    Promise.all([call("/api/ai/documents"), call(`/api/ai/draft?projectId=${encodeURIComponent(activeProjectId)}`)])
      .then(([data, cached]) => {
        if (alive.current && operation.current === token) {
          const rows = data.documents || [];
          setDocuments(rows);
          draftVersion.current = cached.saved?.updatedAt ?? null;
          let local = null;
          try { local = JSON.parse(localStorage.getItem(localKey) || "null"); } catch { /* Use cloud copy. */ }
          const state = local && local.baseUpdatedAt === draftVersion.current ? local.state : cached.saved?.state;
          if (local && local.baseUpdatedAt !== draftVersion.current) {
            setRecovery(local);
            try { localStorage.setItem(`${localKey}:recovery`, JSON.stringify(local)); } catch { /* Keep in memory. */ }
            setCacheStatus("conflict");
          } else {
            try { setRecovery(JSON.parse(localStorage.getItem(`${localKey}:recovery`) || "null")); } catch { setRecovery(null); }
            setCacheStatus("saved");
          }
          skipFirstSave.current = !local || local.baseUpdatedAt !== draftVersion.current;
          restoreLegacyState(state, rows);
          setCacheReady(true);
        }
      })
      .catch((failure) => {
        if (operation.current === token) {
          setCacheReady(false);
          setCacheStatus("load-error");
          report(failure);
        }
      })
      .finally(() => {
        if (alive.current && operation.current === token) {
          locked.current = false;
          setBusy("");
        }
      });
  }, [activeProjectId, cacheRetry]);
  function restoreLegacyState(state, rows) {
    const originalIds = Array.isArray(state?.selectedDocumentIds) ? state.selectedDocumentIds : rows.slice(0, 5).map((row) => row.id);
    const selectedIds = originalIds.filter((id) => rows.some((row) => row.id === id)).slice(0, 5);
    setSelectedDocumentIds(new Set(selectedIds));
    setResult(originalIds.length === selectedIds.length && state?.result && typeof state.result === "object" ? state.result : null);
    setAnswers(typeof state?.answers === "string" ? state.answers : "");
    setProjectId(typeof state?.projectId === "string" ? state.projectId : activeProjectId);
    setPreviewId(typeof state?.previewId === "string" ? state.previewId : "");
    setSavedTargets(new Set(Array.isArray(state?.savedTargets) ? state.savedTargets : []));
    if (originalIds.length !== selectedIds.length) setError("部分策划文档已移除，旧生成结果不再适用，请重新生成");
  }
  function queueDraftSave(snapshot) {
    const saving = saveQueue.current.then(async () => {
      const result = await request("/api/ai/draft", { method: "PUT", body: JSON.stringify({ ...snapshot, baseUpdatedAt: draftVersion.current }) });
      draftVersion.current = result.updatedAt;
      return result;
    });
    saveQueue.current = saving.catch(() => {});
    return saving;
  }
  draftSnapshot.current = cacheReady && canWrite ? {
    projectId: activeProjectId,
    state: { result, answers, projectId, previewId, selectedDocumentIds: [...selectedDocumentIds], savedTargets: [...savedTargets] },
  } : null;
  useEffect(() => {
    const snapshot = draftSnapshot.current;
    if (!snapshot) return;
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    const revision = ++saveRevision.current;
    cloudBackup.current = false;
    try { localStorage.setItem(localKey, JSON.stringify({ ...snapshot, baseUpdatedAt: draftVersion.current })); localBackup.current = true; }
    catch { localBackup.current = false; }
    setCacheStatus(localBackup.current ? "saving" : "failed");
    const timer = setTimeout(() => queueDraftSave(snapshot)
      .then(() => { if (alive.current && revision === saveRevision.current) {
        cloudBackup.current = true;
        try { localStorage.removeItem(localKey); } catch { /* Cloud copy is durable. */ }
        if (recovering.current) {
          try { localStorage.removeItem(`${localKey}:recovery`); } catch { /* Cloud copy is durable. */ }
          recovering.current = false;
        }
        setCacheStatus("saved");
      } })
      .catch(() => { if (alive.current && revision === saveRevision.current) setCacheStatus(localBackup.current ? "error" : "failed"); }), 450);
    return () => clearTimeout(timer);
  }, [cacheReady, activeProjectId, result, answers, projectId, previewId, selectedDocumentIds, savedTargets, canWrite]);
  useEffect(() => {
    if (projectId && !projects.some((project) => project.id === projectId))
      setProjectId("");
  }, [projects, projectId]);
  useEffect(() => {
    if (previousWrite.current && !canWrite) {
      operation.current += 1;
      pending.current.forEach((controller) => controller.abort());
      locked.current = false;
      setBusy("");
    }
    previousWrite.current = canWrite;
  }, [canWrite]);
  async function call(path, options = {}) {
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      return await request(path, { ...options, signal: controller.signal });
    } finally {
      pending.current.delete(controller);
    }
  }
  function report(failure) {
    if (failure.name === "AbortError" || !alive.current) return;
    setError(failure.message);
    showError?.(failure.message);
  }
  function invalidateResult() {
    setResult(null);
    setAnswers("");
    setSavedTargets(new Set());
  }
  async function importSources(files, link) {
    if (!canWrite || !cacheReady || locked.current) return;
    const selected = files ? Array.from(files) : [];
    if (!selected.length && !link?.trim()) return;
    if (selected.length + documents.length + (link ? 1 : 0) > 20) {
      setError("当前账号最多保留 20 份策划文档，请先移除旧文档");
      return;
    }
    if (
      selected.some(
        (file) => !/\.(docx?|pdf|md|markdown|txt)$/i.test(file.name),
      )
    ) {
      setError("请选择 Word、PDF、Markdown 或 TXT 文档");
      return;
    }
    const token = ++operation.current;
    locked.current = true;
    setBusy("import");
    setError("");
    try {
      const sources = link ? [link.trim()] : selected;
      for (const source of sources) {
        let body;
        if (typeof source === "string") body = JSON.stringify({ url: source });
        else {
          body = new FormData();
          body.append("file", source);
        }
        const data = await call("/api/ai/documents", { method: "POST", body });
        if (!alive.current || operation.current !== token) return;
        setDocuments((current) => [...current, data.document]);
        setSelectedDocumentIds((current) => current.size < 5 ? new Set([...current, data.document.id]) : current);
        setPreviewId(data.document.id);
        invalidateResult();
      }
      if (link) setUrl("");
    } catch (failure) {
      if (operation.current === token) report(failure);
    } finally {
      if (alive.current && operation.current === token) {
        locked.current = false;
        setBusy("");
        if (input.current) input.current.value = "";
      }
    }
  }
  async function removeDocument(document) {
    if (!canWrite || !cacheReady || locked.current) return;
    locked.current = true;
    setBusy("remove");
    setError("");
    try {
      await call(`/api/ai/documents/${encodeURIComponent(document.id)}`, {
        method: "DELETE",
      });
      if (!alive.current) return;
      setDocuments((current) =>
        current.filter((doc) => doc.id !== document.id),
      );
      setSelectedDocumentIds((current) => { const next = new Set(current); next.delete(document.id); return next; });
      if (previewId === document.id) setPreviewId("");
      invalidateResult();
    } catch (failure) {
      report(failure);
    } finally {
      if (alive.current) {
        locked.current = false;
        setBusy("");
      }
    }
  }
  async function generate(confirmed = false) {
    if (
      !canWrite ||
      !cacheReady ||
      locked.current ||
      !config.aiConfigured ||
      !selectedDocumentIds.size
    )
      return;
    const token = ++operation.current;
    locked.current = true;
    setBusy("generate");
    setError("");
    try {
      const data = await call("/api/ai/generate", {
        method: "POST",
        body: JSON.stringify({
          documentIds: [...selectedDocumentIds],
          clarifications: answers.trim(),
          confirmed,
        }),
      });
      if (!alive.current || operation.current !== token) return;
        setResult(data);
      setSavedTargets(new Set());
    } catch (failure) {
      if (operation.current === token) report(failure);
    } finally {
      if (alive.current && operation.current === token) {
        locked.current = false;
        setBusy("");
      }
    }
  }
  function cancelGeneration() {
    operation.current += 1;
    pending.current.forEach((controller) => controller.abort());
    locked.current = false;
    setBusy("");
    onNotice?.("已取消本次生成");
  }
  async function save() {
    if (
      !canSave ||
      !cacheReady ||
      locked.current ||
      !projectId ||
      !result?.tree ||
      savedTargets.has(projectId)
    )
      return;
    if (!result.title.trim()) {
      setError("请输入用例集名称");
      return;
    }
    const target = projectId;
    const token = ++operation.current;
    locked.current = true;
    setBusy("save");
    setError("");
    try {
      await call("/api/cases", {
        method: "POST",
        body: JSON.stringify({
          projectId: target,
          title: result.title.trim(),
          tree: { ...result.tree, title: result.title.trim() },
        }),
      });
      if (!alive.current || operation.current !== token) return;
      setSavedTargets((previous) => new Set([...previous, target]));
      onNotice?.("用例集已保存");
      await onRefresh?.();
    } catch (failure) {
      if (operation.current === token) report(failure);
    } finally {
      if (alive.current && operation.current === token) {
        locked.current = false;
        setBusy("");
      }
    }
  }
  function drop(event) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length)
      importSources(event.dataTransfer.files);
    else {
      const text =
        event.dataTransfer.getData("text/uri-list") ||
        event.dataTransfer.getData("text/plain");
      const link = text
        .split(/\r?\n/)
        .find((line) => line.trim() && !line.startsWith("#"))
        ?.trim();
      if (link) {
        setUrl(link);
        importSources(null, link);
      }
    }
  }
  const preview = documents.find((doc) => doc.id === previewId) || documents[0];
  const noGenerate =
    !canWrite || !cacheReady || !config.aiConfigured || !selectedDocumentIds.size || Boolean(busy);
  return (
    <section className="workspace-section ai-documents-section">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AI ASSISTANT</span>
          <h1>AI 用例生成</h1>
          <p>
            点点消用例规范
            {config.aiModel &&
              ` · ${config.aiModel} · ${config.aiReasoningEffort || ""}`}
          </p>
        </div>
        {(
          <button
            type="button"
            className="button secondary"
            onClick={() => setSettingsOpen(true)}
            disabled={Boolean(busy)}
          >
            <Settings2 size={16} />
            飞书浏览器连接
          </button>
        )}
      </div>
      {!config.aiConfigured && (
        <div className="notice">
          <AlertCircle size={17} />
          <span>
            {config.aiConfigError ||
              "AI 服务尚未配置，请联系管理员配置本机 AI 服务。"}
          </span>
        </div>
      )}
      {!canWrite && (
        <div className="notice">
          <AlertCircle size={17} />
          <span>当前账号没有生成权限，请联系管理员。</span>
        </div>
      )}
      {(cacheReady || cacheStatus === "load-error") && <div className={`ai-cache-status ${recovery || ["error", "failed", "load-error"].includes(cacheStatus) ? "error" : ""}`} role="status">
        <span>{recovery ? "本机有未同步草稿，云端也已更新" : cacheStatus === "saving" ? "草稿保存中" : cacheStatus === "failed" ? "草稿保存失败，请检查网络和本机空间" : cacheStatus === "error" ? "草稿云端保存失败，本机副本已保留" : cacheStatus === "load-error" ? "草稿读取失败，暂不可编辑" : "草稿已自动保存"}</span>
        {recovery && <button type="button" className="text-button" onClick={() => {
          restoreLegacyState(recovery.state, documents);
          setRecovery(null);
          recovering.current = true;
          skipFirstSave.current = false;
        }}>恢复本机副本</button>}
        {cacheStatus === "load-error" && <button type="button" className="icon-button" aria-label="重试读取草稿" title="重试读取草稿" onClick={() => setCacheRetry((value) => value + 1)}><RefreshCw size={15} /></button>}
      </div>}
      {error && (
        <div className="inline-error ai-document-error" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          {/飞书|浏览器|Chrome|连接|登录|权限/.test(error) && <button type="button" className="text-button" onClick={() => setSettingsOpen(true)}>查看浏览器连接</button>}
          <button
            type="button"
            className="icon-button"
            title="关闭错误提示"
            aria-label="关闭文档错误"
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="ai-document-columns">
        <div className="ai-source-column">
          <div className="ai-source-heading">
            <h2>策划文档</h2>
            <span>本轮 {selectedDocumentIds.size} / 5 · 已存 {documents.length}</span>
          </div>
          <input
            ref={input}
            type="file"
            accept=".doc,.docx,.pdf,.md,.markdown,.txt"
            multiple
            hidden
            onChange={(event) => importSources(event.target.files)}
          />
          <div
            className={`ai-document-drop ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (canWrite && cacheReady && !busy) setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setDragging(false);
            }}
            onDrop={drop}
          >
            {busy === "import" ? (
              <LoaderCircle size={27} className="spin" />
            ) : (
              <Upload size={27} />
            )}
            <strong>
              {busy === "import"
                ? "正在读取策划文档…"
                : "拖入策划文档或飞书地址"}
            </strong>
            <span>Word / PDF / Markdown / TXT</span>
            <button
              type="button"
              className="button secondary"
              disabled={!canWrite || !cacheReady || Boolean(busy) || documents.length >= 20}
              onClick={() => input.current?.click()}
            >
              <Plus size={16} />
              选择文档
            </button>
          </div>
          <form
            className="ai-link-form"
            onSubmit={(event) => {
              event.preventDefault();
              importSources(null, url);
            }}
          >
            <label className="field">
              <span>飞书云文档地址</span>
              <div className="ai-link-input">
                <Link2 size={16} />
                <input
                  type="url"
                  placeholder="https://…feishu.cn/docx/…"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={!canWrite || !cacheReady || Boolean(busy)}
                  aria-label="飞书云文档地址"
                  required
                  maxLength={2000}
                />
              </div>
            </label>
            <button
              type="submit"
              className="button secondary"
              disabled={
                !canWrite ||
                !cacheReady ||
                Boolean(busy) ||
                !url.trim() ||
                documents.length >= 20
              }
            >
              导入链接
            </button>
          </form>
          <FeishuBrowserStatus isAdmin={isAdmin} onConfigure={() => setSettingsOpen(true)} disabled={Boolean(busy)} />
          <FeishuConnectionHelp isAdmin={isAdmin} onConfigure={() => setSettingsOpen(true)} />
          {documents.length > 0 && (
            <div className="ai-document-list">
              {documents.map((document) => (
                <div
                  className={`ai-source-item ${selectedDocumentIds.has(document.id) ? "selected" : ""}`}
                  key={document.id}
                >
                  <input type="checkbox" aria-label={`引用 ${document.name}`} checked={selectedDocumentIds.has(document.id)} disabled={!canWrite || !cacheReady || Boolean(busy) || !selectedDocumentIds.has(document.id) && selectedDocumentIds.size >= 5}
                    onChange={(event) => {
                      setSelectedDocumentIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked && next.size < 5) next.add(document.id);
                        else if (!event.target.checked) next.delete(document.id);
                        return next;
                      });
                      invalidateResult();
                    }} />
                  <button
                    type="button"
                    className="ai-source-preview-button"
                    onClick={() => setPreviewId(document.id)}
                    title={document.name}
                  >
                    <FileText size={18} />
                    <span>
                      <strong>{document.name}</strong>
                      <small>{document.chars.toLocaleString()} 字{document.warnings?.length ? ' · 有读取提醒' : ''}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      className="icon-button danger"
                      title={`移除 ${document.name}`}
                      aria-label={`移除 ${document.name}`}
                      disabled={Boolean(busy) || !cacheReady}
                      onClick={() => removeDocument(document)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {preview?.warnings?.length > 0 && <div className="feishu-import-warnings" role="status"><strong><AlertCircle size={15} />{preview.name} · 导入内容提醒</strong><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          {preview && (
            <details className="ai-source-preview">
              <summary>文档内容 · {preview.name}</summary>
              <pre>{preview.text}</pre>
            </details>
          )}
          <button
            type="button"
            className="button primary ai-document-generate"
            onClick={() => generate(false)}
            disabled={noGenerate}
          >
            {busy === "generate" ? (
              <>
                <LoaderCircle size={17} className="spin" />
                {config.aiMode === "codex"
                  ? "正在分析策划案及项目代码…"
                  : "正在生成…"}
              </>
            ) : (
              <>
                <Sparkles size={17} />
                生成用例集
              </>
            )}
          </button>
          {busy === "generate" && (
            <button
              type="button"
              className="button secondary"
              onClick={cancelGeneration}
            >
              <X size={16} />
              取消生成
            </button>
          )}
        </div>
        <div className="ai-output-column">
          <div className="ai-source-heading">
            <h2>用例集草稿</h2>
            <Bot size={20} />
          </div>
          {!result && (
            <div className="ai-document-empty">
              <FileText size={32} />
              <span>
                {busy === "generate" ? "正在分析策划文档…" : "暂无草稿"}
              </span>
            </div>
          )}
          {result?.questions?.length > 0 && (
            <div className="ai-clarifications">
              <h3>待确认规则</h3>
              <ol>
                {result.questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ol>
              <label className="field">
                <span>规则确认回答</span>
                <textarea
                  rows={4}
                  value={answers}
                  onChange={(event) => setAnswers(event.target.value)}
                  maxLength={12000}
                  disabled={Boolean(busy) || !cacheReady || !canWrite}
                  placeholder="按问题编号补充已确认的规则"
                />
              </label>
              <div className="ai-clarification-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={noGenerate || !answers.trim()}
                  onClick={() => generate(false)}
                >
                  提交回答并生成
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={noGenerate}
                  onClick={() => generate(true)}
                >
                  仅按明确规则生成
                </button>
              </div>
            </div>
          )}
          {result?.tree && (
            <>
              <div className="ai-save-controls">
                <label className="field">
                  <span>用例集名称</span>
                  <input
                    value={result.title}
                    onChange={(event) => {
                      setResult((previous) => ({
                        ...previous,
                        title: event.target.value,
                      }));
                      setSavedTargets(new Set());
                    }}
                    maxLength={200}
                    disabled={Boolean(busy)}
                  />
                </label>
                <label className="field">
                  <span>保存到项目组</span>
                  <select
                    aria-label="保存到项目组"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    disabled={Boolean(busy) || !cacheReady || !canSave}
                  >
                    <option value="">请选择项目组</option>
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button primary"
                  type="button"
                  onClick={save}
                  disabled={
                    !canSave ||
                    !cacheReady ||
                    !projectId ||
                    Boolean(busy) ||
                    !result.title.trim() ||
                    savedTargets.has(projectId)
                  }
                >
                  {savedTargets.has(projectId) ? (
                    <>
                      <Check size={16} />
                      已保存
                    </>
                  ) : busy === "save" ? (
                    "保存中…"
                  ) : (
                    "保存用例集"
                  )}
                </button>
              </div>
              <div className="ai-map-preview" aria-label="用例集草稿预览">
                <ul>
                  <MapBranch
                    node={{
                      ...result.tree,
                      title: result.title || result.tree.title,
                    }}
                    root
                  />
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
      {settingsOpen && (
        <FeishuConnection
          isAdmin={isAdmin}
          onClose={() => setSettingsOpen(false)}
          onSaved={() =>
            onNotice?.("飞书浏览器连接状态已更新")
          }
        />
      )}
    </section>
  );
}
