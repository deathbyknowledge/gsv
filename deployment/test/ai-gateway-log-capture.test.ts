import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { captureAiGatewayTaggedLogs, type AiGatewayLogCaptureConfiguration } from "../src/ai-gateway-log-capture.ts";
import { operatorResourceAttestationSchema, operatorResourceCaptureSchema } from "../../workers/installations/src/operator-resource-contracts.ts";

const configuration: AiGatewayLogCaptureConfiguration = {
  version: 1, accountId: "a".repeat(32), gatewayId: "default", installationId: "owned-space", resourceId: "gateway-logs",
  catalog: [{ id: "gateway-logs", namespace: "default", kind: "provider", source: "ai-gateway", scope: "installation", disposition: "retained" }],
};
function rows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({ id: `log_${index + offset}`, created_at: "2026-09-12T00:00:00Z",
    metadata: JSON.stringify({ "gsv.installation_id": "owned-space", "unrelated": "private metadata that must not be saved" }),
    request: { prompt: "unexpected private body" }, response: "unexpected private response",
  }));
}
function page(number: number, total: number, result = rows(Math.min(50, Math.max(0, total - (number - 1) * 50)), (number - 1) * 50)) {
  return { success: true, result, result_info: { page: number, per_page: 50, count: result.length, total_count: total } };
}
function fixture(responses: Response[]) {
  const files = new Map<string, string>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-test-token");
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  let now = 1000;
  const run = (config = configuration) => captureAiGatewayTaggedLogs({ configuration: config, cloudflareToken: "private-test-token", fetch,
    clock: () => ++now, artifacts: { read: async (reference) => files.get(reference) ?? null,
      write: async (reference, body) => { files.set(reference, body); } },
  });
  return { files, fetch, run };
}

describe("operator AI Gateway metadata capture", () => {
  it("loads the actual Node entrypoint and rejects missing configuration without network access", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/capture-ai-gateway-logs.ts", import.meta.url))], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("AI Gateway metadata capture did not complete.");
    expect(result.stderr).not.toContain("ERR_MODULE");
  });

  it("captures complete scoped pages with accepted facts while withholding a full-scope attestation", async () => {
    const f = fixture([Response.json(page(1, 51)), Response.json(page(2, 51))]);
    const result = await f.run();
    expect(result.taggedRecordCount).toBe(51);
    expect(result.facts).toEqual({ kind: "enumeration", pages: [
      { requestedCursor: null, nextCursor: "2", itemCount: 50, responseSha256: expect.any(String) },
      { requestedCursor: "2", nextCursor: null, itemCount: 1, responseSha256: expect.any(String) },
    ] });
    expect(operatorResourceCaptureSchema.pick({ facts: true }).safeParse({ facts: result.facts }).success).toBe(true);
    expect(operatorResourceAttestationSchema.safeParse(result).success).toBe(false);
    expect(result.submission).toBeNull();
    expect(result.coverage.historicalUntaggedRecords).toBe("unknown");
    expect(result.resourceSelector).toBe("owned-space");
    for (const [index, call] of f.fetch.mock.calls.entries()) {
      const url = new URL(String(call[0]));
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(url.pathname).toBe(`/client/v4/accounts/${configuration.accountId}/ai-gateway/gateways/default/logs`);
      expect(url.searchParams.get("page")).toBe(String(index + 1));
      expect(url.searchParams.get("per_page")).toBe("50");
      expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
        { key: "metadata.key", operator: "eq", value: ["gsv.installation_id"] },
        { key: "metadata.value", operator: "eq", value: ["owned-space"] },
      ]);
      expect(result.facts.pages[index]!.responseSha256).toBe(createHash("sha256").update(f.files.get(result.pageReferences[index]!)!).digest("hex"));
    }
    const saved = [...f.files.values()].join("");
    expect(saved).not.toContain("private");
    expect(saved).not.toContain("unexpected");
    expect(JSON.parse(f.files.get("ai-gateway-page-2.json")!).records).toEqual([
      { id: "log_50", createdAt: "2026-09-12T00:00:00Z", installationId: "owned-space" },
    ]);
  });

  it("reports an empty tagged projection without clearing historical or upstream copies", async () => {
    const f = fixture([Response.json(page(1, 0))]);
    const result = await f.run();
    expect(result.facts.pages).toEqual([{ requestedCursor: null, nextCursor: null, itemCount: 0, responseSha256: expect.any(String) }]);
    expect(result.coverage).toEqual({ query: "exact-installation-tag-only", historicalUntaggedRecords: "unknown", upstreamProviderCopies: "unknown", indexingCompletion: "unknown" });
    expect(result.submission).toBeNull();
    expect(result.limitation).toContain("not full catalog-scope erasure evidence");
  });

  it.each([
    ["missing final records", page(2, 51, [])],
    ["changed total count", page(2, 50, [])],
    ["repeated page number", page(1, 51)],
    ["duplicate log ID", page(2, 51, rows(1, 0))],
  ])("rejects %s without emitting a completed report", async (_label, lastPage) => {
    const f = fixture([Response.json(page(1, 51)), Response.json(lastPage)]);
    await expect(f.run()).rejects.toThrow();
    expect(f.files.has("ai-gateway-capture-report.json")).toBe(false);
  });

  it.each([
    JSON.stringify({ "gsv.installation_id": "another-space", "another.key": "owned-space" }),
    JSON.stringify({ "another.key": "owned-space" }),
    "not-json-private-content",
  ])("rejects absent, wrong or invalid exact ownership tags", async (metadata) => {
    const entries = rows(1);
    entries[0]!.metadata = metadata;
    const f = fixture([Response.json(page(1, 1, entries))]);
    await expect(f.run()).rejects.toThrow(/metadata|another installation/);
    expect(f.files.size).toBe(0);
  });

  it("rejects oversized scopes before treating a limited enumeration as complete", async () => {
    const f = fixture([Response.json(page(1, 3201))]);
    await expect(f.run()).rejects.toThrow("capture limit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.files.size).toBe(0);
  });

  it("rejects invalid pagination counts and mismatched catalog scope", async () => {
    const invalid = page(1, 1);
    invalid.result_info.count = 0;
    const f = fixture([Response.json(invalid)]);
    await expect(f.run()).rejects.toThrow("pagination");
    await expect(f.run({ ...configuration, gatewayId: "other-gateway" })).rejects.toThrow("exact installation-scoped catalog resource");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels oversized and unsuccessful bodies without retaining their contents", async () => {
    for (const status of [200, 403]) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel }), { status });
      const f = fixture([response]);
      await expect(f.run()).rejects.toThrow(status === 200 ? "invalid or oversized" : "HTTP 403");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.files.size).toBe(0);
    }
  });

  it("sanitizes malformed response and transport failures", async () => {
    const malformed = fixture([new Response("private malformed response")]);
    await expect(malformed.run()).rejects.toThrow("AI Gateway metadata response is invalid or oversized");
    const failed = fixture([]);
    failed.fetch.mockRejectedValue(new Error("private credential-bearing transport message"));
    await expect(failed.run()).rejects.toThrow("AI Gateway metadata enumeration request failed");
    expect(failed.files.size).toBe(0);
  });
});
