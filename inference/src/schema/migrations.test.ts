import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INFERENCE_MIGRATIONS } from "./migrations";

describe("managed inference schema migrations", () => {
  it("starts from a versioned SQLite baseline", () => {
    expect(INFERENCE_MIGRATIONS).toHaveLength(3);
    expect(INFERENCE_MIGRATIONS[0]).toMatchObject({
      id: 1,
      name: "initial_inference_schema",
    });
    expect(INFERENCE_MIGRATIONS[1]).toMatchObject({
      id: 2,
      name: "mail_intake_replay_results",
    });
    expect(INFERENCE_MIGRATIONS[2]).toMatchObject({
      id: 3,
      name: "inference_cancellation_tombstones",
    });
  });

  it("applies the cancellation tombstone table and expiry index", async () => {
    const stub = env.INFERENCE_INSTALLATIONS.getByName(
      "installation_cancellation_migration",
    );
    const schema = await runInDurableObject(stub, (_instance, state) => ({
      columns: state.storage.sql.exec<{ name: string; type: string; pk: number }>(
        "PRAGMA table_info(inference_cancellations)",
      ).toArray().map(({ name, type, pk }) => ({ name, type, pk })),
      indexes: state.storage.sql.exec<{ name: string }>(
        "PRAGMA index_list(inference_cancellations)",
      ).toArray().map((index) => index.name),
    }));

    expect(schema.columns).toEqual([
      { name: "logical_request_id", type: "TEXT", pk: 1 },
      { name: "expires_at", type: "INTEGER", pk: 0 },
    ]);
    expect(schema.indexes).toContain("inference_cancellations_expiry_idx");
  });
});
