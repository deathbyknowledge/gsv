import type { ProcHistoryRecordData, ResponsibilityRecord, ResponsibilityTransition } from "@humansandmachines/gsv/protocol";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { formatResponsibilityBaseline } from "./internal/events";

type ResponsibilityEvent = Extract<ProcHistoryRecordData, { kind: "event" }> & {
  payload: Extract<Extract<ProcHistoryRecordData, { kind: "event" }>["payload"], { kind: "responsibility.revision" }>;
};

function responsibilityEvent(record: ProcHistoryRecordData): ResponsibilityEvent {
  if (record.kind !== "event" || record.payload.kind !== "responsibility.revision") {
    throw new Error("Expected a responsibility event");
  }
  return { kind: "event", payload: record.payload };
}

describe("responsibility history import", () => {
  it.each(["whole", "split", "terminal"] as const)(
    "introduces imported responsibilities independently of their source baseline (%s)",
    async (selection) => {
      const source = await initProcess(`responsibility-import-source-${selection}`, ROOT_IDENTITY);
      const fixture = await runInProcess(source, async (process: Process) => {
        const baseline: ResponsibilityRecord = {
          id: "r12y:imported", ownerUid: 0, title: "Verify the counters", state: "open",
          priority: "normal", assignee: { kind: "ship" },
          source: { kind: "system", component: "fixture" }, details: { task: "Inspect counters" },
          blocker: "Awaiting access", dueAtMs: 10_000, revision: 1, createdAtMs: 100, updatedAtMs: 100,
        };
        const ledger = { responsibilities: [baseline], count: 1, revision: 1 };
        const epoch = process.store.epochs.createContextEpoch({
          id: "source-epoch", generation: 1, systemPrompt: formatResponsibilityBaseline(ledger),
          r12yRevision: 1, r12yCount: 1, r12yBaseline: [baseline],
          sourceManifest: { r12yBaselineRendered: true }, observedProjection: {}, now: 100,
        });
        const activeRecord: ResponsibilityRecord = { ...baseline, state: "active", revision: 2, updatedAtMs: 200 };
        delete activeRecord.blocker;
        const active: ResponsibilityTransition = {
          responsibilityId: baseline.id, revision: 2, kind: "updated", beforeState: "open", afterState: "active",
          changedFields: ["state", "blocker"], actor: { kind: "system", component: "fixture" },
          record: activeRecord, createdAtMs: 200,
        };
        const resolvedRecord: ResponsibilityRecord = {
          ...activeRecord, state: "resolved", details: { progress: "Counters verified" },
          resolution: { evidence: "Counter report" }, revision: 3, updatedAtMs: 300, resolvedAtMs: 300,
        };
        delete resolvedRecord.dueAtMs;
        const resolved: ResponsibilityTransition = {
          responsibilityId: baseline.id, revision: 3, kind: "resolved", beforeState: "active", afterState: "resolved",
          changedFields: ["state", "details", "dueAtMs", "resolution"], actor: active.actor,
          record: resolvedRecord, createdAtMs: 300,
        };
        process.store.epochs.appendContextEpochTransition(epoch.id, active, "source-run");
        process.store.epochs.appendContextEpochTransition(epoch.id, resolved, "source-run");
        const messages = process.store.messages.getMessages();
        for (const message of messages) expect(message.content).not.toContain("New title:");
        let archivePaths: string[];
        if (selection === "whole") {
          const exported = await process.history.handleHistoryExport({ throughMessageId: messages.at(-1)!.id });
          if (!exported.ok) throw new Error(exported.error);
          archivePaths = exported.archivePaths;
        } else {
          const selected = selection === "terminal" ? messages.slice(-1) : messages;
          archivePaths = [];
          for (const message of selected) {
            archivePaths.push(await process.history.archiveForkMessages(
              `root/processes/${process.pid}/history`, [message],
            ));
          }
        }
        const archives = [];
        for (const path of archivePaths) archives.push(await process.history.readArchivedMessageRecords(path));
        return { archivePaths, archives, transitions: selection === "terminal" ? [resolved] : [active, resolved] };
      });

      const target = await initProcess(`responsibility-import-target-${selection}`, ROOT_IDENTITY);
      const beforeEviction = await runInProcess(target, async (process: Process) => {
        expect(await process.history.handleHistoryImport({ archivePaths: fixture.archivePaths })).toMatchObject({
          ok: true, restoredMessages: fixture.transitions.length,
        });
        const records = process.store.messages.getRecords().map(responsibilityEvent);
        expect(records.map((record) => record.payload.payload.transition)).toEqual(fixture.transitions);
        for (const record of records) expect(record.payload.payload.epochId).toBe("source-epoch");
        expect(records[0]!.payload.payload.contextFields).toEqual(expect.arrayContaining([
          "title", "state", "details", "priority", "assignee", "source",
        ]));
        if (selection !== "terminal") {
          expect(records[0]!.payload.payload.contextFields).toContain("blocker");
          expect(records[1]!.payload.payload.contextFields).toEqual(["state", "details", "dueAtMs", "resolution"]);
        }
        const messages = process.store.messages.getMessages();
        expect(messages[0]!.content).toContain('New title: "Verify the counters"');
        expect(messages.at(-1)!.content).toContain("New due: cleared");
        if (selection !== "terminal") {
          expect(messages[0]!.content).toContain("New blocker: cleared");
          expect(messages[1]!.content).not.toContain("New title:");
          expect(messages[1]!.content).not.toContain("New assignee:");
        }
        const model = await process.history.buildContextMessages();
        expect(model.map((message) => message.content)).toEqual(messages.map((message, index) => (
          `${index === 0 ? "[Directed endpoint: this GSV process.]\n" : ""}[GSV EVENT]\n${message.content}`
        )));
        return { records, messages: messages.map((message) => message.content) };
      });

      await evictDurableObject(target);
      await runInProcess(target, (process: Process) => {
        expect(process.store.messages.getRecords().map(responsibilityEvent)).toEqual(beforeEviction.records);
        expect(process.store.messages.getMessages().map((message) => message.content)).toEqual(beforeEviction.messages);
        const epoch = process.store.epochs.createContextEpoch({
          id: "target-epoch", generation: 1, systemPrompt: "No unresolved responsibilities.",
          r12yRevision: 3, r12yCount: 0, r12yBaseline: [], sourceManifest: { r12yBaselineRendered: true },
          observedProjection: {}, now: 400,
        });
        const previous = fixture.transitions.at(-1)!;
        process.store.epochs.appendContextEpochTransition(epoch.id, {
          ...previous, revision: 4, kind: "updated", beforeState: "resolved", changedFields: ["details"],
          record: { ...previous.record, details: { progress: "Report delivered" }, revision: 4, updatedAtMs: 400 },
          createdAtMs: 400,
        }, "target-run");
        const appended = responsibilityEvent(process.store.messages.getRecords().at(-1)!);
        expect(appended.payload.payload.contextFields).toEqual(["details"]);
      });

      await runInProcess(source, async (process: Process) => {
        for (const [index, path] of fixture.archivePaths.entries()) {
          expect(await process.history.readArchivedMessageRecords(path)).toEqual(fixture.archives[index]);
        }
        for (const message of process.store.messages.getMessages()) expect(message.content).not.toContain("New title:");
      });
    },
  );
});
