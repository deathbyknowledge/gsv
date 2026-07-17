import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { canonicalJsonBytes, parseCanonicalJson } from "@humansandmachines/gsv-portable-archive";
import { ObjectSemanticDigestV1 } from "@humansandmachines/gsv-portable-archive/semantic";
import { encodeDataFrameStream } from "@humansandmachines/gsv/protocol/data-frame-stream";
import { describe, expect, it } from "vitest";
import {
  beginLogicalDurableObjectRestore,
  NonPortableDoError,
  restoreLogicalDurableObjectStream,
  snapshotLogicalDurableObject,
  type LogicalDoSnapshotFrame,
} from "../src/portable-do";
import { validatePortableDoIdentifier } from "../src/portable-do-identifiers";
import type { PortableDoFixture } from "./worker";

const fence = { assertFenced() {} };

describe("logical Durable Object snapshots", () => {
  it("rejects control characters and malformed Unicode in logical identifiers", async () => {
    expect(() => validatePortableDoIdentifier("restore\ud800", "restore restoreId"))
      .toThrow(/restore restoreId is invalid/);
    const stub = object("invalid-identifiers");
    await runInDurableObject(stub, async (instance: PortableDoFixture) => {
      await expect(async () => {
        for await (const _frame of snapshotLogicalDurableObject(instance.testStorage, {
          objectId: "object\u0085id",
          fence,
        })) {
          // consume
        }
      }).rejects.toThrow(/snapshot objectId is invalid/);

      await expect(beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore\u0085id",
        objectId: "object",
        fence,
      })).rejects.toThrow(/restore restoreId is invalid/);
      expect([...instance.testStorage.kv.list()]).toEqual([]);
    });
  });

  it("restores bounded framed streams and cancels exact completed replays before pulling", async () => {
    const objectId = "framed-process";
    const source = object("framed-source");
    const frames = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      instance.testStorage.sql.exec("CREATE TABLE framed (id INTEGER PRIMARY KEY, value TEXT)");
      instance.testStorage.sql.exec("INSERT INTO framed VALUES (1, 'portable')");
      instance.testStorage.kv.put("setting", { enabled: true });
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId,
        fence,
      })) output.push(frame);
      return output;
    });
    const semantic = await ObjectSemanticDigestV1.create(objectId);
    let bodyBytes = 0;
    for (const frame of frames) {
      await semantic.append(frame);
      bodyBytes += frame.body.byteLength;
    }

    const target = object("framed-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      instance.testStorage.sql.exec("CREATE TABLE framed (id INTEGER PRIMARY KEY, value TEXT)");
      const options = {
        restoreId: "framed-restore",
        objectId,
        fence,
        schemaMode: "fresh-migrated" as const,
        frameCount: frames.length.toString(),
        bodyBytes: bodyBytes.toString(),
        semanticSha256: semantic.digestBase64Url(),
      };
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        encodeDataFrameStream(frames),
        options,
      )).resolves.toMatchObject({ status: "applied" });
      expect(
        instance.testStorage.sql
          .exec<{ value: string }>("SELECT value FROM framed WHERE id = 1")
          .toArray()[0]?.value,
      ).toBe("portable");
      expect(instance.testStorage.kv.get("setting")).toEqual({ enabled: true });

      const replay = trackStream(encodeDataFrameStream(frames));
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        replay.stream,
        options,
      )).resolves.toMatchObject({ status: "replayed" });
      expect(replay.pulls).toBe(0);
      expect(replay.cancellations).toBe(1);

      const changedControls = [
        { ...options, frameCount: (frames.length + 1).toString() },
        { ...options, bodyBytes: (bodyBytes + 1).toString() },
        { ...options, semanticSha256: differentDigest(options.semanticSha256) },
        { ...options, preservedKvPrefixes: ["owner:"] },
      ];
      for (const changed of changedControls) {
        const rejected = trackStream(encodeDataFrameStream(frames));
        await expect(restoreLogicalDurableObjectStream(
          instance.testStorage,
          rejected.stream,
          changed,
        )).rejects.toMatchObject({ code: "restore_conflict" });
        expect(rejected.pulls).toBe(0);
        expect(rejected.cancellations).toBe(1);
      }
    });
  });

  it("does not finalize an accepting journal after semantic digest failure", async () => {
    const objectId = "digest-retry-process";
    const source = object("digest-retry-source");
    const frames = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      instance.testStorage.sql.exec("CREATE TABLE digest_retry (id INTEGER PRIMARY KEY, value TEXT)");
      instance.testStorage.sql.exec("INSERT INTO digest_retry VALUES (1, 'verified')");
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId,
        fence,
      })) output.push(frame);
      return output;
    });
    const correct = await transcriptForFrames(objectId, frames);
    const incorrect = {
      ...correct,
      semanticSha256: differentDigest(correct.semanticSha256),
    };

    const target = object("digest-retry-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const options = {
        restoreId: "digest-retry-restore",
        objectId,
        fence,
        ...incorrect,
      };
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        encodeDataFrameStream(frames),
        options,
      )).rejects.toMatchObject({ code: "invalid_archive_record" });

      const unfinished = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: options.restoreId,
        objectId,
        fence,
        transcript: incorrect,
      });
      expect(unfinished.phase).toBe("accepting");
      await expect(unfinished.finalize()).rejects.toMatchObject({
        code: "restore_incomplete",
      });
      await expect(unfinished.finalize(correct)).rejects.toMatchObject({
        code: "restore_conflict",
      });

      const retry = trackStream(encodeDataFrameStream(frames));
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        retry.stream,
        options,
      )).rejects.toMatchObject({ code: "invalid_archive_record" });
      expect(retry.pulls).toBeGreaterThan(0);

      const changed = trackStream(encodeDataFrameStream(frames));
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        changed.stream,
        { ...options, semanticSha256: correct.semanticSha256 },
      )).rejects.toMatchObject({ code: "restore_conflict" });
      expect(changed.pulls).toBe(0);
      expect(changed.cancellations).toBe(1);
      expect(
        [...instance.testStorage.kv.list({ prefix: "__gsv:restore:complete:" })],
      ).toEqual([]);
    });
  });

  it("cancels streams rejected by transcript validation without pulling", async () => {
    const target = object("invalid-transcript-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const rejected = trackStream(encodeDataFrameStream([]));
      await expect(restoreLogicalDurableObjectStream(
        instance.testStorage,
        rejected.stream,
        {
          restoreId: "invalid-transcript-restore",
          objectId: "invalid-transcript-object",
          fence,
          frameCount: "01",
          bodyBytes: "0",
          semanticSha256: "A".repeat(43),
        },
      )).rejects.toThrow(/frameCount is invalid/);
      expect(rejected.pulls).toBe(0);
      expect(rejected.cancellations).toBe(1);
    });
  });

  it("pins the canonical empty-object v1 descriptor and schema records", async () => {
    const stub = object("golden-empty");
    const frames = await runInDurableObject(stub, async (instance: PortableDoFixture) => {
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId: "golden-object",
        fence,
      })) output.push(frame);
      return output;
    });
    expect(frames).toHaveLength(2);
    expect(new TextDecoder().decode(frames[0]!.body)).toBe(
      '{"alarm":null,"format":"gsv-do-logical-snapshot","kv":{"entryCount":"0"},"objectId":"golden-object","record":"descriptor","sqlite":{"rowCount":"0","tableCount":"0"},"version":1}',
    );
    expect(new TextDecoder().decode(frames[1]!.body)).toBe(
      '{"format":"gsv-do-logical-snapshot","indexes":[],"record":"sqlite.schema","sequences":[],"tables":[],"version":1}',
    );
  });

  it("round-trips exact SQLite storage classes, DO KV graphs, large cells, and alarms", async () => {
    const objectId = "process:test/exact";
    const source = object("source");
    const frames = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      const storage = instance.testStorage;
      storage.sql.exec(`
        CREATE TABLE exact_values (
          id INTEGER PRIMARY KEY,
          maximum INTEGER NOT NULL,
          minimum INTEGER NOT NULL,
          real_value REAL NOT NULL,
          infinite_value REAL NOT NULL,
          negative_zero REAL NOT NULL,
          text_value TEXT NOT NULL,
          blob_value BLOB NOT NULL,
          nullable TEXT
        )
      `);
      storage.sql.exec(
        `INSERT INTO exact_values
         VALUES (1, 9223372036854775807, -9223372036854775808, 0.1, 9e999, -0.0,
                 'portable text', X'000102FEFF', NULL)`,
      );
      storage.sql.exec("CREATE INDEX exact_text_idx ON exact_values(text_value)");
      storage.sql.exec("CREATE TABLE sequencing (id INTEGER PRIMARY KEY AUTOINCREMENT)");
      storage.sql.exec("INSERT INTO sequencing DEFAULT VALUES");
      storage.sql.exec("INSERT INTO sequencing(id) VALUES (100)");
      storage.sql.exec("DELETE FROM sequencing WHERE id = 100");
      storage.sql.exec(`
        CREATE TABLE generated_values (
          base INTEGER NOT NULL,
          doubled INTEGER GENERATED ALWAYS AS (base * 2) STORED
        )
      `);
      storage.sql.exec("INSERT INTO generated_values(base) VALUES (7)");
      storage.sql.exec(`
        CREATE TABLE keyed_values (
          group_name TEXT NOT NULL,
          position INTEGER NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (group_name, position)
        ) WITHOUT ROWID
      `);
      storage.sql.exec("INSERT INTO keyed_values VALUES ('b', 2, 'second'), ('a', 1, 'first')");
      storage.kv.put("graph", {
        integer: 9_223_372_036_854_775_807n,
        bytes: new Uint8Array([0, 1, 254, 255]),
        map: new Map([["answer", 42]]),
      });
      await storage.setAlarm(1_900_000_000_000);
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(storage, {
        objectId,
        fence,
        inlineCellBytes: 2,
        cellPartBytes: 3,
        sqlQueryRows: 1,
        kvQueryEntries: 1,
      })) {
        output.push(frame);
      }
      return output;
    });

    expect(frames.map((frame) => frame.kind)).toContain("do.sqlite.cell");
    expect(frames.map((frame) => frame.kind)).toContain("do.kv");

    const target = object("target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-exact",
        objectId,
        fence,
      });
      for (const frame of frames) await restore.applyFrame(frame);
      expect(await restore.applyFrame(frames[0]!)).toBe("replayed");
      await restore.finalize();

      const row = instance.testStorage.sql
        .exec<{
          maximum: string;
          minimum: string;
          realType: string;
          realValue: string;
          infiniteType: string;
          infiniteValue: number;
          negativeZeroType: string;
          textType: string;
          textBytes: string;
          blobType: string;
          blobBytes: string;
          nullType: string;
        }>(
          `SELECT CAST(maximum AS TEXT) AS maximum,
                  CAST(minimum AS TEXT) AS minimum,
                  typeof(real_value) AS realType,
                  printf('%!.17g', real_value) AS realValue,
                  typeof(infinite_value) AS infiniteType,
                  infinite_value AS infiniteValue,
                  typeof(negative_zero) AS negativeZeroType,
                  typeof(text_value) AS textType,
                  hex(CAST(text_value AS BLOB)) AS textBytes,
                  typeof(blob_value) AS blobType,
                  hex(blob_value) AS blobBytes,
                  typeof(nullable) AS nullType
           FROM exact_values`,
        )
        .toArray()[0]!;
      expect(row).toEqual({
        maximum: "9223372036854775807",
        minimum: "-9223372036854775808",
        realType: "real",
        realValue: "0.10000000000000001",
        infiniteType: "real",
        infiniteValue: Number.POSITIVE_INFINITY,
        negativeZeroType: "real",
        textType: "text",
        textBytes: "706F727461626C652074657874",
        blobType: "blob",
        blobBytes: "000102FEFF",
        nullType: "null",
      });
      const graph = instance.testStorage.kv.get<{
        integer: bigint;
        bytes: Uint8Array;
        map: Map<string, number>;
      }>("graph")!;
      expect(graph.integer).toBe(9_223_372_036_854_775_807n);
      expect([...graph.bytes]).toEqual([0, 1, 254, 255]);
      expect(graph.map.get("answer")).toBe(42);
      expect(await instance.testStorage.getAlarm()).toBe(1_900_000_000_000);
      expect(
        instance.testStorage.sql
          .exec<{ doubled: string }>(
            "SELECT CAST(doubled AS TEXT) AS doubled FROM generated_values",
          )
          .toArray()[0]?.doubled,
      ).toBe("14");
      expect(
        instance.testStorage.sql
          .exec<{ value: string }>("SELECT value FROM keyed_values ORDER BY group_name, position")
          .toArray()
          .map((value) => value.value),
      ).toEqual(["first", "second"]);
      expect(
        instance.testStorage.sql
          .exec<{ tableName: string }>(
            "SELECT tbl_name AS tableName FROM sqlite_schema WHERE name = 'exact_text_idx'",
          )
          .toArray()[0]?.tableName,
      ).toBe("exact_values");
      instance.testStorage.sql.exec("INSERT INTO sequencing DEFAULT VALUES");
      expect(
        instance.testStorage.sql
          .exec<{ id: string }>("SELECT CAST(MAX(id) AS TEXT) AS id FROM sequencing")
          .toArray()[0]?.id,
      ).toBe("101");
      await restore.finalize();
    });

    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const resumed = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-exact",
        objectId,
        fence,
      });
      await resumed.finalize();
    });
  });

  it("chunks projections for tables wider than the Workers SQL result-column limit", async () => {
    const stub = object("wide");
    const frames = await runInDurableObject(stub, async (instance: PortableDoFixture) => {
      const columns = Array.from({ length: 60 }, (_, index) => `c${index} INTEGER`).join(", ");
      const values = Array.from({ length: 60 }, (_, index) => index.toString()).join(", ");
      instance.testStorage.sql.exec(`CREATE TABLE wide (${columns})`);
      instance.testStorage.sql.exec(`INSERT INTO wide VALUES (${values})`);
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId: "wide-object",
        fence,
      })) output.push(frame);
      return output;
    });
    const rows = frames.find((frame) => frame.kind === "do.sqlite.rows")!;
    const body = parseCanonicalJson(rows.body) as { rows: Array<{ values: unknown[] }> };
    expect(body.rows[0]?.values).toHaveLength(60);
  });

  it("rejects unsafe or unsupported SQLite shapes", async () => {
    await expect(snapshotFailure("view", (storage) => {
      storage.sql.exec("CREATE TABLE source (value TEXT)");
      storage.sql.exec("CREATE VIEW unsafe_view AS SELECT value FROM source");
    })).resolves.toMatchObject({ code: "schema_object_not_portable" });

    await expect(snapshotFailure("rowid", (storage) => {
      storage.sql.exec("CREATE TABLE shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT, value TEXT)");
    })).resolves.toMatchObject({ code: "nondeterministic_table_order" });

    await expect(snapshotFailure("foreign-key", (storage) => {
      storage.sql.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
      storage.sql.exec("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
    })).resolves.toMatchObject({ code: "foreign_keys_not_portable" });

    await expect(snapshotFailure("utf8", (storage) => {
      storage.sql.exec("CREATE TABLE invalid_text (value TEXT)");
      storage.sql.exec("INSERT INTO invalid_text VALUES (CAST(X'C328' AS TEXT))");
    })).resolves.toMatchObject({ name: "PortableArchiveError" });

    await expect(snapshotFailure("fts", (storage) => {
      storage.sql.exec("CREATE VIRTUAL TABLE contentless USING fts5(value, content='')");
    })).resolves.toMatchObject({ code: "contentless_fts_not_portable" });
  });

  it("rejects non-empty targets and conflicting frame replays", async () => {
    const nonempty = object("nonempty");
    await runInDurableObject(nonempty, async (instance: PortableDoFixture) => {
      instance.testStorage.sql.exec("CREATE TABLE existing (id INTEGER)");
      await expect(beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-nonempty",
        objectId: "object",
        fence,
      })).rejects.toMatchObject({ code: "restore_target_not_empty" });
    });

    const source = object("conflict-source");
    const descriptor = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      const frames: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId: "conflict-object",
        fence,
      })) frames.push(frame);
      return frames[0]!;
    });
    const target = object("conflict-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-conflict",
        objectId: "conflict-object",
        fence,
      });
      await restore.applyFrame(descriptor);
      const parsed = parseCanonicalJson(descriptor.body) as Record<string, unknown>;
      const conflicting = {
        ...descriptor,
        body: canonicalJsonBytes({ ...parsed, alarm: { scheduledTime: "1" } }),
      };
      await expect(restore.applyFrame(conflicting)).rejects.toMatchObject({
        code: "restore_conflict",
      });
    });
  });

  it("restores into an exactly matching fresh-migrated schema without replacing managed identity", async () => {
    const objectId = "fresh-migrated-object";
    const source = object("fresh-source");
    const frames = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      createMigratedSchema(instance.testStorage, "TEXT");
      instance.testStorage.sql.exec("INSERT INTO managed_identity VALUES ('source-provider')");
      instance.testStorage.sql.exec("INSERT INTO application_data VALUES (1, 'portable')");
      instance.testStorage.kv.put("__gsv:managed:identity", "source-managed-kv");
      instance.testStorage.kv.put("__gsv:restore:stale-journal", "must-not-export");
      instance.testStorage.kv.put("user-setting", { enabled: true });
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId,
        fence,
        excludedSqlTables: ["managed_identity"],
      })) output.push(frame);
      return output;
    });

    const target = object("fresh-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      createMigratedSchema(instance.testStorage, "TEXT");
      instance.testStorage.sql.exec("INSERT INTO managed_identity VALUES ('target-provider')");
      instance.testStorage.kv.put("__gsv:managed:identity", "target-managed-kv");
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-fresh",
        objectId,
        fence,
        schemaMode: "fresh-migrated",
        preservedSqlTables: ["managed_identity"],
      });
      for (const frame of frames) await restore.applyFrame(frame);
      await restore.finalize();
      expect(
        instance.testStorage.sql
          .exec<{ providerId: string }>("SELECT provider_id AS providerId FROM managed_identity")
          .toArray()[0]?.providerId,
      ).toBe("target-provider");
      expect(
        instance.testStorage.sql
          .exec<{ value: string }>("SELECT value FROM application_data WHERE id = 1")
          .toArray()[0]?.value,
      ).toBe("portable");
      expect(instance.testStorage.kv.get("__gsv:managed:identity")).toBe("target-managed-kv");
      expect(instance.testStorage.kv.get("__gsv:restore:stale-journal")).toBeUndefined();
      expect(instance.testStorage.kv.get("user-setting")).toEqual({ enabled: true });
    });

    const mismatched = object("fresh-mismatch");
    await runInDurableObject(mismatched, async (instance: PortableDoFixture) => {
      createMigratedSchema(instance.testStorage, "INTEGER");
      instance.testStorage.sql.exec("INSERT INTO managed_identity VALUES ('target-provider')");
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-mismatch",
        objectId,
        fence,
        schemaMode: "fresh-migrated",
        preservedSqlTables: ["managed_identity"],
      });
      await restore.applyFrame(frames[0]!);
      await expect(restore.applyFrame(frames[1]!)).rejects.toMatchObject({
        code: "restore_conflict",
      });
    });
  });

  it("resumes a journaled restore after an incomplete finalize", async () => {
    const objectId = "resume-object";
    const source = object("resume-source");
    const frames = await runInDurableObject(source, async (instance: PortableDoFixture) => {
      instance.testStorage.sql.exec("CREATE TABLE resumable (id INTEGER PRIMARY KEY, value TEXT)");
      instance.testStorage.sql.exec("INSERT INTO resumable VALUES (1, 'one'), (2, 'two')");
      instance.testStorage.kv.put("resumable-kv", 2n);
      const output: LogicalDoSnapshotFrame[] = [];
      for await (const frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId,
        fence,
        sqlQueryRows: 1,
      })) output.push(frame);
      return output;
    });

    const target = object("resume-target");
    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-resume",
        objectId,
        fence,
      });
      await restore.applyFrame(frames[0]!);
      await restore.applyFrame(frames[1]!);
      await expect(restore.finalize()).rejects.toMatchObject({ code: "restore_incomplete" });
    });

    await runInDurableObject(target, async (instance: PortableDoFixture) => {
      const restore = await beginLogicalDurableObjectRestore(instance.testStorage, {
        restoreId: "restore-resume",
        objectId,
        fence,
      });
      expect(await restore.applyFrame(frames[0]!)).toBe("replayed");
      expect(await restore.applyFrame(frames[1]!)).toBe("replayed");
      for (const frame of frames.slice(2)) await restore.applyFrame(frame);
      await restore.finalize();
      expect(
        instance.testStorage.sql
          .exec<{ count: string }>("SELECT CAST(COUNT(*) AS TEXT) AS count FROM resumable")
          .toArray()[0]?.count,
      ).toBe("2");
      expect(instance.testStorage.kv.get("resumable-kv")).toBe(2n);
    });
  });
});

