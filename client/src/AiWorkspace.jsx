import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Check,
  FileText,
  LayoutGrid,
  List,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import AiDocuments from "./AiDocuments";
import { MarkdownView } from "./WorkspaceDocuments";
import { normalizeModelCatalog, resolveModelSelection } from "./ai-models";
import "./ai-workspace.css";
const CATEGORIES = ["主流程", "UI", "异常与边界", "受影响模块"];
const DIMENSIONS = [
  "覆盖完整性",
  "正确性",
  "冗余去重",
  "边界与异常",
  "步骤清晰度",
  "优先级合理性",
  "前置/数据完整性",
  "需求追溯",
];
const cacheKey = (userId, projectId) =>
  `qzz-ai-workspace:${userId}:${projectId}`;
function localDraft(key, requirementId = "") {
  try {
    const selected = requirementId || localStorage.getItem(`${key}:last`);
    if (!selected) return null;
    const value = JSON.parse(localStorage.getItem(`${key}:${selected}`) || "null");
    return value && (!requirementId || value.requirementId === requirementId)
      ? value
      : null;
  } catch {
    return null;
  }
}
function recoveryDraft(key, requirementId) {
  try { return JSON.parse(localStorage.getItem(`${key}:${requirementId}:recovery`) || "null"); }
  catch { return null; }
}
const newId = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues)
    return `ai-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};
const caseSnapshot = (item, title) =>
  JSON.stringify([
    title.trim(),
    item.id,
    item.title,
    item.module,
    item.category,
    item.priority,
    item.preconditions,
    item.steps,
    item.expected,
    item.sourceIds || [],
  ]);
const validCase = (item) =>
  item &&
  CATEGORIES.includes(item.category) &&
  ["P0", "P1", "P2", "P3"].includes(item.priority) &&
  typeof item.module === "string" &&
  item.module.trim() &&
  item.module.length <= 100 &&
  typeof item.title === "string" &&
  item.title.trim() &&
  item.title.length <= 200 &&
  ["preconditions", "steps", "expected"].every(
    (key) =>
      typeof item[key] === "string" &&
      item[key].trim() &&
      item[key].length <= 2e3,
  );
const validPoint = (item) =>
  item &&
  CATEGORIES.includes(item.category) &&
  typeof item.module === "string" &&
  item.module.trim() &&
  item.module.length <= 100 &&
  typeof item.title === "string" &&
  item.title.trim() &&
  item.title.length <= 200 &&
  typeof item.expected === "string" &&
  item.expected.trim() &&
  item.expected.length <= 1e3;
function normalizeDraft(result) {
  const rows = (value) => (Array.isArray(value) ? value : []);
  return {
    ...result,
    title: typeof result.title === "string" ? result.title : "",
    questions: rows(result.questions).filter(
      (question) => typeof question === "string",
    ),
    cases: rows(result.cases)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        id: item.id || newId(),
        title: item.title || "",
        module: item.module || "",
        preconditions: item.preconditions || "",
        steps: item.steps || "",
        expected: item.expected || "",
        sourceIds: rows(item.sourceIds),
      })),
    points: rows(result.points)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        id: item.id || newId(),
        title: item.title || "",
        module: item.module || "",
        expected: item.expected || "",
        sourceIds: rows(item.sourceIds),
      })),
    sources: rows(result.sources),
  };
}
async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("与平台的连接中断，请确认服务正在运行后重试");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `请求失败（HTTP ${response.status}），请重试或联系管理员`);
    error.status = response.status;
    error.warnings = data.warnings || [];
    throw error;
  }
  return data;
}
function casesToTree(title, cases) {
  const node = (text, children = []) => ({
    id: newId(),
    title: text,
    children,
  });
  const leaf = (item, grouped = false) =>
    node(
      `[${item.priority}] ${grouped ? "" : `${item.module} · `}${item.title}`,
      [
        node(`前置条件：${item.preconditions}`),
        node(`执行步骤：${item.steps}`),
        node(`预期结果：${item.expected}`),
      ],
    );
  return node(
    title,
    CATEGORIES.map((category) => {
      const items = cases.filter((item) => item.category === category);
      if (category !== "受影响模块")
        return node(
          category,
          items.map((item) => leaf(item)),
        );
      return node(
        category,
        [...new Set(items.map((item) => item.module || "相关模块"))].map(
          (name) =>
            node(
              name,
              items
                .filter((item) => (item.module || "相关模块") === name)
                .map((item) => leaf(item, true)),
            ),
        ),
      );
    }),
  );
}
function Sources({ sources = [] }) {
  return (
    sources.length > 0 && (
      <details className="aw-sources">
        <summary>查看参考依据 · {sources.length}</summary>
        {sources.map((source) => (
          <article key={source.id}>
            <strong>{source.title}</strong>
            <small>
              {source.locator || source.type} · {source.id}
            </small>
            <p>{source.excerpt}</p>
          </article>
        ))}
      </details>
    )
  );
}
function AiWorkspace({
  project,
  userId,
  projects,
  config,
  canWrite,
  canSave,
  canRequirements,
  canKnowledge,
  isAdmin,
  initialRequirement,
  refreshToken,
  onCreateRequirement,
  onRefresh,
  showError,
  onNotice,
}) {
  const [requirements, setRequirements] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [requirementId, setRequirementId] = useState(
    initialRequirement?.id || "",
  );
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState([]);
  const [model, setModel] = useState(config.aiModel || "");
  const [modelCatalog, setModelCatalog] = useState(() => normalizeModelCatalog(null, config.aiModel));
  const [modelStatus, setModelStatus] = useState("loading");
  const [modelRetry, setModelRetry] = useState(0);
  const [mode, setMode] = useState("staged");
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [review, setReview] = useState(
    DIMENSIONS.map((dimension) => ({ dimension, weight: 3, enabled: true })),
  );
  const [instructions, setInstructions] = useState("");
  const [history, setHistory] = useState([]);
  const [answers, setAnswers] = useState({});
  const [clarifications, setClarifications] = useState("");
  const [confirmedAnswers, setConfirmedAnswers] = useState({});
  const [confirmedRulesOnly, setConfirmedRulesOnly] = useState(false);
  const [draft, setDraft] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [selected, setSelected] = useState(/* @__PURE__ */ new Set());
  const [view, setView] = useState("table");
  const [resultTab, setResultTab] = useState("draft");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [requestWarnings, setRequestWarnings] = useState([]);
  const [written, setWritten] = useState(/* @__PURE__ */ new Map());
  const [reviewStale, setReviewStale] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const [cacheStatus, setCacheStatus] = useState("loading");
  const [cacheRetry, setCacheRetry] = useState(0);
  const [recovery, setRecovery] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [assistantWidth, setAssistantWidth] = useState(370);
  const pending = useRef(null);
  const resizeStart = useRef(null);
  const legacyCloseGuard = useRef(null);
  const requirementIdRef = useRef(requirementId);
  requirementIdRef.current = requirementId;
  const operation = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const cacheSnapshot = useRef(null);
  const saveQueue = useRef(Promise.resolve());
  const cacheLoad = useRef(0);
  const cacheRevision = useRef(0);
  const localSaved = useRef(true);
  const serverSaved = useRef(true);
  const serverVersions = useRef(new Map());
  const skipAutosave = useRef(false);
  const recovering = useRef(null);
  const storageKey = cacheKey(userId || "anonymous", project.id);
  useEffect(() => {
    alive.current = true;
    const guard = (event) => {
      if ((locked.current || cacheSnapshot.current && !localSaved.current && !serverSaved.current) && !window.confirm("生成仍在进行，或本次草稿尚未成功保存。确定离开？"))
        event.preventDefault();
    };
    const unload = (event) => {
      if (locked.current || cacheSnapshot.current && !localSaved.current && !serverSaved.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("qzz-before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      if (cacheSnapshot.current && !serverSaved.current) queueSave(cacheSnapshot.current);
      alive.current = false;
      operation.current += 1;
      pending.current?.abort();
      window.removeEventListener("qzz-before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (!canWrite) {
      operation.current += 1;
      pending.current?.abort();
      locked.current = false;
      setBusy("");
      resetDraft();
      setInstructions("");
    }
  }, [canWrite]);
  const previousPermissions = useRef({
    canRequirements,
    canKnowledge,
    canSave,
  });
  useEffect(() => {
    const previous = previousPermissions.current;
    if (
      (previous.canRequirements && !canRequirements) ||
      (previous.canKnowledge && !canKnowledge) ||
      (previous.canSave && !canSave)
    ) {
      operation.current += 1;
      pending.current?.abort();
      locked.current = false;
      setBusy("");
      resetDraft();
      setInstructions("");
    }
    if (!canRequirements) {
      setRequirements([]);
      setRequirementId("");
    }
    if (!canKnowledge) {
      setLibraries([]);
      setKnowledgeBaseIds([]);
    }
    previousPermissions.current = { canRequirements, canKnowledge, canSave };
  }, [canRequirements, canKnowledge, canSave]);
  useEffect(() => {
    operation.current += 1;
    pending.current?.abort();
    locked.current = false;
    setBusy("");
    setCacheReady(false);
    resetDraft();
    setRequirements([]);
    setLibraries([]);
    setKnowledgeBaseIds([]);
    setModel(config.aiModel || "");
    setInstructions("");
    setRequirementId(
      initialRequirement?.projectId &&
        initialRequirement.projectId !== project.id
        ? ""
        : initialRequirement?.id || "",
    );
  }, [project.id]);
  useEffect(() => {
    const controller = new AbortController();
    setModelStatus("loading");
    if (!config.aiConfigured) {
      setModelCatalog(normalizeModelCatalog(null, config.aiModel));
      setModelStatus("error");
      return () => controller.abort();
    }
    request("/api/ai/models", { signal: controller.signal })
      .then((data) => {
        if (!alive.current || controller.signal.aborted) return;
        const next = normalizeModelCatalog(data, config.aiModel);
        setModelCatalog(next);
        setModel((previous) => resolveModelSelection(previous, next));
        setModelStatus(data.source === "configured" ? "fallback" : "ready");
      })
      .catch(() => {
        if (!alive.current || controller.signal.aborted) return;
        const fallback = normalizeModelCatalog(null, config.aiModel);
        setModelCatalog(fallback);
        setModel(fallback.defaultModel);
        setModelStatus("error");
      });
    return () => controller.abort();
  }, [config.aiConfigured, config.aiModel, modelRetry]);
  function queueSave(snapshot) {
    const saving = saveQueue.current.then(async () => {
      const result = await request("/api/workspace/ai-draft", {
        method: "PUT",
        body: JSON.stringify({ ...snapshot, baseUpdatedAt: serverVersions.current.get(snapshot.requirementId) ?? null }),
      });
      serverVersions.current.set(snapshot.requirementId, result.updatedAt);
      return result;
    });
    saveQueue.current = saving.catch(() => {});
    return saving;
  }
  function restoreCache(saved, fallbackId = "", saveNow = false) {
    skipAutosave.current = !saveNow;
    const state = saved?.state || {};
    const id = saved?.requirementId || fallbackId;
    setRequirementId(id);
    setMode(["staged", "quick"].includes(state.mode) ? state.mode : "staged");
    setModel(typeof state.model === "string" && state.model ? state.model : config.aiModel || "");
    setKnowledgeBaseIds(Array.isArray(state.knowledgeBaseIds) && canKnowledge ? state.knowledgeBaseIds : []);
    setReviewEnabled(state.reviewEnabled !== false);
    if (Array.isArray(state.review) && state.review.length === DIMENSIONS.length && state.review.every((item) => DIMENSIONS.includes(item.dimension))) setReview(state.review);
    setInstructions(typeof state.instructions === "string" ? state.instructions : "");
    setHistory(Array.isArray(state.history) ? state.history.filter((item) => ["user", "assistant"].includes(item?.role) && typeof item.content === "string").slice(-20) : []);
    setAnswers(state.answers && typeof state.answers === "object" ? state.answers : {});
    setClarifications(typeof state.clarifications === "string" ? state.clarifications : "");
    setConfirmedAnswers(state.confirmedAnswers && typeof state.confirmedAnswers === "object" ? state.confirmedAnswers : {});
    setConfirmedRulesOnly(state.confirmedRulesOnly === true);
    setDraft(state.draft && state.draft.requirementId === id && (state.draft.type !== "cases" || canSave) ? normalizeDraft(state.draft) : null);
    setAnalysis(state.analysis && state.analysis.requirementId === id ? normalizeDraft(state.analysis) : null);
    setWritten(new Map(Array.isArray(state.written) ? state.written.filter((entry) => Array.isArray(entry) && entry.length === 2) : []));
    setReviewStale(state.reviewStale === true);
    setView(state.view === "grid" ? "grid" : "table");
    setResultTab(["draft", "analysis", "review"].includes(state.resultTab) ? state.resultTab : "draft");
    setSelected(new Set());
    setRequestWarnings([]);
    setCacheReady(true);
    setCacheStatus(saved ? "saved" : "empty");
    locked.current = false;
    setBusy("");
  }
  function chooseCachedDraft(saved, local, fallbackId = "") {
    const id = local?.requirementId || saved?.requirementId || fallbackId;
    serverVersions.current.set(id, saved?.updatedAt ?? null);
    const eligibleLocal = local && (!local.state?.knowledgeBaseIds?.length || canKnowledge) && (local.state?.draft?.type !== "cases" || canSave);
    const candidateRecovery = recoveryDraft(storageKey, id);
    const storedRecovery = candidateRecovery && (!candidateRecovery.state?.knowledgeBaseIds?.length || canKnowledge) && (candidateRecovery.state?.draft?.type !== "cases" || canSave) ? candidateRecovery : null;
    if (eligibleLocal && local.baseUpdatedAt === (saved?.updatedAt ?? null)) {
      setRecovery(storedRecovery);
      restoreCache(local, id, true);
    } else {
      if (eligibleLocal) {
        try { localStorage.setItem(`${storageKey}:${id}:recovery`, JSON.stringify(local)); } catch { /* The current session still holds it. */ }
      }
      setRecovery(eligibleLocal || storedRecovery);
      restoreCache(saved, id);
    }
  }
  useEffect(() => {
    if (!canWrite || !canRequirements) {
      setCacheReady(false);
      return;
    }
    const initialId = initialRequirement?.projectId && initialRequirement.projectId !== project.id ? "" : initialRequirement?.id || "";
    const token = ++cacheLoad.current;
    const controller = new AbortController();
    // With no selected requirement, the selector must remain usable while the last draft is checked.
    setCacheReady(!initialId);
    request(`/api/workspace/ai-draft?projectId=${encodeURIComponent(project.id)}${initialId ? `&requirementId=${encodeURIComponent(initialId)}` : ""}`, { signal: controller.signal })
      .then(async ({ saved }) => {
        if (!alive.current || controller.signal.aborted || cacheLoad.current !== token) return;
        const local = localDraft(storageKey, initialId);
        const remote = local && saved?.requirementId !== local.requirementId
          ? (await request(`/api/workspace/ai-draft?projectId=${encodeURIComponent(project.id)}&requirementId=${encodeURIComponent(local.requirementId)}`, { signal: controller.signal })).saved
          : saved;
        if (!alive.current || controller.signal.aborted || cacheLoad.current !== token) return;
        chooseCachedDraft(remote, local, initialId);
      })
      .catch((failure) => {
        if (controller.signal.aborted || cacheLoad.current !== token) return;
        const local = localDraft(storageKey, initialId);
        if (local && (!local.state?.knowledgeBaseIds?.length || canKnowledge) && (local.state?.draft?.type !== "cases" || canSave)) {
          serverVersions.current.set(local.requirementId, local.baseUpdatedAt ?? null);
          restoreCache(local, initialId, true);
          setCacheStatus("error");
        } else {
          setCacheReady(false);
          setCacheStatus("load-error");
        }
        setError(`草稿读取失败：${failure.message}`);
      });
    return () => controller.abort();
  }, [project.id, initialRequirement?.id, canWrite, canRequirements, canKnowledge, canSave, storageKey, cacheRetry]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      canRequirements
        ? request(
            `/api/requirements?projectId=${encodeURIComponent(project.id)}`,
            { signal: controller.signal },
          )
        : Promise.resolve({ requirements: [] }),
      canKnowledge
        ? request(
            `/api/knowledge-bases?projectId=${encodeURIComponent(project.id)}`,
            { signal: controller.signal },
          )
        : Promise.resolve({ knowledgeBases: [] }),
    ])
      .then(([req, kb]) => {
        if (!alive.current || controller.signal.aborted) return;
        setRequirements(req.requirements || []);
        setLibraries(kb.knowledgeBases || []);
        setKnowledgeBaseIds((ids) =>
          ids.filter((id) =>
            (kb.knowledgeBases || []).some((library) => library.id === id),
          ),
        );
        if (
          requirementIdRef.current &&
          !(req.requirements || []).some(
            (item) => item.id === requirementIdRef.current,
          )
        ) {
          operation.current += 1;
          pending.current?.abort();
          locked.current = false;
          setBusy("");
          setRequirementId("");
          resetDraft();
        }
      })
      .catch((failure) => {
        if (failure.name !== "AbortError" && alive.current)
          setError(failure.message);
      });
    return () => controller.abort();
  }, [project.id, canRequirements, canKnowledge, refreshToken]);
  const currentRequirement = requirements.find(
    (item) => item.id === requirementId,
  );
  const questions = draft?.questions || [];
  const caseItems = draft?.cases || [];
  const pointItems = draft?.points || [];
  const confirmedPoints =
    draft?.type === "points" ? pointItems : draft?.confirmedPoints || [];
  const selectedModel = ["ready", "fallback"].includes(modelStatus) ? resolveModelSelection(model, modelCatalog) : config.aiModel || model;
  const blocked =
    !canWrite || !cacheReady || !config.aiConfigured || modelStatus === "loading" || busy !== "" || !requirementId;
  const saveBlocked = !canWrite || !canSave || !cacheReady || busy !== "" || !requirementId;
  const invalidCases =
    caseItems.length > 200 || caseItems.some((item) => !validCase(item));
  const validPoints =
    pointItems.length > 0 &&
    pointItems.length <= 200 &&
    pointItems.every(validPoint);
  const unsavedCases = caseItems.filter(
    (item) => written.get(item.id) !== caseSnapshot(item, draft?.title || ""),
  );
  const pendingSelectedCount = unsavedCases.filter((item) =>
    selected.has(item.id),
  ).length;
  const hasEvidence = (item) =>
    Array.isArray(item.sourceIds) &&
    item.sourceIds.length > 0 &&
    item.sourceIds.every((id) =>
      draft?.sources?.some((source) => source.id === id),
    );
  const selectedInvalid = unsavedCases
    .filter((item) => selected.has(item.id))
    .some((item) => !validCase(item) || !hasEvidence(item));
  const missingEvidence = caseItems.some((item) => !hasEvidence(item));
  const waitingForAnswers =
    questions.some(
      (question) =>
        !(answers[question]?.trim() || confirmedAnswers[question]?.trim()),
    ) && !confirmedRulesOnly;
  const nextTask =
    mode === "quick"
      ? "cases"
      : !draft
        ? "analysis"
        : draft.type === "analysis"
          ? "points"
          : draft.type === "points" && !validPoints
            ? "points"
            : "cases";
  const stages = ["选择资料", "需求澄清", "审核测试点", "用例草稿"];
  const stage =
    draft?.type === "cases" ? 3 : draft?.type === "points" ? 2 : draft ? 1 : 0;
  const conversation = useMemo(() => history.slice(-20), [history]);
  cacheSnapshot.current = cacheReady && canWrite && canRequirements && requirementId ? {
    projectId: project.id,
    requirementId,
    state: {
      mode, model, knowledgeBaseIds, reviewEnabled, review, instructions, history, answers,
      clarifications, confirmedAnswers, confirmedRulesOnly, draft, analysis,
      written: [...written], reviewStale, view, resultTab,
    },
  } : null;
  useEffect(() => {
    const snapshot = cacheSnapshot.current;
    if (!snapshot) return;
    if (skipAutosave.current) {
      skipAutosave.current = false;
      localSaved.current = true;
      serverSaved.current = true;
      return;
    }
    const revision = ++cacheRevision.current;
    serverSaved.current = false;
    try {
      localStorage.setItem(`${storageKey}:${snapshot.requirementId}`, JSON.stringify({ ...snapshot, baseUpdatedAt: serverVersions.current.get(snapshot.requirementId) ?? null }));
      localStorage.setItem(`${storageKey}:last`, snapshot.requirementId);
      localSaved.current = true;
    } catch { localSaved.current = false; }
    setCacheStatus("saving");
    const timer = setTimeout(() => {
      queueSave(snapshot)
        .then(() => { if (alive.current && cacheRevision.current === revision) {
          serverSaved.current = true;
          try { localStorage.removeItem(`${storageKey}:${snapshot.requirementId}`); } catch { /* Cloud copy is durable. */ }
          if (recovering.current === snapshot.requirementId) {
            try { localStorage.removeItem(`${storageKey}:${snapshot.requirementId}:recovery`); } catch { /* Cloud copy is durable. */ }
            recovering.current = null;
          }
          setCacheStatus("saved");
        } })
        .catch(() => { if (alive.current && cacheRevision.current === revision) setCacheStatus(localSaved.current ? "error" : "failed"); });
    }, 450);
    return () => clearTimeout(timer);
  }, [project.id, requirementId, cacheReady, mode, model, knowledgeBaseIds, reviewEnabled, review, instructions, history, answers, clarifications, confirmedAnswers, confirmedRulesOnly, draft, analysis, written, reviewStale, view, resultTab]);
  function report(failure) {
    if (failure.name !== "AbortError" && alive.current) {
      setError(failure.message);
      setRequestWarnings(failure.warnings || []);
      showError?.(failure.message);
    }
  }
  function resetDraft() {
    setDraft(null);
    setAnalysis(null);
    setAnswers({});
    setConfirmedAnswers({});
    setClarifications("");
    setHistory([]);
    setSelected(/* @__PURE__ */ new Set());
    setWritten(/* @__PURE__ */ new Map());
    setConfirmedRulesOnly(false);
    setReviewStale(false);
    setRequestWarnings([]);
  }
  async function changeRequirement(id) {
    if (locked.current || busy || !cacheReady) return;
    const token = ++cacheLoad.current;
    const previous = cacheSnapshot.current;
    locked.current = true;
    setBusy("cache");
    if (previous && !serverSaved.current) {
      try {
        await queueSave(previous); serverSaved.current = true;
        if (recovering.current === previous.requirementId) {
          try { localStorage.removeItem(`${storageKey}:${previous.requirementId}:recovery`); } catch { /* Cloud copy is durable. */ }
          recovering.current = null;
        }
      }
      catch (failure) {
        if (!localSaved.current) {
          locked.current = false; setBusy("");
          setError(`原需求草稿保存失败，未切换：${failure.message}`);
          return;
        }
        setCacheStatus("error");
      }
    }
    if (!alive.current || token !== cacheLoad.current) return;
    try {
      let saved = null;
      if (id) ({ saved } = await request(`/api/workspace/ai-draft?projectId=${encodeURIComponent(project.id)}&requirementId=${encodeURIComponent(id)}`));
      if (!alive.current || token !== cacheLoad.current) return;
      const local = id ? localDraft(storageKey, id) : null;
      setCacheReady(false);
      setRequirementId(id);
      resetDraft();
      chooseCachedDraft(saved, local, id);
      if (previous && serverSaved.current) {
        try { localStorage.removeItem(`${storageKey}:${previous.requirementId}`); } catch { /* Cloud copy is durable. */ }
      }
    } catch (failure) {
      if (!alive.current || token !== cacheLoad.current) return;
      const local = id ? localDraft(storageKey, id) : null;
      if (local && (!local.state?.knowledgeBaseIds?.length || canKnowledge) && (local.state?.draft?.type !== "cases" || canSave)) {
        serverVersions.current.set(id, local.baseUpdatedAt ?? null);
        setCacheReady(false); setRequirementId(id); resetDraft(); restoreCache(local, id, true);
        setCacheStatus("error");
      } else { locked.current = false; setBusy(""); }
      setError(`草稿读取失败：${failure.message}`);
    }
  }
  function resizeAssistant(event) {
    if (!resizeStart.current) return;
    const available = event.currentTarget.parentElement.clientWidth;
    const maximum = Math.max(300, available - 520);
    setAssistantWidth(Math.min(maximum, Math.max(300, resizeStart.current.width + resizeStart.current.x - event.clientX)));
  }
  async function generate(task, asRevision = false) {
    if (blocked || locked.current) return;
    if (
      !asRevision &&
      waitingForAnswers &&
      ["points", "cases"].includes(task)
    ) {
      setError("请先回答待澄清项，或明确选择仅覆盖已确认规则");
      return;
    }
    if (task === "cases" && !canSave) {
      setError("请联系管理员开通测试用例写入权限");
      return;
    }
    if (task === "cases" && draft?.type === "points" && !validPoints) {
      setError("请先补全每个测试点的分类、模块、标题和验证结果");
      return;
    }
    const message = instructions.trim();
    if (asRevision && !message) {
      setError("请在右侧输入需要修改或补充的内容");
      return;
    }
    const freshAnswers = Object.fromEntries(
      questions
        .filter((question) => answers[question]?.trim())
        .map((question) => [question, answers[question].trim()]),
    );
    const nextAnswers = { ...confirmedAnswers, ...freshAnswers };
    const answered = Object.entries(nextAnswers)
      .map(
        ([question, answer]) => `${question}
