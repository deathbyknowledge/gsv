import { describe, expect, it } from "vitest";
import { PROCESS_MIGRATIONS, PROCESS_SCHEMA_COMPONENT } from "./migrations";

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
  it("starts the process component at a v1 baseline", () => {
    expect(PROCESS_SCHEMA_COMPONENT).toBe("process");
    expect(PROCESS_MIGRATIONS).toHaveLength(1);
    expect(PROCESS_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_process_schema",
    });
  });

  it("creates the current process table set", () => {
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

  it("keeps the messages baseline on the current conversation schema", () => {
    const messages = createTableStatement("messages");

    expect(messages).toContain("conversation_id TEXT NOT NULL DEFAULT 'default'");
    expect(messages).toContain("generation INTEGER NOT NULL DEFAULT 1");
    expect(messages).toContain("media_json TEXT");
    expect(messages).toContain("origin_json TEXT");
  });

  it("keeps queued and pending work scoped by conversation generation", () => {
    const pendingToolCalls = createTableStatement("pending_tool_calls");
    const messageQueue = createTableStatement("message_queue");
    const pendingHil = createTableStatement("pending_hil");

    for (const statement of [pendingToolCalls, messageQueue, pendingHil]) {
      expect(statement).toContain("conversation_id TEXT NOT NULL DEFAULT 'default'");
      expect(statement).toContain("generation INTEGER NOT NULL DEFAULT 1");
    }
    expect(messageQueue).toContain("overrides_json TEXT");
    expect(messageQueue).toContain("origin_json TEXT");
  });

  it("includes current indexes owned by the process store", () => {
    expect(createdIndexes()).toEqual([
      "messages_conversation_id_id_idx",
      "conversation_archives_conversation_generation_idx",
    ]);
  });

  it("does not include ad hoc legacy column migrations in the v1 baseline", () => {
    expect(normalizedStatements().some((statement) => statement.startsWith("ALTER TABLE "))).toBe(false);
  });
});
