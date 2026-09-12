import { z } from "zod";
import type { InstallationDeletionManifest } from "./deletion-inventory.ts";

export const OPERATOR_RESOURCE_OWNER = "operator-resources";
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const source = z.enum(["cloudflare-r2-multipart", "cloudflare-queue", "cloudflare-workers-logs", "posthog", "ai-gateway", "provider", "backup", "cache"]);
export const operatorResourceCatalogSchema = z.array(z.strictObject({
  id, kind: z.enum(["r2", "queue", "logs", "provider", "backup", "cache"]),
  namespace: z.string().min(1).max(500), source,
  scope: z.enum(["installation", "deployment"]), disposition: z.enum(["live", "retained"]),
})).min(1).max(128).superRefine((catalog, ctx) => {
  if (new Set(catalog.map((entry) => entry.id)).size !== catalog.length) ctx.addIssue({ code: "custom", message: "Catalog resource IDs must be unique" });
  if (new Set(catalog.map((entry) => JSON.stringify([entry.kind, entry.namespace]))).size !== catalog.length) ctx.addIssue({ code: "custom", message: "Catalog physical scopes must be unique" });
  for (const entry of catalog) {
    if (["r2", "queue"].includes(entry.kind) && entry.disposition !== "live") ctx.addIssue({ code: "custom", message: "Multipart and queue payloads require live cleanup" });
    const expected = { "cloudflare-r2-multipart": "r2", "cloudflare-queue": "queue", "cloudflare-workers-logs": "logs", posthog: "logs", "ai-gateway": "provider", provider: "provider", backup: "backup", cache: "cache" }[entry.source];
    if (expected !== entry.kind) ctx.addIssue({ code: "custom", message: "Catalog source and resource kind do not match" });
  }
});
export type OperatorResourceCatalog = z.infer<typeof operatorResourceCatalogSchema>;
export type OperatorResource = OperatorResourceCatalog[number];

const cursor = z.string().min(1).max(2000).nullable();
const facts = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("enumeration"), pages: z.array(z.strictObject({
    requestedCursor: cursor, nextCursor: cursor, itemCount: z.number().int().nonnegative(),
    responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(64) }),
  z.strictObject({ kind: z.literal("retention-policy"), enforced: z.boolean(),
    retentionMs: z.number().int().positive().max(100 * 366 * 86400000).nullable(),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const operatorResourceCaptureSchema = z.strictObject({
  version: z.literal(1), installationId: z.string().min(1).max(128), operationId: z.string().min(1).max(128),
  resourceId: id, namespace: z.string().min(1).max(500), source, selector: z.string().min(1).max(500),
  capturedAt: z.number().int().positive(), reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,999}$/), facts,
});
export const operatorResourceAttestationSchema = z.strictObject({
  capture: operatorResourceCaptureSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OperatorResourceCapture = z.infer<typeof operatorResourceCaptureSchema>;
export type OperatorResourceAttestation = z.infer<typeof operatorResourceAttestationSchema>;

export function operatorResourceSelector(resource: OperatorResource, installationId: string): string {
  return resource.scope === "deployment" ? "*" : resource.kind === "r2" ? `installations/${encodeURIComponent(installationId)}/` : installationId;
}
export function operatorResourceManifestResources(catalog: OperatorResourceCatalog, installationId: string): InstallationDeletionManifest["owners"][number]["resources"] {
  return catalog.map(({ kind, namespace }) => ({ kind, namespace,
    resourceId: kind === "r2" ? `installations/${encodeURIComponent(installationId)}/` : installationId }));
}
export async function operatorResourceDigest(value: OperatorResourceCapture | OperatorResourceCatalog): Promise<string> {
  const canonical = Array.isArray(value) ? operatorResourceCatalogSchema.parse(value).sort((left, right) => left.id.localeCompare(right.id)) : operatorResourceCaptureSchema.parse(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A terminal empty page does not erase entries found on earlier pages. */
export function enumerationIsEmpty(capture: OperatorResourceCapture): boolean {
  if (capture.facts.kind !== "enumeration") return false;
  let expected: string | null = null;
  const seen = new Set<string>();
  for (const [index, page] of capture.facts.pages.entries()) {
    if (page.requestedCursor !== expected || (index && expected === null)
      || (page.nextCursor !== null && seen.has(page.nextCursor))) throw new Error("installation operator evidence pagination is invalid");
    if (page.nextCursor) seen.add(page.nextCursor);
    expected = page.nextCursor;
  }
  return expected === null && capture.facts.pages.every((page) => page.itemCount === 0);
}
