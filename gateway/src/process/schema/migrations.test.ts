import { describe, expect, it } from "vitest";
import { PROCESS_MIGRATIONS, PROCESS_SCHEMA_COMPONENT } from "./migrations";
import { PROCESS_V001_INITIAL_SCHEMA } from "./v001_initial";
import { PROCESS_V002_MESSAGE_RUN_ID } from "./v002_message_run_id";
import { PROCESS_V003_MESSAGE_METADATA } from "./v003_message_metadata";
import { PROCESS_V005_TOOL_RESULT_OUTCOME } from "./v005_tool_result_outcome";
import { PROCESS_V006_PENDING_HIL_OWNER } from "./v006_pending_hil_owner";
import { PROCESS_V008_SINGLE_PROCESS_HISTORY } from "./v008_single_process_history";

function normalizedStatements(): string[] {
  return PROCESS_MIGRATIONS.flatMap((migration) => migration.statements)
    .map((statement) => statement.trim().replace(/\s+/g, " "));
}

function createdTables(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createdIndexes(): string[] {
  return normalizedStatements()
    .map((statement) => statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function createTableStatement(name: string): string {
  const statement = normalizedStatements().find((candidate) => (
    candidate.startsWith(`CREATE TABLE IF NOT EXISTS ${name} `)
  ));
  if (!statement) {
    throw new Error(`missing CREATE TABLE statement for ${name}`);
  }
  return statement;
}

describe("process schema migrations", () => {
  it("starts the process component at a v1 baseline with ordered migrations", () => {
    expect(PROCESS_SCHEMA_COMPONENT).toBe("process");
    expect(PROCESS_MIGRATIONS).toHaveLength(8);
    expect(PROCESS_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_process_schema",
    });
    expect(PROCESS_MIGRATIONS[1]).toMatchObject({
      id: 2,
      name: "add_message_run_id",
    });
    expect(PROCESS_MIGRATIONS[2]).toMatchObject({
      id: 3,
      name: "add_message_metadata",
    });
    expect(PROCESS_MIGRATIONS[3]).toMatchObject({
      id: 4,
      name: "rebuild_pending_tool_dispatch_state",
    });
    expect(PROCESS_MIGRATIONS[4]).toMatchObject({
      id: 5,
      name: "add_tool_result_outcome",
    });
    expect(PROCESS_MIGRATIONS[5]).toMatchObject({
      id: 6,
      name: "add_pending_hil_owner",
    });
    expect(PROCESS_MIGRATIONS[6]).toMatchObject({
      id: 7,
      name: "remove_process_context",
    });
    expect(PROCESS_MIGRATIONS[7]).toMatchObject({
      id: 8,
      name: "single_process_history",
    });
  });

  it("keeps the shipped v1 table set intact", () => {
    expect(createdTables()).toEqual([
      "conversations",
      "messages",
      "pending_tool_calls",
      "process_kv",
      "message_queue",
      "pending_hil",
      "conversation_segments",
      "conversation_archives",
    ]);
  });

  it("keeps the shipped messages baseline intact", () => {
    const messages = createTableStatement("messages");

    expect(messages).toContain("conversation_id TEXT NOT NULL DEFAULT 'default'");
    expect(messages).toContain("generation INTEGER NOT NULL DEFAULT 1");
    expect(messages).toContain("media_json TEXT");
    expect(messages).toContain("origin_json TEXT");
  });

  it("keeps the shipped queue baseline intact", () => {
    const messageQueue = createTableStatement("message_queue");

    expect(messageQueue).toContain("conversation_id TEXT NOT NULL DEFAULT 'default'");
    expect(messageQueue).toContain("generation INTEGER NOT NULL DEFAULT 1");
    expect(messageQueue).toContain("overrides_json TEXT");
    expect(messageQueue).toContain("origin_json TEXT");
  });

  it("keeps the shipped indexes intact", () => {
    expect(createdIndexes()).toEqual([
      "messages_conversation_id_id_idx",
      "conversation_archives_conversation_generation_idx",
      "messages_run_id_idx",
    ]);
  });

  it("does not include ad hoc legacy column migrations in the v1 baseline", () => {
    expect(PROCESS_V001_INITIAL_SCHEMA.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "))
      .some((statement) => statement.startsWith("ALTER TABLE "))).toBe(false);
  });

  it("adds run ids to persisted messages in v2", () => {
    const statements = PROCESS_V002_MESSAGE_RUN_ID.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "));
    expect(statements).toContain("ALTER TABLE messages ADD COLUMN run_id TEXT");
    expect(statements).toContain("CREATE INDEX IF NOT EXISTS messages_run_id_idx ON messages (run_id)");
  });

  it("adds typed metadata to persisted messages in v3", () => {
    const statements = PROCESS_V003_MESSAGE_METADATA.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "));
    expect(statements).toContain("ALTER TABLE messages ADD COLUMN metadata_json TEXT");
  });

  it("adds structured outcomes to pending tool state in v5", () => {
    const statements = PROCESS_V005_TOOL_RESULT_OUTCOME.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "));
    expect(statements).toContain("ALTER TABLE pending_tool_calls ADD COLUMN outcome TEXT");
    expect(statements.some((statement) => (
      statement.startsWith("UPDATE pending_tool_calls SET outcome = CASE")
    ))).toBe(true);
  });

  it("links nested approvals to their owning tool in v6", () => {
    const statements = PROCESS_V006_PENDING_HIL_OWNER.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "));
    expect(statements).toContain("ALTER TABLE pending_hil ADD COLUMN owner_dispatch_id TEXT");
    expect(statements.some((statement) => statement.startsWith("UPDATE pending_hil SET owner_dispatch_id")))
      .toBe(true);
    expect(statements.some((statement) => statement.startsWith("UPDATE pending_tool_calls SET status = 'error'")))
      .toBe(true);
  });

  it("removes persisted process context in v7", () => {
    expect(normalizedStatements()).toContain("DELETE FROM process_kv WHERE key = 'processContextFiles'");
  });

  it("moves the default conversation into process-scoped history in v8", () => {
    const statements = PROCESS_V008_SINGLE_PROCESS_HISTORY.statements
      .map((statement) => statement.trim().replace(/\s+/g, " "));

    expect(statements).toContain("ALTER TABLE messages_v8 RENAME TO messages");
    expect(statements).toContain("ALTER TABLE pending_tool_calls_v8 RENAME TO pending_tool_calls");
    expect(statements).toContain("ALTER TABLE message_queue_v8 RENAME TO message_queue");
    expect(statements).toContain("ALTER TABLE pending_hil_v8 RENAME TO pending_hil");
    expect(statements).toContain("DROP TABLE conversation_segments");
    expect(statements).toContain("DROP TABLE conversation_archives");
    expect(statements).toContain("DROP TABLE conversations");

    const messages = statements.find((statement) => statement.startsWith("CREATE TABLE messages_v8"));
    const queue = statements.find((statement) => statement.startsWith("CREATE TABLE message_queue_v8"));
    const segments = statements.find((statement) => statement.startsWith("CREATE TABLE history_segments"));
    expect(messages).not.toContain("conversation_id");
    expect(queue).not.toContain("conversation_id");
    expect(segments).not.toContain("conversation_id");
    expect(statements.some((statement) => (
      statement.includes("FROM messages WHERE conversation_id = 'default'")
    ))).toBe(true);
  });
});
