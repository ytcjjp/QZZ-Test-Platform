import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import MarkdownIt from "markdown-it";
import {
  AlertCircle,
  BookOpen,
  Bot,
  ChevronDown,
  Download,
  Eye,
  FileText,
  Grid2X2,
  Link2,
  List,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import "./workspace-documents.css";
import FeishuConnection, { FeishuBrowserStatus, FeishuConnectionHelp } from "./FeishuConnection";
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
const REQUIREMENT_STATUSES = ["草稿", "已确认", "已归档"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const CATEGORIES = [
  "未分类",
  "技术设计",
  "接口文档",
  "业务规则",
  "历史问题",
  "其他",
];
const PRESETS = {
  fine: { chunkMode: "window", chunkSize: 250, chunkOverlap: 50 },
  standard: { chunkMode: "window", chunkSize: 400, chunkOverlap: 80 },
  heading: { chunkMode: "heading", chunkSize: 800, chunkOverlap: 100 },
};
function useRequests(projectId, canWrite) {
  const active = useRef(true);
  const generation = useRef(0);
  const pending = useRef(/* @__PURE__ */ new Set());
  useEffect(() => {
    active.current = true;
    generation.current += 1;
    return () => {
      active.current = false;
      generation.current += 1;
      pending.current.forEach((controller) => controller.abort());
      pending.current.clear();
    };
  }, [projectId, canWrite]);
  const call = useCallback(async (url, options = {}) => {
    const token = generation.current;
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
        headers:
          options.body instanceof FormData
            ? options.headers
            : { "Content-Type": "application/json", ...options.headers },
      });
      const data = await response.json().catch(() => ({}));
      if (!active.current || token !== generation.current)
        throw new DOMException("操作已取消", "AbortError");
      if (!response.ok) {
        const failure = new Error(data.message || "请求失败，请稍后重试");
        failure.status = response.status;
        failure.data = data;
        throw failure;
      }
      return data;
    } finally {
      pending.current.delete(controller);
    }
  }, []);
  const cancel = useCallback(() => {
    generation.current += 1;
    pending.current.forEach((controller) => controller.abort());
    pending.current.clear();
  }, []);
  return { call, active, cancel };
}
function useUnsaved(dirty, busy = false) {
  const current = useRef({ dirty, busy });
  current.current = { dirty, busy };
  useEffect(() => {
    function unload(event) {
      if (current.current.dirty || current.current.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function navigate(event) {
      if (
        current.current.busy ||
        (current.current.dirty &&
          !window.confirm("当前内容尚未保存，确定放弃修改并离开吗？"))
      )
        event.preventDefault();
    }
    window.addEventListener("beforeunload", unload);
    window.addEventListener("qzz-before-navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("qzz-before-navigate", navigate);
    };
  }, []);
  return () =>
    !current.current.busy &&
    (!current.current.dirty ||
      window.confirm("当前内容尚未保存，确定放弃修改并关闭吗？"));
}
function Icon({ icon: Component, label, onClick, disabled, danger, pressed }) {
  return (
    <button
      type="button"
      className={`icon-button ${danger ? "danger" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Component size={17} />
    </button>
  );
}
function ErrorMessage({ error, children }) {
  return error ? (
    <div className="inline-error" role="alert">
      <AlertCircle size={16} />
      <span>{error}</span>
      {children}
    </div>
  ) : null;
}
function Empty({ children }) {
  return (
    <div className="ws-empty">
      <FileText size={25} />
      <span>{children}</span>
    </div>
  );
}
function stamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function bytes(value) {
  return value > 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : value > 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${value || 0} B`;
}
function sourceName(record) {
  return record.sourceUrl
    ? "飞书文档"
    : record.attachments?.length
      ? "文件导入"
      : "手动录入";
}
function json(method, body) {
  return { method, body: JSON.stringify(body) };
}
function isAbort(failure) {
  return failure.name === "AbortError";
}
function downloadMarkdown(content, title) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 150) || "文档"}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function MarkdownView({ content = "", outline = false }) {
  const prefix = useId().replace(/:/g, "");
  const rendered = useMemo(() => {
    const tokens = markdown.parse(content, {});
    const headings = [];
    tokens.forEach((token, index) => {
      if (token.type === "heading_open") {
        const id = `ws-${prefix}-${headings.length}`;
        token.attrSet("id", id);
        headings.push({
          id,
          title: tokens[index + 1]?.content || "",
          level: Number(token.tag.slice(1)),
        });
      }
    });
    return {
      html: markdown.renderer.render(tokens, markdown.options, {}),
      headings,
    };
  }, [content, prefix]);
  return (
    <div className={outline ? "ws-markdown-layout" : ""}>
      {outline && (
        <nav className="ws-outline" aria-label="文档大纲">
          <strong>大纲</strong>
          {rendered.headings.map((heading) => (
            <button
              type="button"
              key={heading.id}
              style={{
                paddingLeft: `${9 + Math.min(heading.level - 1, 3) * 9}px`,
              }}
              onClick={() =>
                document
                  .getElementById(heading.id)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            >
              {heading.title}
            </button>
          ))}
        </nav>
      )}
      <article
        className="ws-markdown"
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  busy,
  wide = false,
  className = "",
}) {
  const id = useId();
  return (
    <div className="modal-backdrop">
      <section
        className={`modal ws-modal ${wide ? "ws-wide-modal" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header className="modal-head">
          <h2 id={id}>{title}</h2>
          <Icon
            icon={X}
            label={`关闭${title}`}
            disabled={busy}
            onClick={onClose}
          />
        </header>
        {children}
      </section>
    </div>
  );
}
function Attachment({ attachment }) {
  const url = attachment.previewUrl || attachment.downloadUrl;
  return (
    <details className="ws-attachment">
      <summary>
        <FileText size={16} />
        <strong>{attachment.name}</strong>
        <span>{bytes(attachment.size)}</span>
      </summary>
      <div className="ws-attachment-body">
        <a className="button secondary" href={attachment.downloadUrl} download>
          <Download size={15} />
          下载原件
        </a>
        {attachment.extractionError && (
          <ErrorMessage error={attachment.extractionError} />
        )}
        {attachment.warnings?.map((warning, index) => (
          <p className="ws-warning" key={index}>
            {warning}
          </p>
        ))}
        {attachment.mimeType?.startsWith("image/") ? (
          <img className="ws-image-preview" src={url} alt={attachment.name} />
        ) : attachment.mimeType === "application/pdf" ? (
          <iframe
            className="ws-pdf-preview"
            src={url}
            title={attachment.name}
          />
        ) : attachment.extractedText ? (
          <pre className="ws-extracted-text">{attachment.extractedText}</pre>
        ) : (
          <span className="ws-muted">暂无可预览文本</span>
        )}
        {attachment.images?.length > 0 && (
          <details className="ws-document-images">
            <summary>文档图片 · {attachment.images.length}</summary>
            {attachment.images.map((image) => (
              <figure key={image.id}>
                <img
                  className="ws-image-preview"
                  src={image.previewUrl || image.downloadUrl}
                  alt={image.name}
                />
                <figcaption>{image.name}</figcaption>
              </figure>
            ))}
          </details>
        )}
      </div>
    </details>
  );
}
function SourceDialog({
  project,
  canWrite,
  isAdmin = false,
  onConfigureFeishu: configureExternal,
  record,
  knowledgeBase,
  onClose,
  onSaved,
}) {
  const { call, active } = useRequests(project.id, canWrite);
  const [current, setCurrent] = useState(record);
  const [title, setTitle] = useState(record?.title || "");
  const [body, setBody] = useState(record?.body || "");
  const [status, setStatus] = useState(record?.status || "草稿");
  const [priority, setPriority] = useState(record?.priority || "P2");
  const [category, setCategory] = useState("未分类");
  const [sourceUrl, setSourceUrl] = useState(record?.sourceUrl || "");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const onConfigureFeishu = configureExternal || (() => setFeishuOpen(true));
  const baseline = useRef(
    JSON.stringify([title, body, status, priority, sourceUrl, category]),
  );
  const dirty =
    files.length > 0 ||
    JSON.stringify([title, body, status, priority, sourceUrl, category]) !==
      baseline.current;
  const mayClose = useUnsaved(dirty, busy);
  const picker = useRef(null);
  const textPicker = useRef(null);
  const target = knowledgeBase
    ? `/api/knowledge-bases/${knowledgeBase.id}/documents`
    : "/api/requirements";
  function choose(incoming) {
    if (!canWrite || busy) return;
    setFiles((previous) => [...previous, ...incoming]);
    if (!title && incoming[0])
      setTitle(incoming[0].name.replace(/\.[^.]+$/, ""));
  }
  async function importText(file) {
    if (!file) return;
    try {
      const text = await file.text();
      if (active.current) {
        setBody(text);
        if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch {
      if (active.current) setError("无法读取文件");
    }
  }
  async function reload() {
    if (!current || !window.confirm("载入最新版本将放弃当前编辑，确定继续吗？"))
      return;
    setBusy(true);
    try {
      const data = await call(
        `/api/requirements/${current.id}?projectId=${project.id}`,
      );
      const value = data.requirement;
      setCurrent(value);
      setTitle(value.title);
      setBody(value.body || "");
      setStatus(value.status);
      setPriority(value.priority);
      setSourceUrl(value.sourceUrl || "");
      setFiles([]);
      baseline.current = JSON.stringify([
        value.title,
        value.body || "",
        value.status,
        value.priority,
        value.sourceUrl || "",
        category,
      ]);
      setConflict(false);
      setError("");
    } catch (failure) {
      if (!isAbort(failure)) setError(failure.message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (!canWrite || busy) return;
    setBusy(true);
    setError("");
    const fields = {
      projectId: project.id,
      title: title.trim(),
      body,
      sourceUrl: sourceUrl.trim(),
      ...(knowledgeBase ? { category } : { status, priority }),
    };
    let metadataSaved = false;
    try {
      let result;
      if (current) {
        result = (
          await call(
            `${target}/${current.id}`,
            json("PUT", { ...fields, revision: current.revision }),
          )
        ).requirement;
        setCurrent(result);
        metadataSaved = true;
        if (files.length) {
          const data = new FormData();
          data.append("projectId", project.id);
          data.append("revision", String(result.revision));
          files.forEach((file) => data.append("file", file));
          result = (
            await call(`/api/requirements/${current.id}/attachments`, {
              method: "POST",
              body: data,
            })
          ).requirement;
          setCurrent(result);
        }
      } else if (files.length) {
        const data = new FormData();
        Object.entries(fields).forEach(([key, value]) =>
          data.append(key, value),
        );
        files.forEach((file) => data.append("file", file));
        const response = await call(target, { method: "POST", body: data });
        result = response.requirement || response.document;
      } else {
        const response = await call(target, json("POST", fields));
        result = response.requirement || response.document;
      }
      if (active.current) onSaved(result);
    } catch (failure) {
      if (!isAbort(failure)) {
        setConflict(failure.status === 409);
        setError(
          `${metadataSaved ? "正文和属性已保存，附件上传未完成。" : ""}${failure.status === 409 ? "内容已被其他人修改，当前输入已保留。请载入最新版本后重新编辑。" : failure.message}`,
        );
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={knowledgeBase ? "上传知识文档" : record ? "编辑需求" : "新建需求"}
      busy={busy}
      onClose={() => mayClose() && onClose()}
    >
      <form className="modal-form ws-source-form" onSubmit={submit}>
        <label className="field">
          <span>{knowledgeBase ? "文档标题" : "需求标题"} *</span>
          <input
            value={title}
            required
            maxLength={200}
            disabled={!canWrite || busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="ws-body-label">
          <span>正文（Markdown）</span>
          <button
            type="button"
            className="text-button"
            disabled={!canWrite || busy}
            onClick={() => textPicker.current?.click()}
          >
            从文件导入正文
          </button>
          <input
            ref={textPicker}
            type="file"
            accept=".md,.txt"
            hidden
            onChange={(event) => {
              importText(event.target.files[0]);
              event.target.value = "";
            }}
          />
        </div>
        <textarea
          className="ws-source-body"
          aria-label={knowledgeBase ? "文档正文" : "需求正文"}
          value={body}
          rows={9}
          disabled={!canWrite || busy}
          onChange={(event) => setBody(event.target.value)}
        />
        <div
          className="ws-file-drop"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer.files.length)
              choose([...event.dataTransfer.files]);
            else {
              const url =
                event.dataTransfer.getData("text/uri-list") ||
                event.dataTransfer.getData("text/plain");
              if (canWrite && !busy && /^https:\/\//i.test(url.trim()))
                setSourceUrl(url.trim());
            }
          }}
        >
          <Upload size={22} />
          <button
            className="button secondary"
            type="button"
            disabled={!canWrite || busy}
            onClick={() => picker.current?.click()}
          >
            选择附件
          </button>
          <span>Word、PDF、Markdown、文本或图片</span>
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            accept=".doc,.docx,.pdf,.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp"
            onChange={(event) => {
              choose([...event.target.files]);
              event.target.value = "";
            }}
          />
        </div>
        {files.map((file, index) => (
          <div className="ws-upload-file" key={`${file.name}-${index}`}>
            <FileText size={16} />
            <span>{file.name}</span>
            <small>{bytes(file.size)}</small>
            <Icon
              icon={X}
              label={`移除附件 ${file.name}`}
              disabled={busy}
              onClick={() =>
                setFiles((previous) =>
                  previous.filter((_, item) => item !== index),
                )
              }
            />
          </div>
        ))}
        <label className="field">
          <span>飞书云文档地址</span>
          <input
            type="url"
            value={sourceUrl}
            disabled={!canWrite || busy}
            placeholder="https://…feishu.cn/docx/…"
            onChange={(event) => setSourceUrl(event.target.value)}
          />
        </label>
        <div className="feishu-source-help">
          <FeishuBrowserStatus isAdmin={isAdmin} onConfigure={onConfigureFeishu} disabled={busy} />
          <FeishuConnectionHelp
            isAdmin={isAdmin}
            onConfigure={onConfigureFeishu}
          />
        </div>
        <div className="ws-form-row">
          {knowledgeBase ? (
            <label className="field">
              <span>分类</span>
              <select
                value={category}
                disabled={!canWrite || busy}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORIES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="field">
                <span>状态</span>
                <select
                  value={status}
                  disabled={busy}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  {REQUIREMENT_STATUSES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>优先级</span>
                <select
                  value={priority}
                  disabled={busy}
                  onChange={(event) => setPriority(event.target.value)}
                >
                  {PRIORITIES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        {current?.attachments?.length > 0 && (
          <div className="ws-existing-files">
            {current.attachments.map((attachment) => (
              <Attachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        <ErrorMessage error={error}>
          {onConfigureFeishu && /飞书|浏览器|Chrome|连接|登录|权限/.test(error) && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={onConfigureFeishu}
            >
              查看浏览器连接
            </button>
          )}
          {conflict && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={reload}
            >
              载入最新版本
            </button>
          )}
        </ErrorMessage>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => mayClose() && onClose()}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              !canWrite ||
              busy ||
              !title.trim() ||
              (!body.trim() &&
                !files.length &&
                !sourceUrl.trim() &&
                !current?.attachments?.length)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存
          </button>
        </div>
      </form>
      {feishuOpen && <FeishuConnection isAdmin={isAdmin} onClose={() => setFeishuOpen(false)} />}
    </Modal>
  );
}
function DraftDialog({
  project,
  requirement,
  kind,
  canWrite,
  canAi,
  config,
  onClose,
  onSaved,
}) {
  const { call, active, cancel } = useRequests(project.id, canWrite && canAi);
  const aiOperation = useRef(0);
  const isPlan = kind === "plan";
  const [current, setCurrent] = useState(requirement);
  const [plans, setPlans] = useState([]);
  const [planId, setPlanId] = useState("");
  const planSnapshot = useRef(null);
  const [title, setTitle] = useState(`测试计划：${requirement.title}`);
  const [version, setVersion] = useState("");
  const [iteration, setIteration] = useState("");
  const [draft, setDraft] = useState(isPlan ? "" : requirement.analysis || "");
  const [source, setSource] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [sources, setSources] = useState([]);
  const [taskWarnings, setTaskWarnings] = useState([]);
  const [vision, setVision] = useState(null);
  const [taskNotice, setTaskNotice] = useState("");
  const baseline = useRef(JSON.stringify([draft, title, version, iteration]));
  const dirty =
    JSON.stringify([draft, title, version, iteration]) !== baseline.current;
  const mayClose = useUnsaved(dirty, Boolean(busy));
  const canGenerate = canWrite && canAi && Boolean(config?.aiConfigured);
  async function loadPlans() {
    const data = await call(
      `/api/test-plans?projectId=${project.id}&requirementId=${requirement.id}`,
    );
    setPlans(data.plans || []);
    return data.plans || [];
  }
  useEffect(() => {
    if (isPlan)
      loadPlans()
        .then((values) => {
          if (!canWrite && values[0]) choosePlan(values[0].id, values, true);
        })
        .catch((failure) => {
          if (!isAbort(failure)) setError(failure.message);
        });
  }, []);
  async function generate(revise = false) {
    if (!canGenerate || busy || (revise && !instruction.trim())) return;
    if (
      !revise &&
      draft.trim() &&
      dirty &&
      !window.confirm("重新生成将替换当前草稿，确定继续吗？")
    )
      return;
    const text = instruction.trim();
    const history = messages
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));
    const token = ++aiOperation.current;
    setBusy("ai");
    setError("");
    setTaskNotice("");
    if (revise) {
      setMessages((previous) => [...previous, { role: "user", content: text }]);
      setInstruction("");
    }
    try {
      const result = await call(
        "/api/workspace/ai",
        json("POST", {
          projectId: project.id,
          requirementId: requirement.id,
          task: revise ? "revise" : kind,
          outputType: kind,
          instructions: revise ? text : "",
          history,
          ...(revise
            ? {
                draft: {
                  type: kind,
                  title: isPlan ? title : requirement.title,
                  requirementId: requirement.id,
                  content: draft,
                  questions,
                },
              }
            : {}),
        }),
      );
      if (!active.current || aiOperation.current !== token) return;
      setDraft(result.content || "");
      setQuestions(result.questions || []);
      setSources(result.sources || []);
      setTaskWarnings(result.warnings || []);
      setVision(result.vision || null);
      if (isPlan && !planId && result.title) setTitle(result.title);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: revise
            ? "已按修改意见更新草稿，完整内容保留在当前文档。"
            : "已生成草稿，完整内容保留在当前文档。",
          label: revise ? "已更新草稿" : "已生成草稿",
        },
      ]);
    } catch (failure) {
      if (aiOperation.current === token && !isAbort(failure)) {
        setError(failure.message);
        setTaskWarnings(failure.data?.warnings || []);
      }
    } finally {
      if (active.current && aiOperation.current === token) setBusy("");
    }
  }
  function cancelGeneration() {
    aiOperation.current += 1;
    cancel();
    setBusy("");
    setTaskNotice("本轮生成已取消，当前草稿已保留。");
    if (isPlan)
      loadPlans().catch((failure) => {
        if (!isAbort(failure)) setError(failure.message);
      });
  }
  function choosePlan(id, available = plans, force = false) {
    const value = available.find((item) => item.id === id);
    if (
      !force &&
      dirty &&
      !window.confirm("切换测试计划将替换当前草稿，确定继续吗？")
    )
      return;
    planSnapshot.current = value || null;
    setPlanId(id);
    const nextTitle = value?.title || `测试计划：${requirement.title}`;
    setTitle(nextTitle);
    setVersion(value?.version || "");
    setIteration(value?.iteration || "");
    setDraft(value?.content || "");
    setMessages([]);
    setQuestions([]);
    setSources([]);
    setTaskWarnings([]);
    setVision(null);
    setConflict(false);
    setError("");
    baseline.current = JSON.stringify([
      value?.content || "",
      nextTitle,
      value?.version || "",
      value?.iteration || "",
    ]);
  }
  async function reloadLatest() {
    if (dirty && !window.confirm("载入最新版本将替换当前草稿，确定继续吗？"))
      return;
    setBusy("reload");
    setError("");
    try {
      if (isPlan) {
        const values = await loadPlans();
        const latest = values.find((item) => item.id === planId);
        if (!latest) throw new Error("测试计划已不存在，请另建计划保存草稿");
        choosePlan(planId, values, true);
      } else {
        const latest = (
          await call(
            `/api/requirements/${requirement.id}?projectId=${project.id}`,
          )
        ).requirement;
        setCurrent(latest);
        setDraft(latest.analysis || "");
        baseline.current = JSON.stringify([
          latest.analysis || "",
          title,
          version,
          iteration,
        ]);
        setMessages([]);
        setQuestions([]);
        setSources([]);
        setConflict(false);
      }
    } catch (failure) {
      if (!isAbort(failure)) setError(failure.message);
    } finally {
      if (active.current) setBusy("");
    }
  }
  async function save() {
    if (!canWrite || busy || !draft.trim() || (isPlan && !title.trim())) return;
    setBusy("save");
    setError("");
    try {
      if (isPlan) {
        const result = await call(
          `/api/test-plans${planId ? `/${planId}` : ""}`,
          json(planId ? "PUT" : "POST", {
            projectId: project.id,
            requirementId: requirement.id,
            title: title.trim(),
            version,
            iteration,
            content: draft,
            ...(planId ? { revision: planSnapshot.current.revision } : {}),
          }),
        );
        planSnapshot.current = result.plan;
        setPlanId(result.plan.id);
        await loadPlans();
      } else {
        const result = await call(
          `/api/requirements/${requirement.id}`,
          json("PUT", {
            projectId: project.id,
            revision: current.revision,
            analysis: draft,
          }),
        );
        setCurrent(result.requirement);
      }
      if (!active.current) return;
      baseline.current = JSON.stringify([draft, title, version, iteration]);
      setConflict(false);
      onSaved(isPlan ? "测试计划已写入" : "需求分析已保存");
    } catch (failure) {
      if (!isAbort(failure)) {
        setConflict(failure.status === 409);
        setError(
          failure.status === 409
            ? "已保存版本被其他人修改，当前草稿已保留。请先导出草稿或载入最新版本后重新编辑。"
            : failure.message,
        );
      }
    } finally {
      if (active.current) setBusy("");
    }
  }
  return (
    <Modal
      wide
      className="ws-draft-modal"
      title={`${isPlan ? "测试计划" : "需求分析"}：${requirement.title}`}
      busy={Boolean(busy)}
      onClose={() => mayClose() && onClose()}
    >
      <div className="ws-draft-workspace">
        <div className="ws-draft-main">
          {isPlan && (
            <div className="ws-plan-meta">
              <label className="field">
                <span>写入目标</span>
                <select
                  aria-label="写入测试计划"
                  value={planId}
                  disabled={Boolean(busy)}
                  onChange={(event) => choosePlan(event.target.value)}
                >
                  <option value="">新建测试计划</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>计划名称 *</span>
                <input
                  value={title}
                  maxLength={200}
                  disabled={!canWrite || Boolean(busy)}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <div className="ws-form-row">
                <label className="field">
                  <span>版本</span>
                  <input
                    value={version}
                    maxLength={100}
                    disabled={!canWrite || Boolean(busy)}
                    onChange={(event) => setVersion(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>迭代</span>
                  <input
                    value={iteration}
                    maxLength={100}
                    disabled={!canWrite || Boolean(busy)}
                    onChange={(event) => setIteration(event.target.value)}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="ws-document-tabs">
            <div role="tablist" aria-label="文档视图">
              <button
                type="button"
                role="tab"
                aria-selected={!source}
                onClick={() => setSource(false)}
              >
                预览
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={source}
                onClick={() => setSource(true)}
              >
                源码
              </button>
            </div>
            <span>{dirty ? "未保存" : "已保存"}</span>
          </div>
          <div className="ws-draft-editor">
            {source ? (
              <textarea
                aria-label={`${isPlan ? "测试计划" : "需求分析"} Markdown 源码`}
                value={draft}
                readOnly={!canWrite}
                disabled={Boolean(busy)}
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : draft ? (
              <MarkdownView outline content={draft} />
            ) : (
              <Empty>{isPlan ? "暂无测试计划草稿" : "暂无需求分析"}</Empty>
            )}
          </div>
          {questions.length > 0 && (
            <details className="ws-result-details">
              <summary>待澄清项 · {questions.length}</summary>
              <ul>
                {questions.map((question, index) => (
                  <li key={index}>
                    {typeof question === "string"
                      ? question
                      : question.question ||
                        question.title ||
                        JSON.stringify(question)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {sources.length > 0 && (
            <details className="ws-result-details">
              <summary>参考资料 · {sources.length}</summary>
              {sources.map((item, index) => (
                <p key={index}>
                  {item.title ||
                    item.documentTitle ||
                    item.documentName ||
                    item.source ||
                    `资料 ${index + 1}`}
                </p>
              ))}
            </details>
          )}
          {taskNotice && (
            <p className="ws-muted" role="status">
              {taskNotice}
            </p>
          )}
          {vision && (
            <p className="ws-muted">
              本轮实际附入模型 {vision.attachedImages || 0} 张图片。
            </p>
          )}
          {taskWarnings.map((warning, index) => (
            <p className="ws-warning" key={index}>
              {typeof warning === "string"
                ? warning
                : warning.message || JSON.stringify(warning)}
            </p>
          ))}
          <ErrorMessage error={error}>
            {conflict && (
              <button
                type="button"
                className="text-button"
                disabled={Boolean(busy)}
                onClick={reloadLatest}
              >
                载入最新版本
              </button>
            )}
          </ErrorMessage>
        </div>
        <aside className="ws-ai-chat">
          <header>
            <Bot size={17} />
            <strong>对话改稿</strong>
          </header>
          <div className="ws-chat-messages">
            {messages.map((message, index) => (
              <div key={index} className={`ws-chat-message ${message.role}`}>
                <strong>{message.role === "user" ? "我" : "AI"}</strong>
                <span>{message.label || message.content}</span>
              </div>
            ))}
            {busy === "ai" && (
              <div className="ws-chat-wait">
                <LoaderCircle size={17} className="spin" />
                正在处理
              </div>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              generate(true);
            }}
          >
            <textarea
              aria-label="AI 改稿意见"
              value={instruction}
              disabled={!canGenerate || Boolean(busy)}
              onChange={(event) => setInstruction(event.target.value)}
              rows={4}
              placeholder="输入修改意见"
            />
            <button
              type="submit"
              className="button primary"
              disabled={
                !canGenerate ||
                Boolean(busy) ||
                !draft.trim() ||
                !instruction.trim()
              }
            >
              <Send size={15} />
              发送
            </button>
          </form>
        </aside>
      </div>
      <footer className="ws-draft-actions">
        {busy === "ai" && (
          <button
            type="button"
            className="button secondary"
            onClick={cancelGeneration}
          >
            取消生成
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={Boolean(busy)}
          onClick={() => mayClose() && onClose()}
        >
          关闭
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!draft.trim()}
          onClick={() =>
            downloadMarkdown(
              draft,
              isPlan ? title : `${requirement.title}-需求分析`,
            )
          }
        >
          <Download size={16} />
          导出 Markdown
        </button>
        {canWrite && (
          <>
            <button
              type="button"
              className="button secondary"
              disabled={!canGenerate || Boolean(busy)}
              onClick={() => generate()}
            >
              <RefreshCw size={16} />
              {draft.trim() ? "重新生成" : "生成草稿"}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                Boolean(busy) || !draft.trim() || (isPlan && !title.trim())
              }
              onClick={save}
            >
              <Save size={16} />
              {isPlan ? "写入测试计划" : "保存分析"}
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}
function RequirementsPage({
  project,
  canWrite,
  isAdmin = false,
  canAi = false,
  canCasesView = false,
  canGenerate = false,
  config = {},
  onGenerate,
  onNotice,
  showError,
  onOpenCases,
  refreshToken,
}) {
  const { call, active } = useRequests(project.id, canWrite);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [layout, setLayout] = useState("list");
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const loadSequence = useRef(0);
  const report = useCallback(
    (failure) => {
      if (!isAbort(failure) && active.current) {
        setError(failure.message);
        showError?.(failure.message);
      }
    },
    [showError],
  );
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const data = await call(`/api/requirements?projectId=${project.id}`);
      if (sequence === loadSequence.current) {
        setRecords(data.requirements || []);
        setError("");
      }
    } catch (failure) {
      report(failure);
    } finally {
      if (active.current && sequence === loadSequence.current)
        setLoading(false);
    }
  }, [project.id, call, report]);
  useEffect(() => {
    setRecords([]);
    setEditor(null);
    setDraft(null);
    setPreview(null);
    setQuery("");
    setStatus("");
    setPriority("");
    setFeishuOpen(false);
  }, [project.id, canWrite]);
  useEffect(() => {
    load();
  }, [load, canWrite, refreshToken]);
  useEffect(() => {
    if (!canAi) setDraft(null);
  }, [canAi]);
  const visible = useMemo(
    () =>
      records.filter(
        (record) =>
          (!query ||
            `${record.title} ${record.body || ""} ${record.attachments?.map((attachment) => `${attachment.name} ${attachment.extractedText || ""}`).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase())) &&
          (!status || record.status === status) &&
          (!priority || record.priority === priority),
      ),
    [records, query, status, priority],
  );
  async function open(record, action) {
    try {
      const value = (
        await call(`/api/requirements/${record.id}?projectId=${project.id}`)
      ).requirement;
      if (action === "edit") setEditor({ record: value });
      else if (action === "preview") setPreview(value);
      else setDraft({ kind: action, requirement: value });
    } catch (failure) {
      report(failure);
    }
  }
  async function remove(record) {
    if (!canWrite || !window.confirm(`确定删除需求“${record.title}”吗？`))
      return;
    try {
      await call(
        `/api/requirements/${record.id}`,
        json("DELETE", { projectId: project.id, revision: record.revision }),
      );
      onNotice?.("需求已删除");
      await load();
    } catch (failure) {
      report(failure);
      if (failure.status === 409) await load();
    }
  }
  function actions(record) {
    return (
      <div className="ws-row-actions">
        <Icon
          icon={Eye}
          label={`预览需求 ${record.title}`}
          onClick={() => open(record, "preview")}
        />
        {canWrite && (
          <Icon
            icon={Pencil}
            label={`编辑需求 ${record.title}`}
            onClick={() => open(record, "edit")}
          />
        )}
        <button
          type="button"
          className="text-button"
          onClick={() => open(record, "analysis")}
        >
          需求分析
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => open(record, "plan")}
        >
          测试计划
        </button>
        {canCasesView && (
          <button
            type="button"
            className="text-button"
            onClick={() => onOpenCases?.(record.id)}
          >
            查看用例
          </button>
        )}
        {canGenerate && (
          <button
            type="button"
            className="text-button"
            onClick={() => onGenerate?.(record)}
          >
            AI 生成用例
          </button>
        )}
        {canWrite && (
          <Icon
            icon={Trash2}
            danger
            label={`删除需求 ${record.title}`}
            onClick={() => remove(record)}
          />
        )}
      </div>
    );
  }
  return (
    <section className="workspace-section ws-requirements">
      <div className="section-heading">
        <div>
          <span className="eyebrow">REQUIREMENTS</span>
          <h1>需求管理</h1>
          <p>{project.name}</p>
        </div>
        <div className="heading-actions">
          {(
            <button
              type="button"
              className="button secondary browser-connection-entry"
              onClick={() => setFeishuOpen(true)}
            >
              <Link2 size={16} />
              飞书浏览器连接
            </button>
          )}
          <Icon
            icon={RefreshCw}
            label="刷新需求"
            onClick={load}
            disabled={loading}
          />
          {canWrite && (
            <button
              type="button"
              className="button primary"
              onClick={() => setEditor({})}
            >
              <Plus size={16} />
              新建需求
            </button>
          )}
        </div>
      </div>
      <div className="ws-list-toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索需求"
            placeholder="搜索标题、正文或文件名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select
          aria-label="筛选需求状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {REQUIREMENT_STATUSES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="筛选需求优先级"
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        >
          <option value="">全部优先级</option>
          {PRIORITIES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <div className="ws-layout-toggle">
          <Icon
            icon={List}
            label="列表视图"
            pressed={layout === "list"}
            onClick={() => setLayout("list")}
          />
          <Icon
            icon={Grid2X2}
            label="宫格视图"
            pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
          />
        </div>
      </div>
      <ErrorMessage error={error} />
      {loading && !records.length ? (
        <div className="loading-state">
          <LoaderCircle className="spin" size={18} />
          加载中
        </div>
      ) : !visible.length ? (
        <Empty>{records.length ? "没有匹配的需求" : "暂无需求"}</Empty>
      ) : layout === "grid" ? (
        <div className="ws-requirement-grid">
          {visible.map((record) => (
            <article className="ws-requirement-card" key={record.id}>
              <div>
                <FileText size={20} />
                <span className="ws-priority">{record.priority}</span>
              </div>
              <button
                type="button"
                className="ws-title-button"
                onClick={() => open(record, "preview")}
              >
                {record.title}
              </button>
              <p>
                {record.body?.slice(0, 130) ||
                  record.attachments
                    ?.map((attachment) => attachment.name)
                    .join("、") ||
                  "飞书文档"}
              </p>
              <div className="ws-card-meta">
                <span>{record.status}</span>
                <span>{sourceName(record)}</span>
                <span>{stamp(record.updatedAt)}</span>
              </div>
              {actions(record)}
            </article>
          ))}
        </div>
      ) : (
        <div className="table-surface table-scroll">
          <table className="ws-requirement-table">
            <thead>
              <tr>
                <th>需求标题</th>
                <th>来源</th>
                <th>状态</th>
                <th>优先级</th>
                <th>最近更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => (
                <tr key={record.id}>
                  <td>
                    <button
                      className="ws-title-button"
                      type="button"
                      onClick={() => open(record, "preview")}
                    >
                      {record.title}
                    </button>
                  </td>
                  <td>{sourceName(record)}</td>
                  <td>
                    <span className="ws-status">{record.status}</span>
                  </td>
                  <td>{record.priority}</td>
                  <td className="date-cell">{stamp(record.updatedAt)}</td>
                  <td>{actions(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ws-record-count">
        显示 {visible.length} / {records.length} 条需求
      </div>
      {editor && canWrite && (
        <SourceDialog
          project={project}
          canWrite={canWrite}
          isAdmin={isAdmin}
          onConfigureFeishu={() => setFeishuOpen(true)}
          record={editor.record}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onNotice?.("需求已保存");
            load();
          }}
        />
      )}
      {preview && (
        <Modal wide title={preview.title} onClose={() => setPreview(null)}>
          <div className="ws-preview-content">
            {preview.body && <MarkdownView content={preview.body} />}
            {preview.sourceUrl && (
              <a
                href={preview.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ws-source-link"
              >
                <Link2 size={15} />
                打开来源文档
              </a>
            )}
            {preview.attachments?.map((attachment) => (
              <Attachment key={attachment.id} attachment={attachment} />
            ))}
            {!preview.body && !preview.attachments?.length && (
              <Empty>暂无正文或附件</Empty>
            )}
          </div>
        </Modal>
      )}
      {draft && (
        <DraftDialog
          key={`${draft.kind}-${draft.requirement.id}`}
          project={project}
          requirement={draft.requirement}
          kind={draft.kind}
          canWrite={canWrite}
          canAi={canAi}
          config={config}
          onClose={() => setDraft(null)}
          onSaved={(message) => {
            onNotice?.(message);
            load();
          }}
        />
      )}
      {feishuOpen && (
        <FeishuConnection
          isAdmin={isAdmin}
          onClose={() => setFeishuOpen(false)}
          onSaved={() =>
            onNotice?.("飞书浏览器连接状态已更新")
          }
        />
      )}
    </section>
  );
}
function LibraryDialog({ project, canWrite, record, onClose, onSaved }) {
  const { call, active } = useRequests(project.id, canWrite);
  const [name, setName] = useState(record?.name || "");
  const [description, setDescription] = useState(record?.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mayClose = useUnsaved(
    name !== (record?.name || "") ||
      description !== (record?.description || ""),
    busy,
  );
  async function save(event) {
    event.preventDefault();
    if (!canWrite || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await call(
        `/api/knowledge-bases${record ? `/${record.id}` : ""}`,
        json(record ? "PUT" : "POST", {
          projectId: project.id,
          name: name.trim(),
          description,
          ...(record ? { revision: record.revision } : { preset: "standard" }),
        }),
      );
      if (active.current) onSaved(result.knowledgeBase);
    } catch (failure) {
      if (!isAbort(failure))
        setError(
          failure.status === 409
            ? "知识库已被他人修改，请关闭后重新编辑，当前输入已保留。"
            : failure.message,
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={record ? "编辑知识库" : "新建知识库"}
      busy={busy}
      onClose={() => mayClose() && onClose()}
    >
      <form className="modal-form ws-source-form" onSubmit={save}>
        <label className="field">
          <span>名称 *</span>
          <input
            aria-label="知识库名称"
            value={name}
            required
            maxLength={200}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>说明</span>
          <textarea
            value={description}
            rows={4}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => mayClose() && onClose()}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!canWrite || busy || !name.trim()}
          >
            <Save size={16} />
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
function kbValues(kb) {
  return {
    name: kb.name,
    description: kb.description || "",
    chunkMode: kb.chunkMode || "window",
    chunkSize: kb.chunkSize || 400,
    chunkOverlap: kb.chunkOverlap ?? 80,
  };
}
function KnowledgeSettings({
  project,
  knowledgeBase,
  canWrite,
  onChanged,
  onNotice,
}) {
  const { call, active } = useRequests(project.id, canWrite);
  const [values, setValues] = useState(() => kbValues(knowledgeBase));
  const snapshot = useRef(knowledgeBase);
  const baseline = useRef(JSON.stringify(values));
  const dirty = JSON.stringify(values) !== baseline.current;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  useUnsaved(dirty, busy);
  useEffect(() => {
    if (knowledgeBase.revision === snapshot.current.revision) return;
    if (dirty) setConflict(true);
    else {
      snapshot.current = knowledgeBase;
      const next = kbValues(knowledgeBase);
      setValues(next);
      baseline.current = JSON.stringify(next);
    }
  }, [knowledgeBase.revision, dirty]);
  function reset() {
    if (dirty && !window.confirm("载入最新设置将放弃当前修改，确定继续吗？"))
      return;
    snapshot.current = knowledgeBase;
    const next = kbValues(knowledgeBase);
    setValues(next);
    baseline.current = JSON.stringify(next);
    setConflict(false);
    setError("");
  }
  async function save(reindex) {
    if (!canWrite || busy) return;
    if (
      !values.name.trim() ||
      values.chunkSize < 100 ||
      values.chunkSize > 4e3 ||
      values.chunkOverlap < 0 ||
      values.chunkOverlap >= values.chunkSize
    ) {
      setError("名称不能为空，分块大小须为 100–4000，重叠须小于分块大小。");
      return;
    }
    setBusy(true);
    setError("");
    let saved = false;
    try {
      const result = await call(
        `/api/knowledge-bases/${knowledgeBase.id}`,
        json("PUT", {
          projectId: project.id,
          revision: snapshot.current.revision,
          ...values,
        }),
      );
      snapshot.current = result.knowledgeBase;
      baseline.current = JSON.stringify(values);
      saved = true;
      setConflict(false);
      if (reindex) {
        const indexed = await call(
          `/api/knowledge-bases/${knowledgeBase.id}/reindex`,
          json("POST", {
            projectId: project.id,
            revision: result.knowledgeBase.revision,
          }),
        );
        snapshot.current = indexed.knowledgeBase;
      }
      onNotice?.(reindex ? "知识库设置已保存，索引已重建" : "知识库设置已保存");
      await onChanged();
    } catch (failure) {
      if (!isAbort(failure)) {
        setConflict(failure.status === 409);
        setError(
          `${saved ? "设置已保存，重建索引失败。" : ""}${failure.message}`,
        );
        if (failure.status === 409) await onChanged();
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="ws-kb-settings">
      <div className="ws-settings-fields">
        <label className="field">
          <span>名称 *</span>
          <input
            value={values.name}
            disabled={!canWrite || busy}
            maxLength={200}
            onChange={(event) =>
              setValues({ ...values, name: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span>说明</span>
          <textarea
            value={values.description}
            rows={3}
            disabled={!canWrite || busy}
            onChange={(event) =>
              setValues({ ...values, description: event.target.value })
            }
          />
        </label>
        <fieldset disabled={!canWrite || busy}>
          <legend>分段设置</legend>
          <div className="ws-preset-buttons">
            {[
              ["fine", "精细"],
              ["standard", "标准"],
              ["heading", "按标题"],
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                className="button secondary"
                onClick={() => setValues({ ...values, ...PRESETS[key] })}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>分段方式</span>
            <select
              aria-label="分段方式"
              value={values.chunkMode}
              onChange={(event) =>
                setValues({ ...values, chunkMode: event.target.value })
              }
            >
              <option value="window">固定窗口</option>
              <option value="heading">按标题</option>
            </select>
          </label>
          <div className="ws-form-row">
            <label className="field">
              <span>分块大小</span>
              <input
                aria-label="分块大小"
                type="number"
                min={100}
                max={4e3}
                step={50}
                value={values.chunkSize}
                onChange={(event) =>
                  setValues({
                    ...values,
                    chunkSize: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="field">
              <span>分块重叠</span>
              <input
                aria-label="分块重叠"
                type="number"
                min={0}
                max={values.chunkSize - 1}
                value={values.chunkOverlap}
                onChange={(event) =>
                  setValues({
                    ...values,
                    chunkOverlap: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </fieldset>
      </div>
      {knowledgeBase.indexPending > 0 && (
        <p className="ws-warning">
          {knowledgeBase.indexPending} 份文档待重建索引
        </p>
      )}
      {conflict && (
        <div className="ws-warning">
          <span>知识库已更新，当前输入已保留。</span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={reset}
          >
            载入最新设置
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
      {canWrite && (
        <div className="ws-settings-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !dirty}
            onClick={() => save(false)}
          >
            <Save size={16} />
            保存
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => save(true)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            保存并重建索引
          </button>
        </div>
      )}
    </div>
  );
}
function KnowledgeContents({
  project,
  knowledgeBase,
  canWrite,
  isAdmin = false,
  onChanged,
  onNotice,
  refreshToken,
}) {
  const { call, active } = useRequests(project.id, canWrite);
  const [tab, setTab] = useState("documents");
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [chunkDocument, setChunkDocument] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const sequence = useRef(0);
  const base = `/api/knowledge-bases/${knowledgeBase.id}`;
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const result = await call(`${base}/documents?projectId=${project.id}`);
      if (current === sequence.current) {
        setDocuments(result.documents || []);
        setError("");
      }
    } catch (failure) {
      if (!isAbort(failure)) setError(failure.message);
    } finally {
      if (active.current && current === sequence.current) setLoading(false);
    }
  }, [base, project.id, call]);
  useEffect(() => {
    load();
  }, [load, refreshToken]);
  useEffect(() => {
    if (!canWrite) {
      setUploadOpen(false);
      setChunks([]);
      setChunkDocument(null);
      setResults(null);
      setWarnings([]);
      setBusy("");
    }
  }, [canWrite]);
  const visible = documents.filter(
    (document2) => !category || (document2.category || "未分类") === category,
  );
  async function documentAction(document2, action, value) {
    if (!canWrite || busy) return;
    if (
      action === "delete" &&
      !window.confirm(`确定删除知识文档“${document2.title}”吗？`)
    )
      return;
    setBusy(document2.id);
    setError("");
    try {
      if (action === "category")
        await call(
          `${base}/documents/${document2.id}`,
          json("PUT", {
            projectId: project.id,
            revision: document2.revision,
            category: value,
          }),
        );
      else
        await call(
          `${base}/documents/${document2.id}${action === "reindex" ? "/reindex" : ""}`,
          json(action === "reindex" ? "POST" : "DELETE", {
            projectId: project.id,
            revision: document2.revision,
          }),
        );
      await load();
      await onChanged();
      onNotice?.(
        action === "delete"
          ? "文档已删除"
          : action === "reindex"
            ? "文档索引已重建"
            : "分类已保存",
      );
    } catch (failure) {
      if (!isAbort(failure)) {
        setError(failure.message);
        if (failure.status === 409) await load();
      }
    } finally {
      if (active.current) setBusy("");
    }
  }
  async function viewChunks(document2) {
    setBusy(`chunks-${document2.id}`);
    setError("");
    try {
      const result = await call(
        `${base}/documents/${document2.id}/chunks?projectId=${project.id}`,
      );
      setChunks(result.chunks || []);
      setChunkDocument(document2);
    } catch (failure) {
      if (!isAbort(failure)) setError(failure.message);
    } finally {
      if (active.current) setBusy("");
    }
  }
  async function search(event) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy("search");
    setError("");
    setResults(null);
    setWarnings([]);
    try {
      const result = await call(
        `${base}/search`,
        json("POST", { projectId: project.id, query: query.trim(), limit: 8 }),
      );
      setResults(result.chunks || []);
      setWarnings(result.warnings || []);
    } catch (failure) {
      if (!isAbort(failure)) setError(failure.message);
    } finally {
      if (active.current) setBusy("");
    }
  }
  function selectTab(next) {
    if (
      next !== tab &&
      window.dispatchEvent(
        new Event("qzz-before-navigate", { cancelable: true }),
      )
    )
      setTab(next);
  }
  return (
    <section className="ws-kb-content">
      <header className="ws-library-heading">
        <div>
          <h2>{knowledgeBase.name}</h2>
          <p>{knowledgeBase.description || "暂无说明"}</p>
        </div>
        <span>
          {knowledgeBase.documentCount || 0} 份文档 ·{" "}
          {knowledgeBase.chunkCount || 0} 个分块
        </span>
      </header>
      <div className="ws-document-tabs">
        <div role="tablist" aria-label="知识库视图">
          {[
            ["documents", "文档"],
            ["search", "试检索"],
            ["settings", "设置"],
          ].map(([id, label]) => (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={tab === id}
              onClick={() => selectTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ErrorMessage error={error} />
      {tab === "documents" ? (
        <>
          <div className="ws-kb-document-toolbar">
            {canWrite && (
              <button
                type="button"
                className="button primary"
                disabled={Boolean(busy)}
                onClick={() => setUploadOpen(true)}
              >
                <Upload size={16} />
                上传文档
              </button>
            )}
            <select
              aria-label="筛选文档分类"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">全部分类</option>
              {[
                .../* @__PURE__ */ new Set([
                  ...CATEGORIES,
                  ...documents
                    .map((document2) => document2.category)
                    .filter(Boolean),
                ]),
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <Icon
              icon={RefreshCw}
              label="刷新知识文档"
              disabled={loading}
              onClick={load}
            />
          </div>
          {loading && !documents.length ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={18} />
              加载中
            </div>
          ) : !visible.length ? (
            <Empty>暂无文档</Empty>
          ) : (
            <div className="table-scroll">
              <table className="ws-knowledge-table">
                <thead>
                  <tr>
                    <th>文档</th>
                    <th>分类</th>
                    <th>状态</th>
                    <th>分块</th>
                    <th>最近更新</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((document2) => (
                    <tr key={document2.id}>
                      <td>
                        <strong>{document2.title}</strong>
                        {document2.attachments?.length > 0 && (
                          <small>
                            {document2.attachments
                              .map((attachment) => attachment.name)
                              .join("、")}
                          </small>
                        )}
                      </td>
                      <td>
                        {canWrite ? (
                          <select
                            aria-label={`文档分类 ${document2.title}`}
                            value={document2.category || "未分类"}
                            disabled={Boolean(busy)}
                            onChange={(event) =>
                              documentAction(
                                document2,
                                "category",
                                event.target.value,
                              )
                            }
                          >
                            {[
                              .../* @__PURE__ */ new Set([
                                ...CATEGORIES,
                                document2.category || "未分类",
                              ]),
                            ].map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        ) : (
                          document2.category || "未分类"
                        )}
                      </td>
                      <td>
                        <span
                          className={`ws-status ${document2.indexOutdated ? "warning" : ""}`}
                        >
                          {document2.indexOutdated
                            ? "待重建索引"
                            : document2.chunkCount
                              ? "已索引"
                              : "暂无文本分块"}
                        </span>
                      </td>
                      <td>{document2.chunkCount || 0}</td>
                      <td className="date-cell">
                        {stamp(document2.updatedAt)}
                      </td>
                      <td>
                        <div className="ws-row-actions">
                          <button
                            type="button"
                            className="text-button"
                            disabled={Boolean(busy)}
                            onClick={() => viewChunks(document2)}
                          >
                            查看分块
                          </button>
                          {document2.attachments?.length > 0 && (
                            <details className="ws-download-menu">
                              <summary title="下载原件">
                                <Download size={16} />
                              </summary>
                              <div>
                                {document2.attachments.map((attachment) => (
                                  <a
                                    key={attachment.id}
                                    href={attachment.downloadUrl}
                                    download
                                  >
                                    {attachment.name}
                                  </a>
                                ))}
                              </div>
                            </details>
                          )}
                          {canWrite && (
                            <>
                              <Icon
                                icon={RefreshCw}
                                label={`重建索引 ${document2.title}`}
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  documentAction(document2, "reindex")
                                }
                              />
                              <Icon
                                icon={Trash2}
                                danger
                                label={`删除文档 ${document2.title}`}
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  documentAction(document2, "delete")
                                }
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : tab === "search" ? (
        <div className="ws-retrieval">
          <form onSubmit={search}>
            <label className="field">
              <span>检索问题</span>
              <textarea
                aria-label="试检索问题"
                rows={3}
                value={query}
                disabled={busy === "search"}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={Boolean(busy) || !query.trim()}
            >
              {busy === "search" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Search size={16} />
              )}
              检索
            </button>
          </form>
          {warnings.map((warning, index) => (
            <p className="ws-warning" key={index}>
              {typeof warning === "string" ? warning : warning.message}
            </p>
          ))}
          {results?.length === 0 ? (
            <Empty>没有匹配的分块</Empty>
          ) : (
            results?.map((chunk, index) => (
              <article className="ws-search-result" key={chunk.id || index}>
                <header>
                  <BookOpen size={16} />
                  <strong>
                    {chunk.documentName || chunk.documentTitle || "知识文档"}
                  </strong>
                  <span>
                    {chunk.locator || `分块 ${(chunk.position || 0) + 1}`}
                  </span>
                  <span>得分 {Number(chunk.score || 0).toFixed(2)}</span>
                </header>
                {chunk.heading && <h3>{chunk.heading}</h3>}
                <pre>{chunk.content || chunk.text}</pre>
              </article>
            ))
          )}
        </div>
      ) : (
        <KnowledgeSettings
          project={project}
          knowledgeBase={knowledgeBase}
          canWrite={canWrite}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      )}
      {uploadOpen && canWrite && (
        <SourceDialog
          project={project}
          canWrite={canWrite}
          isAdmin={isAdmin}
          knowledgeBase={knowledgeBase}
          onClose={() => setUploadOpen(false)}
          onSaved={() => {
            setUploadOpen(false);
            load();
            onChanged();
            onNotice?.("知识文档已上传");
          }}
        />
      )}
      {chunkDocument && (
        <Modal
          wide
          title={`文档分块：${chunkDocument.title}`}
          onClose={() => {
            setChunkDocument(null);
            setChunks([]);
          }}
        >
          <div className="ws-chunk-list">
            <span className="ws-muted">共 {chunks.length} 个分块</span>
            {chunks.length ? (
              chunks.map((chunk, index) => (
                <details key={chunk.id || index} className="ws-chunk">
                  <summary>
                    <ChevronDown size={15} />
                    <strong>#{(chunk.position ?? index) + 1}</strong>
                    <span>
                      {chunk.heading ||
                        (chunk.content || chunk.text || "").slice(0, 100)}
                    </span>
                    <small>
                      {(chunk.content || chunk.text || "").length} 字符
                    </small>
                  </summary>
                  <pre>{chunk.content || chunk.text}</pre>
                </details>
              ))
            ) : (
              <Empty>暂无可检索分块</Empty>
            )}
            {chunkDocument.attachments?.map((attachment) => (
              <Attachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
function KnowledgePage({
  project,
  canWrite,
  isAdmin = false,
  onNotice,
  showError,
  refreshToken,
}) {
  const { call, active } = useRequests(project.id, canWrite);
  const [libraries, setLibraries] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const result = await call(`/api/knowledge-bases?projectId=${project.id}`);
      if (current !== sequence.current) return [];
      const values = result.knowledgeBases || [];
      setLibraries(values);
      setSelectedId((previous) =>
        values.some((item) => item.id === previous)
          ? previous
          : values[0]?.id || "",
      );
      setError("");
      return values;
    } catch (failure) {
      if (!isAbort(failure)) {
        setError(failure.message);
        showError?.(failure.message);
      }
      return [];
    } finally {
      if (active.current && current === sequence.current) setLoading(false);
    }
  }, [project.id, call, showError]);
  useEffect(() => {
    setLibraries([]);
    setSelectedId("");
    setEditor(null);
    setQuery("");
  }, [project.id, canWrite]);
  useEffect(() => {
    load();
  }, [load, canWrite, refreshToken]);
  const selected = libraries.find((item) => item.id === selectedId);
  async function remove(library) {
    if (
      !canWrite ||
      !window.dispatchEvent(
        new Event("qzz-before-navigate", { cancelable: true }),
      ) ||
      !window.confirm(`确定删除知识库“${library.name}”及其中的文档吗？`)
    )
      return;
    try {
      await call(
        `/api/knowledge-bases/${library.id}`,
        json("DELETE", { projectId: project.id, revision: library.revision }),
      );
      onNotice?.("知识库已删除");
      await load();
    } catch (failure) {
      if (!isAbort(failure)) {
        setError(failure.message);
        if (failure.status === 409) await load();
      }
    }
  }
  return (
    <section className="workspace-section ws-knowledge">
      <div className="section-heading">
        <div>
          <span className="eyebrow">KNOWLEDGE</span>
          <h1>知识库</h1>
          <p>{project.name}</p>
        </div>
        <Icon
          icon={RefreshCw}
          label="刷新知识库"
          disabled={loading}
          onClick={load}
        />
      </div>
      <ErrorMessage error={error} />
      <div className="ws-knowledge-layout">
        <aside className="ws-library-list">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索知识库"
              placeholder="搜索知识库"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {canWrite && (
            <button
              type="button"
              className="button primary"
              onClick={() => setEditor({})}
            >
              <Plus size={16} />
              新建知识库
            </button>
          )}
          <nav aria-label="知识库列表">
            {libraries
              .filter((library) =>
                `${library.name} ${library.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((library) => (
                <div
                  key={library.id}
                  className={`ws-library-item ${selectedId === library.id ? "selected" : ""}`}
                >
                  <button
                    type="button"
                    className="ws-library-select"
                    aria-current={selectedId === library.id ? "page" : void 0}
                    onClick={() => {
                      if (
                        selectedId !== library.id &&
                        window.dispatchEvent(
                          new Event("qzz-before-navigate", {
                            cancelable: true,
                          }),
                        )
                      )
                        setSelectedId(library.id);
                    }}
                  >
                    <BookOpen size={18} />
                    <span>
                      <strong>{library.name}</strong>
                      <small>{library.documentCount || 0} 份文档</small>
                    </span>
                  </button>
                  {canWrite && (
                    <div>
                      <Icon
                        icon={Pencil}
                        label={`编辑知识库 ${library.name}`}
                        onClick={() => setEditor({ record: library })}
                      />
                      <Icon
                        icon={Trash2}
                        danger
                        label={`删除知识库 ${library.name}`}
                        onClick={() => remove(library)}
                      />
                    </div>
                  )}
                </div>
              ))}
          </nav>
        </aside>
        {selected ? (
          <KnowledgeContents
            key={`${project.id}-${selected.id}-${canWrite}`}
            project={project}
            knowledgeBase={selected}
            canWrite={canWrite}
            isAdmin={isAdmin}
            onChanged={load}
            onNotice={onNotice}
            refreshToken={refreshToken}
          />
        ) : (
          <Empty>{loading ? "加载中" : "暂无知识库"}</Empty>
        )}
      </div>
      {editor && canWrite && (
        <LibraryDialog
          project={project}
          canWrite={canWrite}
          record={editor.record}
          onClose={() => setEditor(null)}
          onSaved={async (library) => {
            setEditor(null);
            await load();
            if (active.current) setSelectedId(library.id);
            onNotice?.("知识库已保存");
          }}
        />
      )}
    </section>
  );
}
export { KnowledgePage, MarkdownView, RequirementsPage };