function object(name: string): DurableObjectStub<PortableDoFixture> {
  return env.TEST_OBJECTS.getByName(`${name}-${crypto.randomUUID()}`);
}

async function snapshotFailure(
  name: string,
  seed: (storage: DurableObjectStorage) => void,
): Promise<unknown> {
  const stub = object(name);
  return runInDurableObject(stub, async (instance: PortableDoFixture) => {
    seed(instance.testStorage);
    try {
      for await (const _frame of snapshotLogicalDurableObject(instance.testStorage, {
        objectId: `${name}-object`,
        fence,
      })) {
        // Consume the complete generator so row-level validation runs.
      }
      throw new Error("snapshot unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return {
        name: (error as Error).name,
        code: error instanceof NonPortableDoError ? error.code : (error as { code?: string }).code,
      };
    }
  });
}

function createMigratedSchema(storage: DurableObjectStorage, valueType: "TEXT" | "INTEGER"): void {
  storage.sql.exec("CREATE TABLE managed_identity (provider_id TEXT NOT NULL)");
  storage.sql.exec("CREATE UNIQUE INDEX managed_provider_idx ON managed_identity(provider_id)");
  storage.sql.exec(`CREATE TABLE application_data (id INTEGER PRIMARY KEY, value ${valueType} NOT NULL)`);
  storage.sql.exec("CREATE INDEX application_value_idx ON application_data(value)");
}

async function transcriptForFrames(
  objectId: string,
  frames: readonly LogicalDoSnapshotFrame[],
): Promise<Readonly<{
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
}>> {
  const semantic = await ObjectSemanticDigestV1.create(objectId);
  let bodyBytes = 0n;
  for (const frame of frames) {
    await semantic.append(frame);
    bodyBytes += BigInt(frame.body.byteLength);
  }
  return {
    frameCount: frames.length.toString(),
    bodyBytes: bodyBytes.toString(),
    semanticSha256: semantic.digestBase64Url(),
  };
}

function differentDigest(digest: string): string {
  return `${digest[0] === "A" ? "B" : "A"}${digest.slice(1)}`;
}

function trackStream(source: ReadableStream<Uint8Array>): Readonly<{
  stream: ReadableStream<Uint8Array>;
  pulls: number;
  cancellations: number;
}> {
  const reader = source.getReader();
  const state = {
    pulls: 0,
    cancellations: 0,
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        state.pulls += 1;
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        state.cancellations += 1;
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    get pulls() {
      return state.pulls;
    },
    get cancellations() {
      return state.cancellations;
    },
  };
}
