import { AwsClient } from "aws4fetch";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { operatorResourceCaptureSchema, operatorResourceCatalogSchema, operatorResourceSelector,
  type OperatorResource, type OperatorResourceCapture } from "../../workers/installations/src/operator-resource-contracts.ts";
import type { DeletionCaptureArtifacts } from "./installation-deletion-capture.ts";

export const r2MultipartCaptureConfigurationSchema = z.strictObject({
  version: z.literal(1), accountId: z.string().regex(/^[a-f0-9]{32}$/),
  installationId: z.string().min(1).max(128), resourceId: z.string(), catalog: operatorResourceCatalogSchema,
});
export type R2MultipartCaptureConfiguration = z.infer<typeof r2MultipartCaptureConfigurationSchema>;
export const r2MultipartAbortAuthorizationSchema = z.strictObject({
  installationId: z.string().min(1).max(128), operationId: z.string().min(1).max(128),
  applicationErasedAt: z.number().int().positive(),
});
export type R2MultipartAbortAuthorization = z.infer<typeof r2MultipartAbortAuthorizationSchema>;
type EnumerationFacts = Extract<OperatorResourceCapture["facts"], { kind: "enumeration" }>;
type Upload = { key: string; uploadId: string };
type Marker = { key: string; uploadId: string };
type Snapshot = { capturedAt: number; uploadCount: number; pageReferences: string[]; facts: EnumerationFacts };
export type R2MultipartCaptureReport = {
  version: 1; scope: "r2-multipart-prefix"; outcome: "captured";
  accountId: string; installationId: string; catalogResource: OperatorResource; resourceSelector: string;
  startedAt: number; capturedAt: number; observedUploads: number; abortedUploads: number; alreadyAbsentUploads: number;
  remainingUploads: number; pageReferences: string[]; facts: EnumerationFacts; before: Snapshot;
  authorization: R2MultipartAbortAuthorization | null;
  coverage: { prefix: "exact-installation"; historicalUnscopedUploads: "unknown" };
  submission: null;
};

const pageSchema = z.strictObject({ ListMultipartUploadsResult: z.strictObject({
  "#text": z.string().regex(/^\s*$/).optional(),
  Bucket: z.string(), Prefix: z.string(), EncodingType: z.literal("url"), MaxUploads: z.literal("1000"),
  KeyMarker: z.string().default(""), UploadIdMarker: z.string().default(""),
  NextKeyMarker: z.string().default(""), NextUploadIdMarker: z.string().default(""),
  IsTruncated: z.enum(["true", "false"]), Delimiter: z.literal("").optional(),
  Upload: z.array(z.object({ Key: z.string().min(1).max(4096), UploadId: z.string().min(1).max(2048) })).max(1000).default([]),
}) });
const xmlParser = new XMLParser({ parseTagValue: false, trimValues: false, ignoreDeclaration: true,
  isArray: (name) => name === "Upload" });

