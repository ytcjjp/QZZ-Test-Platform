const PREFIX = "qzz:plan-draft:v1";

export function planCacheKeys(userId, projectId, requirementId) {
  const scope = [userId, projectId, requirementId]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");
  const prefix = `${PREFIX}:${scope}`;
  return {
    selected: `${prefix}:selected`,
    draft: (planId) => `${prefix}:draft:${encodeURIComponent(planId || "new")}`,
  };
}

export function readPlanCache(storage, key) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key));
    return value && typeof value === "object" &&
      typeof value.title === "string" && typeof value.content === "string" &&
      typeof value.version === "string" && typeof value.iteration === "string" &&
      Number.isInteger(value.baseRevision) && value.baseRevision >= 0
      ? value
      : null;
  } catch {
    return null;
  }
}

export function readPlanSelection(storage, key, plans, hasNewDraft = false) {
  let selected = null;
  try {
    selected = storage?.getItem(key);
  } catch {
    // Browser storage can be unavailable in private browsing modes.
  }
  if (selected === "new" && hasNewDraft) return "";
  return plans.some((plan) => plan.id === selected)
    ? selected
    : plans[0]?.id || "";
}

export function writePlanCache(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function writePlanSelection(storage, key, planId) {
  if (!storage) return;
  try {
    storage.setItem(key, planId || "new");
  } catch {
    // Plan selection still works for the current session.
  }
}

export function removePlanCache(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // An unavailable cache must not block saving to the server.
  }
}
