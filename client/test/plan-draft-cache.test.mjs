import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planCacheKeys,
  readPlanCache,
  readPlanSelection,
  removePlanCache,
  writePlanCache,
  writePlanSelection,
} from "../src/plan-draft-cache.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("plan drafts remain isolated by user, project, requirement, and plan", () => {
  const local = storage();
  const mine = planCacheKeys("user-a", "project/1", "requirement/1");
  const theirs = planCacheKeys("user-b", "project/1", "requirement/1");
  const otherRequirement = planCacheKeys("user-a", "project/1", "requirement/2");
  const draft = {
    title: "活动测试计划", version: "1.0", iteration: "首轮",
    content: "# 未保存内容", baseRevision: 2,
  };
  assert.ok(writePlanCache(local, mine.draft("plan/1"), draft));
  assert.deepEqual(readPlanCache(local, mine.draft("plan/1")), draft);
  for (const key of [mine.draft("plan/2"), theirs.draft("plan/1"), otherRequirement.draft("plan/1")])
    assert.equal(readPlanCache(local, key), null);
  removePlanCache(local, mine.draft("plan/1"));
  assert.equal(readPlanCache(local, mine.draft("plan/1")), null);
});

test("the last selected saved plan reopens, with a recent-plan fallback", () => {
  const local = storage();
  const keys = planCacheKeys("user-a", "project-a", "requirement-a");
  const plans = [{ id: "recent" }, { id: "older" }];
  assert.equal(readPlanSelection(local, keys.selected, plans), "recent");
  writePlanSelection(local, keys.selected, "older");
  assert.equal(readPlanSelection(local, keys.selected, plans), "older");
  writePlanSelection(local, keys.selected, "removed");
  assert.equal(readPlanSelection(local, keys.selected, plans), "recent");
  writePlanSelection(local, keys.selected, "");
  assert.equal(readPlanSelection(local, keys.selected, plans), "recent");
  assert.equal(readPlanSelection(local, keys.selected, plans, true), "");
});

test("invalid or unavailable browser storage does not break plan editing", () => {
  const local = storage();
  local.setItem("invalid", "{bad json");
  assert.equal(readPlanCache(local, "invalid"), null);
  local.setItem("invalid", JSON.stringify({ title: "Plan", content: "x", version: "", iteration: "", baseRevision: -1 }));
  assert.equal(readPlanCache(local, "invalid"), null);
  const unavailable = {
    getItem() { throw new Error("unavailable"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("unavailable"); },
  };
  const keys = planCacheKeys("user-a", "project-a", "requirement-a");
  assert.equal(readPlanCache(unavailable, keys.draft("new")), null);
  assert.equal(readPlanSelection(unavailable, keys.selected, [{ id: "first" }]), "first");
  assert.equal(writePlanCache(unavailable, keys.draft("new"), {}), false);
  assert.doesNotThrow(() => removePlanCache(unavailable, keys.draft("new")));
});