答：${answer}`,
      )
      .join("\n\n");
    const nextNotes = [
      ...new Set([clarifications, message].filter(Boolean)),
    ].join("\n\n");
    const allClarifications = [nextNotes, answered]
      .filter(Boolean)
      .join("\n\n");
    if (allClarifications.length > 12e3) {
      setError("补充说明过长，请整理到 12000 字以内后重试");
      return;
    }
    const freshAnswerText = Object.entries(freshAnswers)
      .map(
        ([question, answer]) => `${question}
答：${answer}`,
      )
      .join("\n\n");
    const nextHistory = [
      ...history,
      {
        role: "user",
        content: [
          message ||
            {
              analysis: "分析需求并列出待澄清项",
              points: "根据已确认规则梳理测试点",
              cases: mode === "quick" ? "快速生成用例" : "确认测试点并生成用例",
            }[task],
          freshAnswerText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ].slice(-20);
    if (nextHistory.at(-1).content.length > 12e3) {
      setError("本轮回答和说明超过 12000 字，请分轮补充");
      return;
    }
    while (
      nextHistory.length > 1 &&
      nextHistory.reduce((sum, entry) => sum + entry.content.length, 0) > 55e3
    )
      nextHistory.shift();
    const controller = new AbortController();
    pending.current = controller;
    const token = ++operation.current;
    locked.current = true;
    setBusy("generate");
    setError("");
    setRequestWarnings([]);
    try {
      const result = normalizeDraft(
        await request("/api/workspace/ai", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectId: project.id,
            model: selectedModel,
            task: asRevision ? "revise" : task,
            outputType: asRevision ? draft.type : task,
            requirementId,
            knowledgeBaseIds,
            instructions: message,
            clarifications: allClarifications,
            confirmedRulesOnly,
            points: task === "cases" ? confirmedPoints : [],
            draft: asRevision ? draft : void 0,
            history: nextHistory,
            review: reviewEnabled
              ? review
                  .filter((item) => item.enabled)
                  .map(({ dimension, weight }) => ({ dimension, weight }))
              : [],
          }),
        }),
      );
      if (!alive.current || operation.current !== token || !canWriteRef.current)
        return;
      setDraft(result);
      if (result.type === "analysis") setAnalysis(result);
      const summary =
        result.type === "cases"
          ? `已生成 ${result.cases.length} 条用例草稿，请审核后写入。`
          : result.type === "points"
            ? `已整理 ${result.points.length} 个测试点，请编辑并确认。`
            : "需求分析已更新，可继续补充规则。";
      const reply = [
        summary,
        result.questions.length
          ? `仍需确认：
