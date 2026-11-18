const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(value);

export function normalizeModelCatalog(payload, configuredModel) {
  const models = [];
  const seen = new Set();
  for (const entry of Array.isArray(payload?.models) ? payload.models : []) {
    if (!validId(entry?.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push({ id: entry.id, label: typeof entry.label === "string" && entry.label.trim() ? entry.label.slice(0, 120) : entry.id });
  }
  if (!models.length && validId(configuredModel)) models.push({ id: configuredModel, label: configuredModel });
  const requestedDefault = validId(payload?.defaultModel) ? payload.defaultModel : configuredModel;
  const defaultModel = models.some((entry) => entry.id === requestedDefault) ? requestedDefault : models[0]?.id || "";
  return { models, defaultModel };
}

export function resolveModelSelection(selected, catalog) {
  return catalog.models.some((entry) => entry.id === selected) ? selected : catalog.defaultModel;
}
