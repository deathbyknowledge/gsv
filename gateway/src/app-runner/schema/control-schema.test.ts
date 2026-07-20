import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AppRunner } from "../../app-runner";
import { buildAppDataRunnerName } from "../../app-runner";
import {
  buildAppRunnerName,
  isAppRunnerControlName,
} from "../../protocol/app-session";
import {
  appRunnerControlSchemaIsCurrent,
  initializeAppRunnerControlSchema,
} from "./control-schema";

function runnerStub(name: string) {
  const namespace = (env as unknown as {
    APP_RUNNER: DurableObjectNamespace<AppRunner>;
  }).APP_RUNNER;
  return namespace.get(namespace.idFromName(name));
}

function userSchemaNames(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(
    `SELECT name
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
       AND name != '__cf_kv'
     ORDER BY name`,
  ).toArray().map((row) => row.name);
}

describe("AppRunner v2 control schema gate", () => {
  it("attests a newly initialized v2 control database", async () => {
    const name = buildAppRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`);
    const stub = runnerStub(name);

    await runInDurableObject(stub, (_instance: AppRunner, state) => {
      expect(isAppRunnerControlName(state.id.name)).toBe(true);
      expect(appRunnerControlSchemaIsCurrent(state.storage.sql)).toBe(true);
      expect(userSchemaNames(state.storage.sql)).toEqual([
        "_gsv_schema_migrations",
        "app_rpc_schedules",
        "idx_app_rpc_schedules_authority",
        "idx_app_rpc_schedules_due",
      ]);
    });
  });

  it("leaves unknown package tables untouched and gates package storage", async () => {
    const stub = runnerStub(buildAppRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`));

    await runInDurableObject(stub, async (instance: AppRunner, state) => {
      state.storage.sql.exec(
        "CREATE TABLE legacy_package_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO legacy_package_notes (id, body) VALUES (1, 'preserve me')",
      );

      expect(initializeAppRunnerControlSchema(state.storage)).toBe(false);
      expect(appRunnerControlSchemaIsCurrent(state.storage.sql)).toBe(false);
      await expect(instance.packageSqlExec(1, {} as never, "SELECT 1"))
        .rejects.toThrow("Package storage migration required");
      expect(state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM legacy_package_notes WHERE id = 1",
      ).toArray()).toEqual([{ body: "preserve me" }]);
    });
  });

  it("catches a forged v2 ledger when the physical v2 schema is absent", async () => {
    const stub = runnerStub(buildAppRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`));

    await runInDurableObject(stub, async (instance: AppRunner, state) => {
      state.storage.sql.exec(
        "ALTER TABLE app_rpc_schedules DROP COLUMN runtime_authority_json",
      );
      expect(state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM _gsv_schema_migrations ORDER BY id",
      ).toArray()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(appRunnerControlSchemaIsCurrent(state.storage.sql)).toBe(false);
      await expect(instance.packageSqlExec(1, {} as never, "SELECT 1"))
        .rejects.toThrow("Package storage migration required");
    });
  });
});

describe("AppRunner object roles", () => {
  it("keeps persisted runner fences outside package-reachable SQL", async () => {
    const stub = runnerStub(buildAppDataRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_instance: AppRunner, state) => {
      state.storage.kv.put("fence-probe", { value: "secret" });
      expect(() => state.storage.sql.exec("SELECT * FROM __cf_kv").toArray())
        .toThrow("no such table: __cf_kv");
      expect(state.storage.kv.get("fence-probe")).toEqual({ value: "secret" });
    });
  });

  it("never initializes or accepts the legacy app: control namespace", async () => {
    const stub = runnerStub(`app:1000:pkg-${crypto.randomUUID()}`);

    await runInDurableObject(stub, async (instance: AppRunner, state) => {
      expect(userSchemaNames(state.storage.sql)).toEqual([]);
      const response = await instance.fetch(new Request("https://gsv.test/"));
      expect(response.status).toBe(404);
      expect(userSchemaNames(state.storage.sql)).toEqual([]);
    });
  });

  it("keeps app-data objects SQL-only", async () => {
    const stub = runnerStub(buildAppDataRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`));

    await runInDurableObject(stub, async (instance: AppRunner, state) => {
      expect(userSchemaNames(state.storage.sql)).toEqual([]);
      expect((await instance.fetch(new Request("https://gsv.test/"))).status).toBe(404);
      await expect(instance.runCommand({} as never))
        .rejects.toThrow("AppRunner control migration required");
      await expect(instance.packageSqlExec(1, {} as never, "SELECT 1"))
        .rejects.toThrow("Package storage migration required");

      const close = vi.fn();
      await instance.webSocketMessage({ close } as unknown as WebSocket, "{}");
      expect(close).toHaveBeenCalledWith(1008, "AppRunner role does not accept sockets");
      expect(userSchemaNames(state.storage.sql)).toEqual([]);
    });
  });

  it("rejects isolated package SQL on control objects before parsing authority", async () => {
    const stub = runnerStub(buildAppRunnerName(1000, 1000, `pkg-${crypto.randomUUID()}`));

    await runInDurableObject(stub, async (instance: AppRunner) => {
      await expect(instance.packageSqlExecIsolated(
        "app-data-v2:1000:1000:pkg-chat",
        {} as never,
        "SELECT 1",
      )).rejects.toThrow("Package SQL is isolated from the AppRunner control database");
    });
  });
});