${result.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`
          : "本轮没有新增待澄清项。",
      ].join("\n\n");
      setHistory(
        [
          ...nextHistory,
          {
            role: "assistant",
            content:
              reply.length > 12e3
                ? `${reply.slice(0, 11800)}
（完整问题见待澄清项）`
                : reply,
          },
        ].slice(-20),
      );
      setClarifications(nextNotes);
      setConfirmedAnswers(nextAnswers);
      setAnswers({});
      setInstructions("");
      setSelected(/* @__PURE__ */ new Set());
      setResultTab("draft");
      setReviewStale(false);
    } catch (failure) {
      if (operation.current === token) report(failure);
    } finally {
      if (alive.current && operation.current === token) {
        locked.current = false;
        pending.current = null;
        setBusy("");
      }
    }
  }
  function cancel() {
    operation.current += 1;
    pending.current?.abort();
    pending.current = null;
    locked.current = false;
    setBusy("");
    onNotice?.("已取消生成，保留当前草稿");
  }
  function updateDraft(key, id, field, value) {
    const limit =
      field === "module"
        ? 100
        : field === "title"
          ? 200
          : key === "points" && field === "expected"
            ? 1e3
            : 2e3;
    const text = typeof value === "string" ? value.slice(0, limit) : value;
    setDraft((previous) => ({
      ...previous,
      [key]: previous[key].map((item) =>
        item.id === id ? { ...item, [field]: text } : item,
      ),
    }));
    if (key === "cases") setReviewStale(true);
  }
  function removeItem(key, id) {
    setDraft((previous) => ({
      ...previous,
      [key]: previous[key].filter((item) => item.id !== id),
    }));
    setSelected((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    if (key === "cases") setReviewStale(true);
  }
  async function save(selectedOnly) {
    if (saveBlocked || locked.current || !draft?.title?.trim()) return;
    const cases = selectedOnly
      ? unsavedCases.filter((item) => selected.has(item.id))
      : unsavedCases;
    if (!cases.length) return;
    if (cases.some((item) => !validCase(item) || !hasEvidence(item))) {
      setError(
        "请先补全所选用例的分类、模块、标题、前置条件、步骤、预期和可核实的资料出处",
      );
      return;
    }
    locked.current = true;
    setBusy("save");
    setError("");
    const token = ++operation.current;
    const controller = new AbortController();
    pending.current = controller;
    try {
      await request("/api/cases", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          projectId: project.id,
          requirementId,
          title: draft.title.trim(),
          tree: casesToTree(draft.title.trim(), cases),
        }),
      });
      if (!alive.current || operation.current !== token) return;
      const nextWritten = new Map(written);
      cases.forEach((item) =>
        nextWritten.set(item.id, caseSnapshot(item, draft.title)),
      );
      setWritten(nextWritten);
      setSelected(/* @__PURE__ */ new Set());
      onNotice?.(`已写入 ${cases.length} 条用例，可在测试用例库查看导图`);
      onRefresh?.();
    } catch (failure) {
      if (operation.current === token) report(failure);
    } finally {
      if (alive.current && operation.current === token) {
        locked.current = false;
        pending.current = null;
        setBusy("");
      }
    }
  }
  const disabledEdit = !canWrite || !cacheReady || Boolean(busy);
  return (
    <section className="workspace-section aw-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AI TEST DESIGN</span>
          <h1>AI 用例生成</h1>
          <p>选择需求与知识库，先审核测试点，再写入思维导图用例集</p>
        </div>
        <span className="aw-model">
          <Bot size={15} />
          {selectedModel || "未配置模型"} ·{" "}
          {config.aiReasoningEffort || "默认"}
        </span>
      </div>
      {(requirementId || cacheStatus === "load-error") && <div className={`aw-cache-status ${["error", "failed", "load-error"].includes(cacheStatus) || recovery ? "error" : ""}`} role="status">
        <span>{recovery ? "云端草稿有更新，本机未同步副本已保留" : cacheStatus === "loading" ? "正在恢复草稿" : cacheStatus === "saving" ? "草稿保存中" : cacheStatus === "failed" ? "草稿保存失败，请检查存储和网络" : cacheStatus === "load-error" ? "草稿读取失败，暂不可编辑" : cacheStatus === "error" ? "草稿云端保存失败，本机副本已保留" : cacheStatus === "empty" ? "尚无草稿" : "草稿已自动保存"}</span>
        {recovery && <button type="button" className="text-button" onClick={() => {
          const copy = recovery;
          setRecovery(null);
          recovering.current = copy.requirementId;
          restoreCache(copy, copy.requirementId, true);
        }}>恢复本机副本</button>}
        {cacheStatus === "load-error" && <button type="button" className="icon-button" aria-label="重试读取草稿" title="重试读取草稿" onClick={() => setCacheRetry((value) => value + 1)}><RefreshCw size={15} /></button>}
      </div>}
      <ol className="aw-stages">
        {stages.map((label, index) => (
          <li className={index <= stage ? "active" : ""} key={label}>
            <span>{index < stage ? <Check size={14} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {!config.aiConfigured && (
        <div className="inline-error">
          <AlertCircle size={16} />
          AI 服务尚未配置，请联系管理员。
        </div>
      )}
      {!canRequirements && (
        <div className="inline-error">
          请联系管理员开通需求管理查看权限，或使用下方临时文档入口。
        </div>
      )}
      {!canSave && (
        <p className="aw-warning">生成或写入测试用例需要测试用例编辑权限。</p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <AlertCircle size={16} />
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setError("")}
          >
            关闭
          </button>
        </div>
      )}
      {!draft &&
        requestWarnings.map((warning, index) => (
          <p className="aw-warning" key={index}>
            {typeof warning === "string"
              ? warning
              : warning.message || JSON.stringify(warning)}
          </p>
        ))}
      <div className={`aw-layout ${expanded ? "aw-layout-expanded" : ""}`} style={{ "--aw-assistant-width": `${assistantWidth}px` }}>
        <div className="aw-result">
          <div className="aw-result-head">
            <div>
              <h2>生成结果</h2>
              <p>所有内容均为草稿，确认写入后才会进入用例库</p>
            </div>
            <div className="heading-actions">
              <button type="button" className="icon-button" title={expanded ? "还原分栏" : "展开结果区"} aria-label={expanded ? "还原分栏" : "展开结果区"} onClick={() => setExpanded((value) => !value)}>
                {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              {draft?.type === "cases" && (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={
                      saveBlocked || selectedInvalid || !pendingSelectedCount
                    }
                    onClick={() => save(true)}
                  >
                    写入选中 ({pendingSelectedCount})
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      saveBlocked ||
                      invalidCases ||
                      missingEvidence ||
                      !unsavedCases.length
                    }
                    onClick={() => save(false)}
                  >
                    写入剩余 ({unsavedCases.length})
                  </button>
                </>
              )}
            </div>
          </div>
          {!draft ? (
            <div className="aw-empty">
              <Sparkles size={32} />
              <h3>从一份策划需求开始</h3>
              <p>在右侧选择需求文档，可引用项目知识库补充业务背景。</p>
              <p>分步模式会先澄清需求，再提供可编辑的测试点。</p>
              {canRequirements && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={onCreateRequirement}
                >
                  <Plus size={16} />
                  导入或新建需求
                </button>
              )}
            </div>
          ) : (
            <>
              <label className="field aw-draft-title">
                <span>草稿名称</span>
                <input
                  value={draft.title || ""}
                  maxLength={200}
                  disabled={disabledEdit}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <div className="aw-tabs">
                <button
                  type="button"
                  aria-pressed={resultTab === "draft"}
                  onClick={() => setResultTab("draft")}
                >
                  {draft.type === "cases"
                    ? `用例草稿 (${caseItems.length})`
                    : draft.type === "points"
                      ? `待确认测试点 (${pointItems.length})`
                      : "需求分析"}
                </button>
                {draft.type === "cases" && (
                  <button
                    type="button"
                    aria-pressed={resultTab === "review"}
                    onClick={() => setResultTab("review")}
                  >
                    多维评审报告
                  </button>
                )}
                {analysis && draft.type !== "analysis" && (
                  <button
                    type="button"
                    aria-pressed={resultTab === "analysis"}
                    onClick={() => setResultTab("analysis")}
                  >
                    需求分析
                  </button>
                )}
              </div>
              {resultTab === "analysis" ||
              (draft.type === "analysis" && resultTab === "draft") ? (
                <div className="aw-analysis">
                  <MarkdownView
                    outline
                    content={
                      (resultTab === "analysis" ? analysis : draft)?.content ||
                      ""
                    }
                  />
                </div>
              ) : resultTab === "review" ? (
                <div className="aw-review-report">
                  {reviewStale && (
                    <p className="aw-warning">
                      用例已被手动修改，当前报告对应生成时的内容，可通过对话重新评审。
                    </p>
                  )}
                  {draft.reviewReport?.enabled ? (
                    <>
                      <p>{draft.reviewReport.summary}</p>
                      <strong>
                        加权评分：{draft.reviewReport.weightedScore} / 100
                      </strong>
                      <p className="aw-muted">AI 自评，最终以人工审核为准</p>
                      {draft.reviewReport.dimensions?.map((dimension) => (
                        <article key={dimension.dimension}>
                          <h3>
                            {dimension.dimension}{" "}
                            <span>
                              {dimension.score} 分 · 权重 {dimension.weight}
                            </span>
                          </h3>
                          {dimension.issues?.length ? (
                            dimension.issues.map((issue, i) => (
                              <p key={i}>
                                <strong>
                                  {issue.caseId
                                    ? caseItems.find(
                                        (item) => item.id === issue.caseId,
                                      )?.title || issue.caseId
                                    : "整体"}
                                  ：
                                </strong>
                                {issue.description}
                                <br />
                                建议：{issue.suggestion}
                              </p>
                            ))
                          ) : (
                            <p className="aw-muted">本维度未列出问题</p>
                          )}
                        </article>
                      ))}
                    </>
                  ) : (
                    <p>
                      本次未启用多维评审。勾选右侧评审维度后，可通过对话重新评审。
                    </p>
                  )}
                </div>
              ) : draft.type === "points" ? (
                <>
                  <div className="aw-table-scroll">
                    <table className="aw-points">
                      <thead>
                        <tr>
                          <th>模块</th>
                          <th>测试点</th>
                          <th>分类</th>
                          <th>验证结果</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pointItems.map((point) => (
                          <tr key={point.id}>
                            <td>
                              <input
                                aria-label="测试点模块"
                                maxLength={100}
                                value={point.module}
                                disabled={disabledEdit}
                                onChange={(event) =>
                                  updateDraft(
                                    "points",
                                    point.id,
                                    "module",
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <textarea
                                aria-label="测试点标题"
                                value={point.title}
                                maxLength={200}
                                disabled={disabledEdit}
                                onChange={(event) =>
                                  updateDraft(
                                    "points",
                                    point.id,
                                    "title",
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <select
                                aria-label="测试点分类"
                                value={point.category}
                                disabled={disabledEdit}
                                onChange={(event) =>
                                  updateDraft(
                                    "points",
                                    point.id,
                                    "category",
                                    event.target.value,
                                  )
                                }
                              >
                                {CATEGORIES.map((name) => (
                                  <option key={name}>{name}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <textarea
                                aria-label="测试点验证结果"
                                value={point.expected}
                                maxLength={1000}
                                disabled={disabledEdit}
                                onChange={(event) =>
                                  updateDraft(
                                    "points",
                                    point.id,
                                    "expected",
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="icon-button danger"
                                aria-label={`删除测试点 ${point.title}`}
                                disabled={disabledEdit}
                                onClick={() => removeItem("points", point.id)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="aw-bottom-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={disabledEdit || pointItems.length >= 200}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          points: [
                            ...pointItems,
                            {
                              id: newId(),
                              module: "",
                              title: "",
                              category: "主流程",
                              expected: "",
                              sourceIds: [],
                            },
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      添加测试点
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={
                        blocked || !canSave || !validPoints || waitingForAnswers
                      }
                      onClick={() => generate("cases")}
                    >
                      确认测试点并生成用例
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="aw-case-tools">
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={
                          caseItems.length > 0 &&
                          selected.size === caseItems.length
                        }
                        disabled={busy !== ""}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? new Set(caseItems.map((item) => item.id))
                              : /* @__PURE__ */ new Set(),
                          )
                        }
                      />
                      全选
                    </label>
                    <div className="aw-view">
                      <button
                        type="button"
                        aria-label="用例表格视图"
                        aria-pressed={view === "table"}
                        onClick={() => setView("table")}
                      >
                        <List size={16} />
                        表格
                      </button>
                      <button
                        type="button"
                        aria-label="用例宫格视图"
                        aria-pressed={view === "grid"}
                        onClick={() => setView("grid")}
                      >
                        <LayoutGrid size={16} />
                        宫格
                      </button>
                    </div>
                  </div>
                  <div className={`aw-cases aw-cases-${view}`}>
                    {caseItems.map((item) => (
                      <article className="aw-case" key={item.id}>
                        <div className="aw-case-heading">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${item.title}`}
                            checked={selected.has(item.id)}
                            disabled={Boolean(busy)}
                            onChange={(event) =>
                              setSelected((previous) => {
                                const next = new Set(previous);
                                if (event.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              })
                            }
                          />
                          <input
                            aria-label="用例标题"
                            value={item.title}
                            maxLength={200}
                            disabled={disabledEdit}
                            onChange={(event) =>
                              updateDraft(
                                "cases",
                                item.id,
                                "title",
                                event.target.value,
                              )
                            }
                          />
                          <button
                            type="button"
                            className="icon-button danger"
                            aria-label={`删除草稿用例 ${item.title}`}
                            disabled={disabledEdit}
                            onClick={() => removeItem("cases", item.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <div className="aw-case-meta">
                          <input
                            aria-label="用例模块"
                            value={item.module}
                            maxLength={100}
                            disabled={disabledEdit}
                            onChange={(event) =>
                              updateDraft(
                                "cases",
                                item.id,
                                "module",
                                event.target.value,
                              )
                            }
                          />
                          <select
                            aria-label="用例分类"
                            value={item.category}
                            disabled={disabledEdit}
                            onChange={(event) =>
                              updateDraft(
                                "cases",
                                item.id,
                                "category",
                                event.target.value,
                              )
                            }
                          >
                            {CATEGORIES.map((name) => (
                              <option key={name}>{name}</option>
                            ))}
                          </select>
                          <select
                            aria-label="用例优先级"
                            value={item.priority}
                            disabled={disabledEdit}
                            onChange={(event) =>
                              updateDraft(
                                "cases",
                                item.id,
                                "priority",
                                event.target.value,
                              )
                            }
                          >
                            {["P0", "P1", "P2", "P3"].map((name) => (
                              <option key={name}>{name}</option>
                            ))}
                          </select>
                        </div>
                        <details open={view === "table"}>
                          <summary>前置条件、步骤与预期</summary>
                          {[
                            ["preconditions", "前置条件"],
                            ["steps", "执行步骤"],
                            ["expected", "预期结果"],
                          ].map(([key, label]) => (
                            <label className="field" key={key}>
                              <span>{label}</span>
                              <textarea
                                value={item[key]}
                                maxLength={2e3}
                                disabled={disabledEdit}
                                onChange={(event) =>
                                  updateDraft(
                                    "cases",
                                    item.id,
                                    key,
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                          ))}
                          <small className="aw-muted">
                            需求：{currentRequirement?.title || requirementId}
                            {item.sourceIds?.length
                              ? ` · 依据 ${item.sourceIds.join("、")}`
                              : ""}
                          </small>
                        </details>
                      </article>
                    ))}
                  </div>
                </>
              )}
              {draft.type === "cases" && caseItems.length > 0 && (
                <p className="aw-muted">
                  已写入 {caseItems.length - unsavedCases.length} /{" "}
                  {caseItems.length} 条用例；重复写入会跳过内容相同的条目。
                </p>
              )}
              {missingEvidence && draft.type === "cases" && (
                <p className="aw-warning">
                  部分用例缺少可核实的资料出处，请通过对话补充依据后再写入。
                </p>
              )}
              {draft.vision && (
                <p className="aw-muted">
                  本轮实际附入模型 {draft.vision.attachedImages || 0} 张图片。
                </p>
              )}
              {[...(draft.warnings || []), ...requestWarnings]
                .filter(
                  (warning, index, values) => values.indexOf(warning) === index,
                )
                .map((warning, index) => (
                  <p className="aw-warning" key={index}>
                    {typeof warning === "string"
                      ? warning
                      : warning.message || JSON.stringify(warning)}
                  </p>
                ))}
              {!draft.sources?.length && (
                <p className="aw-warning">本轮没有返回可核实的资料出处。</p>
              )}
              <Sources sources={draft.sources} />
            </>
          )}
        </div>
        <div className="aw-splitter" role="separator" aria-label="调整助手宽度" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={720} aria-valuenow={assistantWidth} tabIndex={0} title="拖动以调整助手宽度"
          onPointerDown={(event) => { if (event.button !== 0) return; resizeStart.current = { x: event.clientX, width: assistantWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={resizeAssistant}
          onPointerUp={() => { resizeStart.current = null; }}
          onPointerCancel={() => { resizeStart.current = null; }}
          onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setAssistantWidth((width) => Math.min(720, Math.max(300, width + (event.key === "ArrowLeft" ? 24 : -24)))); } }}
        />
        <aside className="aw-assistant">
          <div className="aw-assistant-title">
            <MessageSquare size={17} />
            <h2>用例设计助手</h2>
          </div>
          <div className="aw-context">
            <label className="field">
              <span>需求文档</span>
              <select
                aria-label="选择需求文档"
                value={requirementId}
                disabled={disabledEdit || !canRequirements}
                onChange={(event) => changeRequirement(event.target.value)}
              >
                <option value="">请先选择需求</option>
                {requirements.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="aw-model-setting">
              <label className="field">
                <span>生成模型</span>
                <select
                  aria-label="生成模型"
                  value={selectedModel}
                  disabled={disabledEdit || modelStatus === "loading" || !config.aiConfigured}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {modelCatalog.models.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label="刷新模型列表"
                title="刷新模型列表"
                disabled={disabledEdit || modelStatus === "loading" || !config.aiConfigured}
                onClick={() => setModelRetry((value) => value + 1)}
              ><RefreshCw size={16} /></button>
            </div>
            {["error", "fallback"].includes(modelStatus) && config.aiConfigured && <p className="aw-muted aw-model-warning">模型列表暂未同步，仅可使用当前默认模型。</p>}
            {canKnowledge && (
              <details>
                <summary>知识库参考 ({knowledgeBaseIds.length}/10)</summary>
                {libraries.length ? (
                  libraries.map((library) => (
                    <label className="check-field" key={library.id}>
                      <input
                        type="checkbox"
                        disabled={
                          disabledEdit ||
                          (!knowledgeBaseIds.includes(library.id) &&
                            knowledgeBaseIds.length >= 10)
                        }
                        checked={knowledgeBaseIds.includes(library.id)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setKnowledgeBaseIds((previous) =>
                            checked
                              ? previous.length < 10
                                ? [...previous, library.id]
                                : previous
                              : previous.filter((id) => id !== library.id),
                          );
                        }}
                      />
                      {library.name}
                    </label>
                  ))
                ) : (
                  <p className="aw-muted">此项目还没有知识库</p>
                )}
              </details>
            )}
            <label className="field">
              <span>生成模式</span>
              <select
                value={mode}
                disabled={disabledEdit}
                onChange={(event) => {
                  if (
                    !draft ||
                    window.confirm("切换模式将清空当前草稿，确定继续？")
                  ) {
                    setMode(event.target.value);
                    resetDraft();
                  }
                }}
              >
                <option value="staged">分步生成 · 澄清 → 测试点 → 用例</option>
                <option value="quick">快速生成 · 直接生成用例</option>
              </select>
            </label>
            <details className="aw-review-settings">
              <summary>
                多维评审 · {reviewEnabled ? "已开启" : "已关闭"}
              </summary>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={reviewEnabled}
                  disabled={disabledEdit}
                  onChange={(event) => setReviewEnabled(event.target.checked)}
                />
                启用用例评审
              </label>
              <p className="aw-muted">勾选维度并设置权重，1–5，越高越优先</p>
              {review.map((item, index) => (
                <div className="aw-review-setting" key={item.dimension}>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      disabled={disabledEdit || !reviewEnabled}
                      checked={item.enabled}
                      onChange={(event) =>
                        setReview(
                          review.map((old, i) =>
                            i === index
                              ? { ...old, enabled: event.target.checked }
                              : old,
                          ),
                        )
                      }
                    />
                    {item.dimension}
                  </label>
                  <select
                    aria-label={`${item.dimension}权重`}
                    value={item.weight}
                    disabled={disabledEdit || !reviewEnabled || !item.enabled}
                    onChange={(event) =>
                      setReview(
                        review.map((old, i) =>
                          i === index
                            ? { ...old, weight: Number(event.target.value) }
                            : old,
                        ),
                      )
                    }
                  >
                    {[1, 2, 3, 4, 5].map((weight) => (
                      <option key={weight}>{weight}</option>
                    ))}
                  </select>
                </div>
              ))}
            </details>
          </div>
          <div className="aw-messages" role="log" aria-live="polite">
            {conversation.length ? (
              conversation.map((message, index) => (
                <article className={`aw-message ${message.role}`} key={index}>
                  <small>{message.role === "user" ? "你" : "助手"}</small>
                  <p>{message.content}</p>
                </article>
              ))
            ) : (
              <article className="aw-message assistant">
                <small>助手</small>
                <p>
                  先选择需求和参考资料。生成结果可继续通过对话调整，写入前请完成审核。
                </p>
              </article>
            )}
            {busy === "generate" && (
              <div className="aw-working">
                <LoaderCircle size={17} className="spin" />
                正在结合需求与参考资料分析，可能需要数分钟…
              </div>
            )}
          </div>
          {questions.length > 0 && (
            <div className="aw-questions">
              <h3>待澄清项 ({questions.length})</h3>
              {questions.map((question, index) => (
                <label className="field" key={question}>
                  <span>
                    {index + 1}. {question}
                  </span>
                  <textarea
                    aria-label={`澄清回答 ${index + 1}`}
                    value={answers[question] || ""}
                    maxLength={2e3}
                    disabled={disabledEdit}
                    placeholder="填写产品已确认的规则；未知可保留"
                    onChange={(event) =>
                      setAnswers({ ...answers, [question]: event.target.value })
                    }
                  />
                </label>
              ))}
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={confirmedRulesOnly}
                  disabled={disabledEdit}
                  onChange={(event) =>
                    setConfirmedRulesOnly(event.target.checked)
                  }
                />
                仅覆盖已明确规则，保留未知项
              </label>
            </div>
          )}
          <div className="aw-composer">
            <label className="field">
              <span title={mode === "staged" ? "分步模式按已审核并保留的测试点生成用例" : "快速模式按需求中已确认的规则生成用例"}>{draft ? "补充规则或修改意见" : "测试范围（留空按完整需求）"}</span>
              <textarea
                aria-label="补充规则或修改意见"
                maxLength={6e3}
                value={instructions}
                disabled={disabledEdit}
                placeholder={
                  draft
                    ? "例如：补充网络异常场景，删除重复测试点"
                    : "例如：仅覆盖活动入口与奖励领取"
                }
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
            <div className="aw-compose-actions">
              {busy === "generate" ? (
                <button
                  type="button"
                  className="button secondary"
                  onClick={cancel}
                >
                  <Square size={14} />
                  取消生成
                </button>
              ) : (
                <>
                  {draft && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        blocked ||
                        !instructions.trim() ||
                        (draft.type === "cases" && !canSave)
                      }
                      onClick={() => generate(draft.type, true)}
                    >
                      <Send size={15} />
                      发送修改
                    </button>
                  )}
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      blocked ||
                      waitingForAnswers ||
                      (nextTask === "cases" && !canSave)
                    }
                    onClick={() => generate(nextTask)}
                  >
                    <Sparkles size={16} />
                    {!draft
                      ? mode === "quick"
                        ? "快速生成"
                        : "开始需求分析"
                      : draft.type === "analysis"
                        ? "生成测试点"
                        : draft.type === "points"
                          ? validPoints
                            ? "确认并生成用例"
                            : "生成测试点"
                          : "重新生成"}
                  </button>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
      <details
        className="aw-legacy"
        open={legacy}
        onToggle={(event) => {
          if (!event.currentTarget.open && legacyCloseGuard.current && !legacyCloseGuard.current()) {
            event.currentTarget.open = true;
            return;
          }
          setLegacy(event.currentTarget.open);
        }}
      >
        <summary>
          <FileText size={16} />
          临时文档生成与飞书连接
        </summary>
        {legacy && (
          <AiDocuments
            config={config}
            projects={projects}
            userId={userId}
            activeProjectId={project.id}
            registerCloseGuard={(guard) => { legacyCloseGuard.current = guard; }}
            canWrite={canWrite}
            canSave={canSave}
            isAdmin={isAdmin}
            onRefresh={onRefresh}
            showError={showError}
            onNotice={onNotice}
          />
        )}
      </details>
    </section>
  );
}
export { casesToTree, AiWorkspace as default };
