const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(value);

export function normalizeModelCatalog(payload, configuredModel, configuredEffort = "ultra") {
  const models = [];
  const seen = new Set();
  for (const entry of Array.isArray(payload?.models) ? payload.models : []) {
    if (!validId(entry?.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const reasoningEfforts = Array.isArray(entry.reasoningEfforts)
      ? [...new Set(entry.reasoningEfforts.filter((effort) => [configuredEffort, "xhigh", "ultra"].includes(effort)))]
      : [configuredEffort];
    models.push({ id: entry.id, label: typeof entry.label === "string" && entry.label.trim() ? entry.label.slice(0, 120) : entry.id, reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : [configuredEffort] });
  }
  if (!models.length && validId(configuredModel)) models.push({ id: configuredModel, label: configuredModel, reasoningEfforts: [configuredEffort] });
  const requestedDefault = validId(payload?.defaultModel) ? payload.defaultModel : configuredModel;
  const defaultModel = models.some((entry) => entry.id === requestedDefault) ? requestedDefault : models[0]?.id || "";
  return { models, defaultModel };
}

export function resolveModelSelection(selected, catalog) {
  return catalog.models.some((entry) => entry.id === selected) ? selected : catalog.defaultModel;
}

export function modelReasoningEfforts(model, catalog, configuredEffort) {
  return catalog.models.find((entry) => entry.id === model)?.reasoningEfforts || [configuredEffort];
}

export function resolveReasoningSelection(selected, model, catalog, configuredEffort) {
  const choices = modelReasoningEfforts(model, catalog, configuredEffort);
  return choices.includes(selected) ? selected : choices.includes(configuredEffort) ? configuredEffort : choices[0];
}
