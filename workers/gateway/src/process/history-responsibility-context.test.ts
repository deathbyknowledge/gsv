import { describe, expect, it } from "vitest";
import type { ProcHistoryEventPayloadMap, ResponsibilityRecord, ResponsibilityTransition } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { ProcessStore } from "./store";

const businessFields = [
  "title", "state", "details", "priority", "assignee", "parentId", "audience", "source",
  "blocker", "dueAtMs", "nextCheckAtMs", "leaseExpiresAtMs", "resolution",
];

function responsibility(): ResponsibilityRecord {
  return {
    id: "r12y:fixture", ownerUid: 1000, parentId: "r12y:parent", title: "Inspect fixture files",
    details: { task: "Check the fixture", options: ["text", "image"] },
    source: { kind: "system", component: "fixture" },
    audience: { conversationIds: ["conversation:fixture"] },
    assignee: { kind: "process", processId: "proc:fixture-worker" },
    state: "active", priority: "normal", blocker: "Waiting for fixture input",
    dueAtMs: 10_000, nextCheckAtMs: 20_000, leaseExpiresAtMs: 30_000,
    dedupeKey: "fixture-key", resolution: { progress: "Fixture prepared" },
    revision: 1, createdAtMs: 100, updatedAtMs: 100,
  };
}

function transition(record: ResponsibilityRecord, revision: number, changedFields: string[]): ResponsibilityTransition {
  return {
    revision, responsibilityId: record.id, kind: "updated", beforeState: record.state, afterState: record.state,
    changedFields, actor: { kind: "process", processId: "proc:fixture-worker" },
    record: { ...record, revision, updatedAtMs: revision * 100 }, createdAtMs: revision * 100,
  };
}

function createEpoch(store: ProcessStore, id: string, baseline: ResponsibilityRecord[] = [], rendered?: boolean) {
  return store.epochs.createContextEpoch({
    id, generation: 0, systemPrompt: "Synthetic context fixture", r12yRevision: baseline[0]?.revision ?? 0,
    r12yCount: baseline.length, r12yBaseline: baseline,
    sourceManifest: rendered === undefined ? {} : { r12yBaselineRendered: rendered },
    observedProjection: {}, now: 100,
  });
}

function appendAndAssert(
  store: ProcessStore,
  epochId: string,
  change: ResponsibilityTransition,
  contextFields: string[],
): string {
  const original = structuredClone(change);
  expect(store.epochs.appendContextEpochTransition(epochId, change, "run:fixture")).toBe(change.revision);
  expect(change).toEqual(original);
  const message = store.messages.getMessages().at(-1)!;
  expect(message.records).toEqual([{
    kind: "event", payload: {
      kind: "responsibility.revision", payload: { epochId, transition: original, contextFields },
      severity: "info", audience: "model",
    },
  }]);
  expect(store.epochs.listContextEpochTransitions(epochId).at(-1)).toEqual(original);
  expect(store.messages.getRecords().at(-1)).toMatchObject({
    kind: "event", payload: { payload: { transition: original, contextFields } },
  });
  expect(store.messages.toMessages().at(-1)).toMatchObject({
    role: "user", content: `[GSV EVENT]\n${message.content}`,
  });
  return message.content;
}

