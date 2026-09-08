import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProcMessageMetadata, ResourceBlock } from "@humansandmachines/gsv/protocol";
import { procHistoryRecordSchema } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import { getProcessByPid } from "../shared/utils";
import { listAppliedSqlMigrations, runSqlMigrations } from "../schema/runner";
import { PROCESS_MIGRATIONS, PROCESS_SCHEMA_COMPONENT } from "./schema/migrations";
import { parseArchivedMessageRecord, serializeArchivedMessage } from "./history/helpers";
import { historyOutputResources, inferHistoryRecords } from "./storage/history-records";
import { ProcessStore } from "./store";

const metadata: ProcMessageMetadata = {
  contextEpochId: "epoch:fixture",
  generationContextId: "generation:fixture",
  provider: {
    api: "openai-responses", provider: "openai", model: "fixture-model",
    responseId: "response:fixture", stopReason: "toolUse",
  },
  usage: {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 50,
    cacheWriteTokens: 10, totalTokens: 180, cost: null,
  },
};
const assistantSidecar = JSON.stringify({
  thinking: [{ type: "thinking", thinking: "Planning", thinkingSignature: "thinking-signature", redacted: false }],
  toolCalls: [
    { type: "toolCall", id: "call:read", name: "Read", arguments: { path: "/one", target: "gsv" }, thoughtSignature: "call-signature" },
    { type: "toolCall", id: "call:shell", name: "Shell", arguments: { command: "pwd" } },
  ],
});

function appendTranscript(store: ProcessStore, legacy: boolean): number[] {
  const runId = "run:fixture";
  return [
    store.messages.appendMessage("user", "Inspect this workspace.", { runId, legacy, createdAt: 100 }),
    store.messages.appendMessage("system", "An older runtime notice.", { runId, legacy, createdAt: 110 }),
    store.messages.appendMessage("assistant", "I will inspect two things.", {
      runId, legacy, createdAt: 120, toolCalls: assistantSidecar, metadata,
    }),
    store.messages.appendMessage("toolResult", '{"ok":true,"text":"first"}', {
      runId, legacy, createdAt: 130, toolCallId: "call:read",
      toolCalls: JSON.stringify({ toolName: "Read", isError: false, outcome: "completed" }),
    }),
    store.messages.appendMessage("toolResult", '{"ok":true,"stdout":"/root"}', {
      runId, legacy, createdAt: 140, toolCallId: "call:shell",
      toolCalls: JSON.stringify({ toolName: "Shell", isError: false, outcome: "completed" }),
    }),
  ];
}

function resource(path: string): ResourceBlock {
  return {
    type: "resource",
    ref: { type: "file", target: "gsv", path, revision: "revision:fixture", contentType: "image/png", size: 1 },
  };
}