/** Exact-prefix observation only. The operator owns retirement, write fencing and complete historical coverage. */
export async function captureR2MultipartUploads(input: {
  configuration: R2MultipartCaptureConfiguration;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  artifacts: DeletionCaptureArtifacts; abort?: R2MultipartAbortAuthorization;
  fetch?: typeof fetch; clock?: () => number;
}): Promise<R2MultipartCaptureReport> {
  const config = r2MultipartCaptureConfigurationSchema.parse(input.configuration);
  const resource = config.catalog.find((entry) => entry.id === config.resourceId);
  if (!resource || resource.source !== "cloudflare-r2-multipart" || resource.scope !== "installation"
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(resource.namespace)) {
    throw new Error("R2 capture requires an exact installation-scoped bucket from the operator catalog");
  }
  if (!input.credentials.accessKeyId.trim() || !input.credentials.secretAccessKey.trim()) throw new Error("R2 capture requires S3 authentication");
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const authorization = input.abort ? r2MultipartAbortAuthorizationSchema.parse(input.abort) : null;
  if (authorization && (authorization.installationId !== config.installationId || authorization.applicationErasedAt > startedAt)) {
    throw new Error("R2 abort authorization does not match the retired installation and completed application erasure");
  }
  // A retry starts a new provider observation; saved empty pages must never be reused as fresh proof.
  if (await input.artifacts.read("r2-multipart-config.json") !== null) throw new Error("R2 capture requires a new private output directory for every attempt");
  await input.artifacts.write("r2-multipart-config.json", JSON.stringify({ configuration: config, authorization }));
  const prefix = operatorResourceSelector(resource, config.installationId);
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${resource.namespace}`;
  const signer = new AwsClient({ ...input.credentials, service: "s3", region: "auto", retries: 0 });
  const request = async (url: URL, method: "GET" | "DELETE"): Promise<Response> => {
    try {
      const signed = await signer.sign(url, { method, redirect: "error", signal: AbortSignal.timeout(30_000) });
      return await (input.fetch ?? fetch)(signed);
    } catch { throw new Error("R2 multipart request failed; start a fresh capture before retrying"); }
  };
  const enumerate = async (phase: "before" | "after"): Promise<Snapshot & { uploads: Upload[] }> => {
    const uploads: Upload[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    const pageReferences: string[] = [];
    const facts: EnumerationFacts = { kind: "enumeration", pages: [] };
    let marker: Marker | null = null;
    for (let page = 0; page < 64; page++) {
      const url = new URL(endpoint);
      url.searchParams.set("uploads", "");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-uploads", "1000");
      url.searchParams.set("encoding-type", "url");
      if (marker) {
        url.searchParams.set("key-marker", marker.key);
        url.searchParams.set("upload-id-marker", marker.uploadId);
      }
      const response = await request(url, "GET");
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`R2 multipart enumeration returned HTTP ${response.status}`);
      }
      let result: z.infer<typeof pageSchema>["ListMultipartUploadsResult"];
      try { result = (await readXml(response, pageSchema)).ListMultipartUploadsResult; }
      catch { throw new Error("R2 multipart enumeration returned invalid metadata"); }
      const decode = (value: string) => {
        try { return decodeURIComponent(value); }
        catch { throw new Error("R2 multipart key encoding is invalid"); }
      };
      if (result.Bucket !== resource.namespace || decode(result.Prefix) !== prefix
        || decode(result.KeyMarker) !== (marker?.key ?? "") || result.UploadIdMarker !== (marker?.uploadId ?? "")) {
        throw new Error("R2 multipart enumeration scope or requested markers do not match");
      }
      const records: { keySha256: string; uploadIdSha256: string }[] = [];
      for (const entry of result.Upload) {
        const upload = { key: decode(entry.Key), uploadId: entry.UploadId };
        if (!upload.key.startsWith(prefix) || new TextEncoder().encode(upload.key).byteLength > 1024) throw new Error("R2 multipart upload is outside the exact installation prefix or exceeds the key limit");
        const identity = await digest(JSON.stringify(upload));
        if (ids.has(identity)) throw new Error("R2 multipart enumeration repeats an upload");
        ids.add(identity); uploads.push(upload);
        records.push({ keySha256: await digest(upload.key), uploadIdSha256: await digest(upload.uploadId) });
      }
      const next = result.IsTruncated === "true" ? { key: decode(result.NextKeyMarker), uploadId: result.NextUploadIdMarker } : null;
      const requestedCursor = marker ? await digest(JSON.stringify(marker)) : null;
      const nextCursor = next ? await digest(JSON.stringify(next)) : null;
      if (next && (!next.key.startsWith(prefix) || !next.uploadId || !result.Upload.length
        || next.key !== uploads.at(-1)?.key || next.uploadId !== uploads.at(-1)?.uploadId
        || cursors.has(nextCursor!) || nextCursor === requestedCursor)) throw new Error("R2 multipart continuation markers are invalid");
      if (nextCursor) cursors.add(nextCursor);
      const reference = `r2-multipart-${phase}-${page}.json`;
      const body = JSON.stringify({ version: 1, accountId: config.accountId, bucket: resource.namespace,
        installationId: config.installationId, prefix, observedAt: clock(), requestedCursor, nextCursor, records });
      await input.artifacts.write(reference, body);
      pageReferences.push(reference);
      facts.pages.push({ requestedCursor, nextCursor, itemCount: records.length, responseSha256: await digest(body) });
      if (!next) return { capturedAt: clock(), uploadCount: uploads.length, pageReferences, facts, uploads };
      marker = next;
    }
    throw new Error("R2 multipart enumeration exceeds 64 pages; no complete capture was produced");
  };
  const before = await enumerate("before");
  let abortedUploads = 0;
  let alreadyAbsentUploads = 0;
  let after: Awaited<ReturnType<typeof enumerate>> | undefined;
  if (authorization) {
    // Validate every address before the first mutation; URL normalization must not select another key.
    const targets = before.uploads.map((upload) => {
      const url = new URL(`${endpoint}/${upload.key.split("/").map(encodeURIComponent).join("/")}`);
      if (decodeURIComponent(url.pathname) !== `/${resource.namespace}/${upload.key}`) throw new Error("R2 multipart key cannot be represented without changing its exact address");
      url.searchParams.set("uploadId", upload.uploadId);
      return url;
    });
    for (const [index, url] of targets.entries()) {
      const response = await request(url, "DELETE");
      if (response.status === 204) {
        await response.body?.cancel().catch(() => {});
        abortedUploads++;
      } else if (response.status === 404) {
        try { await readXml(response, z.object({ Error: z.object({ Code: z.literal("NoSuchUpload") }) })); }
        catch { throw new Error("R2 multipart abort returned an unrecognized absence response"); }
        alreadyAbsentUploads++;
      } else {
        await response.body?.cancel().catch(() => {});
        throw new Error(`R2 multipart abort returned HTTP ${response.status}`);
      }
      const upload = before.uploads[index];
      await input.artifacts.write(`r2-multipart-abort-${index}.json`, JSON.stringify({
        keySha256: await digest(upload.key), uploadIdSha256: await digest(upload.uploadId),
        observedAt: clock(), outcome: response.status === 204 ? "acknowledged" : "already-absent",
      }));
    }
    after = await enumerate("after");
    if (after.uploadCount !== 0) throw new Error("R2 multipart uploads remain after abort; no empty evidence was produced");
  }
  const final = after ?? before;
  operatorResourceCaptureSchema.pick({ facts: true }).parse({ facts: final.facts });
  const report: R2MultipartCaptureReport = {
    version: 1, scope: "r2-multipart-prefix", outcome: "captured", accountId: config.accountId,
    installationId: config.installationId, catalogResource: resource, resourceSelector: prefix,
    startedAt, capturedAt: final.capturedAt, observedUploads: before.uploadCount, abortedUploads, alreadyAbsentUploads,
    remainingUploads: final.uploadCount, pageReferences: final.pageReferences, facts: final.facts,
    before: { capturedAt: before.capturedAt, uploadCount: before.uploadCount, pageReferences: before.pageReferences, facts: before.facts },
    authorization, coverage: { prefix: "exact-installation", historicalUnscopedUploads: "unknown" }, submission: null,
  };
  await input.artifacts.write("r2-multipart-capture-report.json", JSON.stringify(report));
  return report;
}

async function readXml<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("R2 multipart response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("R2 multipart metadata exceeds the capture limit");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid XML");
    return schema.parse(xmlParser.parse(xml));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("R2 multipart response is invalid or oversized");
  } finally { reader.releaseLock(); }
}

async function digest(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
