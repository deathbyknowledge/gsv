import { z } from "zod";
import { operatorResourceCaptureSchema, operatorResourceCatalogSchema, operatorResourceSelector,
  type OperatorResource, type OperatorResourceCapture } from "../../workers/installations/src/operator-resource-contracts.ts";
import type { DeletionCaptureArtifacts } from "./installation-deletion-capture.ts";

export const aiGatewayLogCaptureConfigurationSchema = z.strictObject({
  version: z.literal(1), accountId: z.string().regex(/^[a-f0-9]{32}$/),
  gatewayId: z.string().regex(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/).max(64),
  installationId: z.string().min(1).max(128), resourceId: z.string(), catalog: operatorResourceCatalogSchema,
});
export type AiGatewayLogCaptureConfiguration = z.infer<typeof aiGatewayLogCaptureConfigurationSchema>;
const pageSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    created_at: z.iso.datetime({ offset: true }), metadata: z.string().max(16_384) })).max(50),
  result_info: z.object({ page: z.number().int().positive(), count: z.number().int().nonnegative(),
    per_page: z.literal(50).optional(), total_count: z.number().int().nonnegative() }),
});
const metadataSchema = z.object({ "gsv.installation_id": z.string() });
type EnumerationFacts = Extract<OperatorResourceCapture["facts"], { kind: "enumeration" }>;
export type AiGatewayLogCaptureReport = {
  version: 1; scope: "ai-gateway-tagged-requests"; outcome: "captured";
  accountId: string; gatewayId: string; installationId: string; catalogResource: OperatorResource;
  resourceSelector: string;
  queryFilters: { key: "metadata.key" | "metadata.value"; operator: "eq"; value: string[] }[];
  startedAt: number; capturedAt: number; taggedRecordCount: number; pageReferences: string[]; facts: EnumerationFacts;
  coverage: { query: "exact-installation-tag-only"; historicalUntaggedRecords: "unknown"; upstreamProviderCopies: "unknown"; indexingCompletion: "unknown" };
  submission: null; limitation: string;
};

/** A tagged projection can never attest absence of older, untagged records. */
export async function captureAiGatewayTaggedLogs(input: {
  configuration: AiGatewayLogCaptureConfiguration; cloudflareToken: string;
  artifacts: DeletionCaptureArtifacts; fetch?: typeof fetch; clock?: () => number;
}): Promise<AiGatewayLogCaptureReport> {
  const config = aiGatewayLogCaptureConfigurationSchema.parse(input.configuration);
  const resource = config.catalog.find((entry) => entry.id === config.resourceId);
  if (!resource || resource.source !== "ai-gateway" || resource.namespace !== config.gatewayId || resource.scope !== "installation") {
    throw new Error("AI Gateway capture requires an exact installation-scoped catalog resource");
  }
  if (!input.cloudflareToken.trim()) throw new Error("AI Gateway capture requires operator API authentication");
  const filters: AiGatewayLogCaptureReport["queryFilters"] = [
    { key: "metadata.key", operator: "eq", value: ["gsv.installation_id"] },
    { key: "metadata.value", operator: "eq", value: [config.installationId] },
  ];
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const facts: EnumerationFacts = { kind: "enumeration", pages: [] };
  const pageReferences: string[] = [];
  const ids = new Set<string>();
  let totalCount: number | undefined;
  for (let page = 1; page <= 64; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai-gateway/gateways/${config.gatewayId}/logs`);
    url.searchParams.set("filters", JSON.stringify(filters));
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    url.searchParams.set("order_by", "created_at");
    url.searchParams.set("order_by_direction", "asc");
    let response: Response;
    try {
      response = await (input.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${input.cloudflareToken}` } });
    } catch { throw new Error("AI Gateway metadata enumeration request failed"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`AI Gateway metadata enumeration returned HTTP ${response.status}`);
    }
    const result = await readMetadataPage(response);
    totalCount ??= result.result_info.total_count;
    const expectedCount = Math.min(50, Math.max(0, totalCount - (page - 1) * 50));
    if (totalCount > 3200 || result.result_info.total_count !== totalCount || result.result_info.page !== page
      || result.result_info.count !== result.result.length || result.result.length !== expectedCount) {
      throw new Error("AI Gateway pagination changed, is incomplete, or exceeds the capture limit; start a fresh capture");
    }
    const records = result.result.map((entry) => {
      let metadata;
      try { metadata = metadataSchema.safeParse(JSON.parse(entry.metadata)); }
      catch { throw new Error("AI Gateway record metadata is invalid"); }
      if (!metadata.success || metadata.data["gsv.installation_id"] !== config.installationId || ids.has(entry.id)) {
        throw new Error("AI Gateway record has another installation, lacks its exact tag, or repeats an ID");
      }
      ids.add(entry.id);
      return { id: entry.id, createdAt: entry.created_at, installationId: config.installationId };
    });
    const nextCursor = ids.size === totalCount ? null : String(page + 1);
    const reference = `ai-gateway-page-${page}.json`;
    // Hash and persist only this allowlisted projection, never provider bodies or arbitrary metadata.
    const body = JSON.stringify({ version: 1, accountId: config.accountId, gatewayId: config.gatewayId,
      installationId: config.installationId, observedAt: clock(), page, perPage: 50, totalCount, records });
    const responseSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await input.artifacts.write(reference, body);
    pageReferences.push(reference);
    facts.pages.push({ requestedCursor: page === 1 ? null : String(page), nextCursor, itemCount: records.length, responseSha256 });
    if (nextCursor === null) break;
  }
  if (facts.pages.at(-1)?.nextCursor !== null) throw new Error("AI Gateway enumeration did not reach its terminal page");
  operatorResourceCaptureSchema.pick({ facts: true }).parse({ facts });
  const report: AiGatewayLogCaptureReport = {
    version: 1, scope: "ai-gateway-tagged-requests", outcome: "captured", accountId: config.accountId,
    gatewayId: config.gatewayId, installationId: config.installationId, catalogResource: resource,
    resourceSelector: operatorResourceSelector(resource, config.installationId), queryFilters: filters,
    startedAt, capturedAt: clock(), taggedRecordCount: ids.size, pageReferences,
    facts,
    coverage: { query: "exact-installation-tag-only", historicalUntaggedRecords: "unknown", upstreamProviderCopies: "unknown", indexingCompletion: "unknown" },
    submission: null,
    limitation: "This query projection is not full catalog-scope erasure evidence, even when empty. Do not submit these facts as a full-scope attestation.",
  };
  await input.artifacts.write("ai-gateway-capture-report.json", JSON.stringify(report));
  return report;
}

async function readMetadataPage(response: Response): Promise<z.infer<typeof pageSchema>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("AI Gateway metadata response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) throw new Error("AI Gateway metadata page exceeds the capture limit");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return pageSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("AI Gateway metadata response is invalid or oversized");
  } finally { reader.releaseLock(); }
}