describe("typed Process history storage", () => {
  it("upgrades genuine v13 rows and queue provenance without rewriting their contents", async () => {
    const stub = await getProcessByPid("typed-history-v13");
    await runInDurableObject(stub, async (_process: Process, state) => {
      await state.storage.deleteAll();
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS.filter(({ id }) => id <= 13));
      const sql = state.storage.sql;
      expect(sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray().map(({ name }) => name)).not.toContain("kind");
      sql.exec(
        `INSERT INTO messages (generation, run_id, role, content, tool_calls, metadata_json, created_at)
         VALUES (1, 'run:old', 'assistant', 'Old assistant text.', ?, ?, 100)`,
        assistantSidecar, JSON.stringify(metadata),
      );
      sql.exec(
        `INSERT INTO message_queue (run_id, generation, role, kind, message, provenance_json, created_at)
         VALUES ('run:queued', 1, 'system', 'runtime.wake', 'Old wake.', ?, 200)`,
        JSON.stringify({ eventType: "runtime.wake", source: "process" }),
      );
      const before = sql.exec("SELECT id, generation, run_id, role, content, tool_calls, metadata_json, created_at FROM messages").toArray();
      const queuedBefore = sql.exec("SELECT * FROM message_queue").toArray();

      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);

      expect(sql.exec("SELECT id, generation, run_id, role, content, tool_calls, metadata_json, created_at FROM messages").toArray()).toEqual(before);
      expect(sql.exec("SELECT kind, payload_json, group_message_id FROM messages").toArray()).toEqual([
        { kind: null, payload_json: null, group_message_id: null },
      ]);
      expect(sql.exec("SELECT * FROM message_queue").toArray()).toEqual(queuedBefore.map((row) => ({ ...row, record_json: null })));
      expect(listAppliedSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT)).toHaveLength(14);
      const store = new ProcessStore(sql);
      expect(store.messages.getRecords().map(({ kind, source }) => [kind, source])).toEqual([
        ["note", "legacy"], ["call", "legacy"], ["call", "legacy"],
      ]);
      expect(sql.exec("SELECT kind FROM messages").toArray()).toEqual([{ kind: null }]);
    });
  });

  it("keeps grouped calls invisible to legacy paging and reproduces exact provider context", async () => {
    const stub = await getProcessByPid("typed-history-context");
    await runInDurableObject(stub, (process: Process) => {
      const { store } = process;
      appendTranscript(store, true);
      const legacyContext = JSON.stringify(store.messages.toMessages({
        contextEpochId: "epoch:fixture", generationContextId: "generation:fixture",
      }));
      store.messages.clearMessages();
      const ids = appendTranscript(store, false);
      expect(JSON.stringify(store.messages.toMessages({
        contextEpochId: "epoch:fixture", generationContextId: "generation:fixture",
      }))).toBe(legacyContext);
      expect(store.messages.messageCount()).toBe(5);
      expect(store.messages.messageStats()).toEqual({ count: 5, firstMessageId: ids[0], lastMessageId: ids[4] });
      expect(store.messages.getMessages({ limit: 2, offset: 2 }).map(({ id }) => id)).toEqual(ids.slice(2, 4));
      expect(store.messages.getMessages({ tail: true, limit: 2 }).map(({ id }) => id)).toEqual(ids.slice(3));
      expect(store.messages.getMessages({ beforeMessageId: ids[4], limit: 2 }).map(({ id }) => id)).toEqual(ids.slice(2, 4));
      expect(store.messages.getMessages({ afterMessageId: ids[2] }).map(({ id }) => id)).toEqual(ids.slice(3));
      expect(store.messages.hasMessageBefore(ids[0]!)).toBe(false);
      expect(store.messages.hasMessageAfter(ids[4]!)).toBe(false);
      const records = store.messages.getRecords({ limit: 1, offset: 2 });
      expect(records.map(({ kind, index, messageId }) => [kind, index, messageId])).toEqual([
        ["note", 0, ids[2]], ["call", 1, ids[2]], ["call", 2, ids[2]],
      ]);
      expect(new Set(records.map(({ id }) => id)).size).toBe(3);
      for (const record of records) {
        expect(procHistoryRecordSchema.parse(record)).toEqual(record);
        expect(record.metadata).toEqual(metadata);
      }
      expect(records[0]).toMatchObject({ payload: { thinking: [{ thinkingSignature: "thinking-signature", redacted: false }] } });
      expect(records[1]).toMatchObject({ payload: { thoughtSignature: "call-signature", syscall: "fs.read", target: "gsv" } });
    });
  });

  it("retains late typed records attached to a preupgrade assistant turn", async () => {
    const stub = await getProcessByPid("typed-history-promote");
    await runInDurableObject(stub, (process: Process) => {
      const { store } = process;
      const messageId = store.messages.appendMessage("assistant", "Old turn.", {
        legacy: true, runId: "run:old", createdAt: 100, toolCalls: assistantSidecar, metadata,
      });
      const before = JSON.stringify(store.messages.toMessages());
      store.messages.appendRunRecord("run:old", {
        kind: "message",
        payload: { direction: "out", text: "Delivered.", media: [], origin: {}, conversationMessageId: "message:sent" },
      });
      const records = store.messages.getRecords();
      expect(records.map(({ kind }) => kind)).toEqual(["note", "call", "call", "message"]);
      expect(records.every((record) => record.messageId === messageId && record.source === "typed")).toBe(true);
      expect(new Set(records.map(({ id }) => id)).size).toBe(4);
      expect(store.messages.messageCount()).toBe(1);
      expect(JSON.stringify(store.messages.toMessages())).toBe(before);
      expect(records[0]?.metadata).toEqual(metadata);
      expect(records[3]).toMatchObject({ payload: { origin: {}, conversationMessageId: "message:sent" } });
    });
  });

  it("synchronizes delayed media updates while ignoring a stale run", async () => {
    const stub = await getProcessByPid("typed-history-media");
    await runInDurableObject(stub, (process: Process) => {
      const { store } = process;
      const messageId = store.messages.appendMessage("user", "A voice message", { runId: "run:media" });
      const media = [{ type: "audio", mimeType: "audio/ogg", url: "https://example.test/audio.ogg", transcription: "A voice message", description: "A short recording" }];
      store.messages.updateMessageMedia(messageId, "run:stale", JSON.stringify(media));
      expect(store.messages.getRecords()[0]).toMatchObject({ payload: { media: [] } });
      store.messages.updateMessageMedia(messageId, "run:media", JSON.stringify(media));
      expect(store.messages.getRecords()[0]).toMatchObject({ payload: { media } });
      expect(JSON.parse(store.messages.getMessages()[0]!.media!)).toEqual(media);
      store.messages.clearMessageMedia(messageId, "run:stale");
      expect(store.messages.getRecords()[0]).toMatchObject({ payload: { media } });
      store.messages.clearMessageMedia(messageId, "run:media");
      expect(store.messages.getRecords()[0]).toMatchObject({ payload: { media: [] } });
      expect(store.messages.getMessages()[0]?.media).toBeNull();
    });
  });

  it("retains mixed legacy and typed groups through archive restore and compaction", async () => {
    const stub = await getProcessByPid("typed-history-archive");
    await runInDurableObject(stub, (process: Process) => {
      const { store } = process;
      store.messages.appendMessage("user", "Legacy input.", { legacy: true, createdAt: 100 });
      store.messages.appendMessage("assistant", "Typed response.", {
        createdAt: 200, metadata, toolCalls: assistantSidecar,
      });
      const before = store.messages.getRecords().map(({ kind, payload, source, metadata }) => ({ kind, payload, source, metadata }));
      const archives = store.messages.getMessages().map((message) => serializeArchivedMessage(message));
      expect(archives[0]?.records).toBeUndefined();
      expect(archives[1]?.records).toBeDefined();
      store.messages.clearMessages();
      for (const archive of archives) {
        process.history.appendRestoredArchivedMessage(parseArchivedMessageRecord(archive), 1);
      }
      expect(store.messages.getRecords().map(({ kind, payload, source, metadata }) => ({ kind, payload, source, metadata }))).toEqual(before);
      const messages = store.messages.getMessages();
      store.messages.appendRelatedRecord(messages[1]!.id, {
        kind: "message", payload: { direction: "out", text: "Delivered.", media: [], origin: {} },
      });
      store.history.compactHistoryPrefix({
        generation: 1, fromMessageId: messages[0]!.id, toMessageId: messages[1]!.id,
        summary: "Process history compacted.\nSummary.",
        record: {
          kind: "event",
          payload: {
            kind: "history.compacted",
            payload: { summary: "Summary.", segmentId: "segment:1", archivedMessages: 2, archivePath: "/archive.jsonl" },
            severity: "info", audience: "model",
          },
        },
      });
      expect(store.messages.getRecords().map(({ kind }) => kind)).toEqual(["event"]);
      expect(store.sql.exec("SELECT group_message_id FROM messages").toArray()).toEqual([{ group_message_id: null }]);
    });
  });

  it("preserves legacy denied and interrupted outcomes through an archive roundtrip", async () => {
    const stub = await getProcessByPid("typed-history-legacy-outcomes");
    await runInDurableObject(stub, (process: Process) => {
      const { store } = process;
      store.messages.appendMessage("toolResult", "Error: Tool execution denied by user", {
        legacy: true, runId: "run:legacy", toolCallId: "call:denied", createdAt: 100,
        toolCalls: JSON.stringify({ toolName: "Read", isError: true }),
      });
      store.messages.appendMessage("toolResult", "Error: User interrupted tool execution", {
        legacy: true, runId: "run:legacy", toolCallId: "call:interrupted", createdAt: 110,
        toolCalls: JSON.stringify({ toolName: "Shell", isError: true }),
      });
      const before = store.messages.getRecords().filter((record) => record.kind === "result").map((record) => record.payload);
      expect(before.map(({ outcome }) => outcome)).toEqual(["denied", "cancelled"]);
      const archives = store.messages.getMessages().map((message) => serializeArchivedMessage(message));
      store.messages.clearMessages();
      for (const archive of archives) {
        process.history.appendRestoredArchivedMessage(parseArchivedMessageRecord(archive), 1);
      }
      expect(store.messages.getRecords().filter((record) => record.kind === "result").map((record) => record.payload)).toEqual(before);
    });
  });

  it("unwraps legacy tool media and preserves first occurrence resource ordering", () => {
    const first = resource("/first.png");
    const second = resource("/second.png");
    const media = [{ type: "image", mimeType: "image/png", url: "https://example.test/image.png" }];
    const records = inferHistoryRecords({
      id: 1, generation: 1, role: "toolResult", toolCallId: "call:1",
      content: JSON.stringify({ __gsvStoredToolResult: 1, output: { content: [first, second, first] }, media }),
      toolCalls: JSON.stringify({ toolName: "Read", isError: false }),
      media: null, metadata: null, createdAt: 100,
    });
    expect(records).toEqual([{
      kind: "result",
      payload: {
        callId: "call:1", tool: "Read", outcome: "completed",
        output: { content: [first, second, first] }, media, resources: [first, second],
      },
    }]);
    expect(historyOutputResources({ earlier: [first], later: { content: [second, first] } })).toEqual([first, second]);
  });
});