describe("durable responsibility context projections", () => {
  it("introduces an unknown assigned record, remembers exact fields after reload, and renders cleared details", async () => {
    const stub = await initProcess("responsibility-context-unknown", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      const epoch = createEpoch(process.store, "epoch:unknown", [], true);
      const assigned = transition(responsibility(), 2, ["assignee"]);
      const introduced = appendAndAssert(process.store, epoch.id, assigned, businessFields);
      expect(introduced).toContain("New title: \"Inspect fixture files\"");
      expect(introduced).toContain("New details:");
      expect(introduced).toContain("Check the fixture");
      expect(introduced).toContain("New source:");
      expect(introduced).toContain("New resolution:");
      expect(introduced).not.toContain("fixture-key");

      const reloaded = new ProcessStore(process.store.sql);
      const priority = transition({ ...assigned.record, priority: "high" }, 3, ["priority"]);
      const updated = appendAndAssert(reloaded, epoch.id, priority, ["priority"]);
      expect(updated).toContain("New priority: high");
      expect(updated).not.toContain("Inspect fixture files");
      expect(updated).not.toContain("New details:");
      expect(updated).not.toContain("New source:");

      const withoutDetails = { ...priority.record };
      delete withoutDetails.details;
      const cleared = transition(withoutDetails, 4, ["details"]);
      const clearedText = appendAndAssert(reloaded, epoch.id, cleared, ["details"]);
      expect(clearedText).toContain("New details: cleared");
      expect(clearedText).not.toContain("Check the fixture");
      const messages = reloaded.messages.getMessages();
      const transitions = reloaded.epochs.listContextEpochTransitions(epoch.id);
      expect(reloaded.epochs.appendContextEpochTransition(epoch.id, cleared, "run:duplicate")).toBe(4);
      expect(reloaded.messages.getMessages()).toEqual(messages);
      expect(reloaded.epochs.listContextEpochTransitions(epoch.id)).toEqual(transitions);
    });
  });

  it.each([true, false, undefined])("only trusts fields actually rendered in the epoch baseline: %s", async (rendered) => {
    const stub = await initProcess(`responsibility-context-baseline-${String(rendered)}`, ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      const record = responsibility();
      const epoch = createEpoch(process.store, "epoch:baseline", [record], rendered);
      const change = transition({ ...record, state: "waiting" }, 2, ["state"]);
      const selected = rendered
        ? ["state", "details", "parentId", "audience", "source", "resolution"]
        : businessFields;
      const text = appendAndAssert(process.store, epoch.id, change, selected);
      expect(text).toContain("New state: waiting");
      expect(text).toContain("New details:");
      expect(text).toContain("New source:");
      for (const label of ["title", "priority", "assignee", "blocker", "due", "next check", "lease expires"]) {
        if (rendered) expect(text).not.toContain(`New ${label}:`);
        else expect(text).toContain(`New ${label}:`);
      }
      expect(process.store.epochs.getLiveContextEpoch()?.r12yBaseline).toEqual([record]);
    });
  });

  it("introduces details again in a new epoch whose baseline omits them", async () => {
    const stub = await initProcess("responsibility-context-new-epoch", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      const record = responsibility();
      const first = createEpoch(process.store, "epoch:first", [record], true);
      const change = transition(record, 2, ["state"]);
      const fields = ["state", "details", "parentId", "audience", "source", "resolution"];
      appendAndAssert(process.store, first.id, change, fields);
      process.store.epochs.deleteContextEpochOwnedMessages(first.id);
      expect(process.store.messages.toMessages()).toEqual([]);
      process.store.epochs.closeLiveContextEpoch("compaction", 300);
      const reloaded = new ProcessStore(process.store.sql);
      const second = createEpoch(reloaded, "epoch:second", [change.record], true);
      const next = transition({ ...change.record, state: "waiting" }, 3, ["state"]);
      const text = appendAndAssert(reloaded, second.id, next, fields);
      expect(text).toContain("New details:");
      expect(text).toContain("Check the fixture");
      expect(reloaded.epochs.listContextEpochTransitions(first.id)).toEqual([change]);
      expect(reloaded.epochs.listContextEpochTransitions(second.id)).toEqual([next]);
    });
  });

  it.each([{ contextFields: undefined }, { contextFields: ["state"] }])("remembers the fields actually rendered by older complete and partial events: %j", async ({ contextFields }) => {
    const stub = await initProcess(`responsibility-context-prior-${contextFields ? "partial" : "old"}`, ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      const epoch = createEpoch(process.store, "epoch:prior");
      const prior = transition(responsibility(), 2, ["state"]);
      const payload: ProcHistoryEventPayloadMap["responsibility.revision"] = { epochId: epoch.id, transition: prior };
      if (contextFields !== undefined) payload.contextFields = contextFields;
      const messageId = process.store.messages.appendMessage("system", "Earlier fixture event", { record: {
        kind: "event", payload: {
          kind: "responsibility.revision", payload, severity: "info", audience: "model",
        },
      } });
      process.store.sql.exec(
        "INSERT INTO context_epoch_transitions (epoch_id, revision, transition_json, message_id, created_at) VALUES (?, ?, ?, ?, ?)",
        epoch.id, prior.revision, JSON.stringify(prior), messageId, prior.createdAtMs,
      );
      process.store.epochs.advanceContextEpochObservedRevision(epoch.id, prior.revision);
      const reloaded = new ProcessStore(process.store.sql);
      const priorText = reloaded.messages.toMessages()[0]?.content;
      if (contextFields === undefined) expect(priorText).toContain("New details:");
      else expect(priorText).not.toContain("New details:");
      const next = transition({ ...prior.record, priority: "high" }, 3, ["priority"]);
      const selected = contextFields === undefined ? ["priority"] : businessFields.filter((field) => field !== "state");
      const text = appendAndAssert(reloaded, epoch.id, next, selected);
      expect(text).toContain("New priority: high");
      for (const label of ["title", "details", "source"]) {
        if (contextFields === undefined) expect(text).not.toContain(`New ${label}:`);
        else expect(text).toContain(`New ${label}:`);
      }
      expect(reloaded.epochs.listContextEpochTransitions(epoch.id)).toEqual([prior, next]);
    });
  });

  it("counts only model-visible primary fields in imported events without local epoch transition rows", async () => {
    const stub = await initProcess("responsibility-context-imported", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      const epoch = createEpoch(process.store, "epoch:local");
      const imported = transition(responsibility(), 2, ["state"]);
      const payload = { epochId: "epoch:another-process", transition: imported, contextFields: ["title", "details"] };
      const messageId = process.store.messages.appendMessage("system", "Imported fixture event", { record: {
        kind: "event", payload: { kind: "responsibility.revision", payload, severity: "info", audience: "model" },
      } });
      process.store.messages.appendRelatedRecord(messageId, {
        kind: "event", payload: {
          kind: "responsibility.revision", payload: { ...payload, contextFields: businessFields },
          severity: "info", audience: "model",
        },
      });
      process.store.messages.appendMessage("system", "Person-only fixture event", { record: {
        kind: "event", payload: {
          kind: "responsibility.revision", payload: { ...payload, contextFields: businessFields },
          severity: "info", audience: "person",
        },
      } });
      expect(process.store.epochs.listContextEpochTransitions(epoch.id)).toEqual([]);
      const reloaded = new ProcessStore(process.store.sql);
      const modelMessages = reloaded.messages.toMessages();
      expect(modelMessages).toHaveLength(1);
      expect(modelMessages[0]?.content).toContain("New title:");
      expect(modelMessages[0]?.content).toContain("New details:");
      expect(modelMessages[0]?.content).not.toContain("New source:");
      const next = transition({ ...imported.record, priority: "high" }, 3, ["priority"]);
      const selected = businessFields.filter((field) => field !== "title" && field !== "details");
      const text = appendAndAssert(reloaded, epoch.id, next, selected);
      expect(text).not.toContain("New title:");
      expect(text).not.toContain("New details:");
      expect(text).toContain("New source:");
      expect(text).toContain("New priority: high");
      expect(reloaded.epochs.listContextEpochTransitions(epoch.id)).toEqual([next]);
    });
  });
});
