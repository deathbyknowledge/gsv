import { describe, expect, it, vi } from "vitest";
import { cloudflareMigrationD1 } from "../src/installation-migration-d1.ts";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", apiToken: "fixture-token" };

describe("Cloudflare D1 migration transport", () => {
  it("uses one authenticated REST batch and retains exact result ordering", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: [
      { success: true, results: [{ n: 1 }] }, { success: true, results: [{ n: 2 }] },
    ] }));
    const db = cloudflareMigrationD1({ ...identity, fetch: request });
    expect(await db.batch([{ sql: "SELECT ? AS n", params: ["1"] }, { sql: "SELECT 2 AS n" }])).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    expect(db.identity).toEqual({ accountId: identity.accountId, databaseId: identity.databaseId });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${identity.databaseId}/query`);
    expect(init?.headers).toEqual({ Authorization: "Bearer fixture-token", "Content-Type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ batch: [{ sql: "SELECT ? AS n", params: ["1"] }, { sql: "SELECT 2 AS n" }] }));
  });

  it.each(["network", "http", "query", "shape"])("returns a content-free reconciliation error on %s failure", async (failure) => {
    const request = vi.fn<typeof fetch>();
    if (failure === "network") request.mockRejectedValue(new Error("fixture-token private SQL and values"));
    if (failure === "http") request.mockResolvedValue(new Response("private error body", { status: 403 }));
    if (failure === "query") request.mockResolvedValue(Response.json({ success: false, errors: [{ message: "private SQL and values" }] }));
    if (failure === "shape") request.mockResolvedValue(Response.json({ success: true, result: [{ success: true, results: [{ n: { secret: "private" } }] }] }));
    const db = cloudflareMigrationD1({ ...identity, fetch: request });
    await expect(db.batch([{ sql: "SELECT private", params: ["secret-value"] }])).rejects.toThrow(/reconcile/);
    await expect(db.batch([{ sql: "SELECT private" }])).rejects.not.toThrow(/fixture-token|private|secret-value/);
  });

  it("rejects missing results and malformed identity without retrying mutations", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: [] }));
    await expect(cloudflareMigrationD1({ ...identity, fetch: request }).batch([{ sql: "SELECT 1" }])).rejects.toThrow(/result count/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => cloudflareMigrationD1({ ...identity, accountId: "wrong" })).toThrow(/explicit Cloudflare/);
  });
});
