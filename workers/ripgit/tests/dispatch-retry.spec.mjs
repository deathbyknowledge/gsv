import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("repository read dispatch retries", () => {
  let miniflare;
  beforeAll(() => {
    miniflare = new Miniflare({
      modules: true, modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] },
        { type: "ESModule", include: ["**/*.js"] }],
      scriptPath: "tests/fixtures/dispatch-retry-worker.mjs", modulesRoot: ".",
      compatibilityDate: "2026-03-18",
    });
  });
  afterAll(async () => { await miniflare.dispose(); });

  async function dispatch(scenario, method = "GET", path = "/hyperspace/repos/alice/home/refs") {
    const response = await miniflare.dispatchFetch(`https://ripgit${path}`, {
      method: "POST", headers: { "x-gsv-installation-id": "inst_fixture", "x-fixture-scenario": JSON.stringify(scenario),
        "x-fixture-method": method },
      ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: "fixture body" } : {}),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it.each(["GET", "HEAD"])("retries %s through fresh stubs with bounded backoff", async (method) => {
    const result = await dispatch({ failures: 2, retryable: true, message: "Network connection lost." }, method);
    expect(result.outcome).toEqual({ status: 200, body: method === "HEAD" ? "" : "fixture success" });
    expect(result.stubs).toBe(3);
    expect(result.registrations).toBe(1);
    expect(result.attempts.map(({ stub }) => stub)).toEqual([1, 2, 3]);
    for (const attempt of result.attempts) {
      expect(attempt).toMatchObject({ method, name: "inst_fixture/alice/home", path: "/alice/home/hyperspace/refs",
        installation: "inst_fixture", body: "" });
    }
    expect(result.attempts[1].at - result.attempts[0].at).toBeGreaterThanOrEqual(100);
    expect(result.attempts[2].at - result.attempts[1].at).toBeGreaterThanOrEqual(200);
  });

  it("does not retry a successful initial read", async () => {
    const result = await dispatch({ failures: 0 });
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome).toEqual({ status: 200, body: "fixture success" });
  });

  it("handles the platform reference signature without flags on the public path", async () => {
    const result = await dispatch({ failures: 1 }, "GET", "/alice/home/refs");
    expect(result.outcome.status).toBe(200);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].path).toBe("/alice/home/refs");
  });

  it("retains the platform diagnostic after exhausting three attempts", async () => {
    const result = await dispatch({ failures: 10 });
    expect(result.attempts).toHaveLength(3);
    expect(result.outcome).toEqual({ status: 500, body: "INTERNAL SERVER ERROR" });
    expect(result.diagnostics.join("\n")).toContain("internal error; reference = fixture123");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not replay %s writes", async (method) => {
    const result = await dispatch({ failures: 10, retryable: true }, method, "/hyperspace/repos/alice/home/apply");
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome.status).toBe(500);
    expect(result.diagnostics.join("\n")).toContain("fixture123");
    if (method !== "DELETE") expect(result.attempts[0].body).toBe("fixture body");
  });

  it.each([
    { overloaded: true, retryable: true },
    { overloaded: true },
    { retryable: false },
    { remote: true, retryable: true },
    { message: "application validation failed" },
    { message: "INTERNAL SERVER ERROR" },
    { message: "internal error; reference = fixture123 trailing application text" },
  ])("does not retry overloads, application errors or unclassified failures: %j", async (failure) => {
    const result = await dispatch({ failures: 10, ...failure });
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome.status).toBe(500);
    expect(result.diagnostics.join("\n")).toContain(failure.message ?? "fixture123");
  });

  it("returns HTTP failures without retrying or replacing their diagnostic body", async () => {
    const result = await dispatch({ failures: 10, httpStatus: 503 });
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome).toEqual({ status: 503, body: "upstream response" });
  });
});
