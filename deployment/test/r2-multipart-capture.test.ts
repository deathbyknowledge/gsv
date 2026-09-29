import { describe, expect, it, vi } from "vitest";
import { captureR2MultipartUploads, type R2MultipartCaptureConfiguration } from "../src/r2-multipart-capture.ts";
import { enumerationIsEmpty, operatorResourceCaptureSchema } from "../../workers/installations/src/operator-resource-contracts.ts";

const prefix = "installations/inst_retired/";
type Upload = { key: string; uploadId: string };
function capturedRequest(input: Parameters<typeof fetch>[0]): Request {
  if (!(input instanceof Request)) throw new Error("Expected a signed Request");
  return input;
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function page(uploads: Upload[] = [], options: { marker?: Upload; next?: Upload; extra?: string } = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Bucket>test-bucket</Bucket><Prefix>${encodeURIComponent(prefix)}</Prefix><EncodingType>url</EncodingType><MaxUploads>1000</MaxUploads>
    <KeyMarker>${encodeURIComponent(options.marker?.key ?? "")}</KeyMarker><UploadIdMarker>${xml(options.marker?.uploadId ?? "")}</UploadIdMarker>
    <NextKeyMarker>${encodeURIComponent(options.next?.key ?? "")}</NextKeyMarker><NextUploadIdMarker>${xml(options.next?.uploadId ?? "")}</NextUploadIdMarker>
    <IsTruncated>${Boolean(options.next)}</IsTruncated>${options.extra ?? ""}
    ${uploads.map((upload) => `<Upload><Key>${encodeURIComponent(upload.key)}</Key><UploadId>${xml(upload.uploadId)}</UploadId><Owner><DisplayName>private owner</DisplayName></Owner></Upload>`).join("")}
  </ListMultipartUploadsResult>`);
}
function fixture() {
  let now = 2000;
  const configuration: R2MultipartCaptureConfiguration = { version: 1, accountId: "a".repeat(32), installationId: "inst_retired", resourceId: "multipart",
    catalog: [{ id: "multipart", kind: "r2", namespace: "test-bucket", source: "cloudflare-r2-multipart", scope: "installation", disposition: "live" }] };
  const credentials = { accessKeyId: "access-private", secretAccessKey: "secret-private", sessionToken: "session-private" };
  const abort = { installationId: "inst_retired", operationId: "delete-operation", applicationErasedAt: 1000 };
  const files = new Map<string, string>();
  const artifacts = { read: async (reference: string) => files.get(reference) ?? null,
    write: async (reference: string, body: string) => { if (files.has(reference)) throw new Error("immutable artifact"); files.set(reference, body); } };
  const transport = vi.fn<typeof fetch>(async () => page());
  const run = (erase = false) => captureR2MultipartUploads({ configuration, credentials, artifacts, fetch: transport, clock: () => ++now, abort: erase ? abort : undefined });
  const requests = () => transport.mock.calls.map(([input]) => capturedRequest(input));
  return { configuration, credentials, abort, artifacts, files, transport, run, requests };
}

describe("R2 multipart deletion capture", () => {
  it("accepts R2's actual empty-page shape with omitted markers", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(new Response(`<ListMultipartUploadsResult><Bucket>test-bucket</Bucket><Prefix>${encodeURIComponent(prefix)}</Prefix><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated><EncodingType>url</EncodingType></ListMultipartUploadsResult>`));
    expect(await f.run()).toMatchObject({ observedUploads: 0, remainingUploads: 0 });
  });
  it("follows both markers including multiple uploads of one key, retains only hashes and never mutates during observation", async () => {
    const f = fixture();
    const a = { key: `${prefix}private + % résumé.txt`, uploadId: "upload-a&one" };
    const b = { key: a.key, uploadId: "upload-b" };
    f.transport.mockResolvedValueOnce(page([a], { next: a })).mockResolvedValueOnce(page([b], { marker: a }));
    const report = await f.run();
    expect(report).toMatchObject({ observedUploads: 2, remainingUploads: 2, abortedUploads: 0, authorization: null, submission: null });
    const requests = f.requests();
    expect(requests.every((request) => request.method === "GET" && request.redirect === "error")).toBe(true);
    expect(requests.every((request) => request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "))).toBe(true);
    expect(requests.every((request) => request.headers.get("x-amz-security-token") === "session-private")).toBe(true);
    expect(new URL(requests[1].url).searchParams.get("key-marker")).toBe(a.key);
    expect(new URL(requests[1].url).searchParams.get("upload-id-marker")).toBe(a.uploadId);
    expect(new URL(requests[0].url).searchParams.has("delimiter")).toBe(false);
    expect(report.facts.pages[0].nextCursor).toBe(report.facts.pages[1].requestedCursor);
    expect(report.facts.pages[1].nextCursor).toBeNull();
    const serialized = [...f.files.values()].join("");
    for (const value of [a.key, a.uploadId, b.uploadId, "private owner", ...Object.values(f.credentials)]) expect(serialized).not.toContain(value);
    for (const [index, reference] of report.pageReferences.entries()) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.files.get(reference)!));
      expect(report.facts.pages[index].responseSha256).toBe(Buffer.from(hash).toString("hex"));
    }
  });

  it("captures the complete inventory before aborting, preserves another space and proves a new empty enumeration", async () => {
    const f = fixture();
    const own = { key: `${prefix}file + % name.txt`, uploadId: "own+id" };
    const other = { key: "installations/inst_other/private.txt", uploadId: "other-id" };
    const live = [own, other];
    f.transport.mockImplementation(async (input) => {
      const request = capturedRequest(input);
      const url = new URL(request.url);
      if (request.method === "GET") {
        expect(url.searchParams.get("prefix")).toBe(prefix);
        return page(live.filter((upload) => upload.key.startsWith(prefix)));
      }
      expect(f.files.has("r2-multipart-before-0.json")).toBe(true);
      expect(decodeURIComponent(url.pathname)).toBe(`/test-bucket/${own.key}`);
      expect(url.searchParams.get("uploadId")).toBe(own.uploadId);
      live.splice(live.indexOf(own), 1);
      return new Response(null, { status: 204 });
    });
    const report = await f.run(true);
    expect(f.requests().map((request) => request.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(live).toEqual([other]);
    expect(report).toMatchObject({ observedUploads: 1, abortedUploads: 1, remainingUploads: 0, authorization: f.abort });
    expect(report.pageReferences).toEqual(["r2-multipart-after-0.json"]);
    expect(report.before.facts.pages[0].itemCount).toBe(1);
    const capture = operatorResourceCaptureSchema.parse({ version: 1, installationId: f.configuration.installationId, operationId: f.abort.operationId,
      resourceId: "multipart", namespace: "test-bucket", source: "cloudflare-r2-multipart", selector: prefix,
      capturedAt: report.capturedAt, reference: "r2-multipart-capture-report.json", facts: report.facts });
    expect(enumerationIsEmpty(capture)).toBe(true);
    expect(report.capturedAt).toBeGreaterThan(report.before.capturedAt);
  });

  it("refuses an out-of-prefix upload on a later page before any abort", async () => {
    const f = fixture();
    const own = { key: `${prefix}ours`, uploadId: "a" };
    f.transport.mockResolvedValueOnce(page([own], { next: own }))
      .mockResolvedValueOnce(page([{ key: "installations/inst_retired-other/theirs", uploadId: "b" }], { marker: own }));
    await expect(f.run(true)).rejects.toThrow("outside the exact installation prefix");
    expect(f.requests().every((request) => request.method === "GET")).toBe(true);
    expect(f.files.has("r2-multipart-capture-report.json")).toBe(false);
  });

  it.each(["wrong-marker", "repeated-marker", "duplicate-upload", "grouped-prefix", "missing-continuation", "skipped-marker"])("rejects %s instead of truncating the evidence", async (kind) => {
    const f = fixture();
    const a = { key: `${prefix}a`, uploadId: "a" };
    const b = { key: `${prefix}b`, uploadId: "b" };
    if (kind === "grouped-prefix") f.transport.mockResolvedValueOnce(page([], { extra: "<CommonPrefixes><Prefix>hidden/</Prefix></CommonPrefixes>" }));
    else {
      f.transport.mockResolvedValueOnce(page([a], { next: a }));
      f.transport.mockResolvedValueOnce(page(kind === "duplicate-upload" ? [a] : [b], {
        marker: kind === "wrong-marker" ? b : a,
        next: kind === "repeated-marker" ? a : kind === "missing-continuation" ? { key: "", uploadId: "" }
          : kind === "skipped-marker" ? { key: `${prefix}unlisted`, uploadId: "unlisted" } : undefined,
      }));
    }
    await expect(f.run(true)).rejects.toThrow();
    expect(f.requests().every((request) => request.method === "GET")).toBe(true);
    expect(f.files.has("r2-multipart-capture-report.json")).toBe(false);
  });

  it("stops after the bounded page limit without aborting a partial inventory", async () => {
    const f = fixture();
    let marker: Upload | undefined;
    f.transport.mockImplementation(async () => {
      const next = { key: `${prefix}file`, uploadId: `upload-${f.transport.mock.calls.length}` };
      const response = page([next], { marker, next });
      marker = next;
      return response;
    });
    await expect(f.run(true)).rejects.toThrow("exceeds 64 pages");
    expect(f.requests()).toHaveLength(64);
    expect(f.requests().every((request) => request.method === "GET")).toBe(true);
  });

  it("accepts only NoSuchUpload as an abort replay, followed by fresh empty proof", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(page([{ key: `${prefix}file`, uploadId: "gone" }]))
      .mockResolvedValueOnce(new Response("<Error><Code>NoSuchUpload</Code><Message>private detail</Message></Error>", { status: 404 }))
      .mockResolvedValueOnce(page());
    expect(await f.run(true)).toMatchObject({ abortedUploads: 0, alreadyAbsentUploads: 1, remainingUploads: 0 });
    const denied = fixture();
    denied.transport.mockResolvedValueOnce(page([{ key: `${prefix}file`, uploadId: "gone" }]))
      .mockResolvedValueOnce(new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }));
    await expect(denied.run(true)).rejects.toThrow("unrecognized absence");
    expect(denied.files.has("r2-multipart-capture-report.json")).toBe(false);
  });

  it("does not claim clearance from an abort acknowledgement while uploads remain", async () => {
    const f = fixture();
    const upload = { key: `${prefix}still-live`, uploadId: "live" };
    f.transport.mockResolvedValueOnce(page([upload])).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(page([upload]));
    await expect(f.run(true)).rejects.toThrow("remain after abort");
    expect(f.files.has("r2-multipart-after-0.json")).toBe(true);
    expect(f.files.has("r2-multipart-capture-report.json")).toBe(false);
  });

  it("recovers a lost abort response by enumerating live state again, without reusing saved proof", async () => {
    const f = fixture();
    let exists = true;
    f.transport.mockImplementation(async (input) => {
      if (capturedRequest(input).method === "DELETE") { exists = false; throw new Error("private request URL and authentication"); }
      return page(exists ? [{ key: `${prefix}lost-reply`, uploadId: "lost" }] : []);
    });
    await expect(f.run(true)).rejects.toThrow("request failed");
    expect(f.files.has("r2-multipart-capture-report.json")).toBe(false);
    await expect(f.run(true)).rejects.toThrow("new private output directory");
    const retry = fixture();
    retry.transport.mockImplementation(f.transport.getMockImplementation()!);
    expect(await retry.run(true)).toMatchObject({ observedUploads: 0, remainingUploads: 0 });
    expect(retry.requests().map((request) => request.method)).toEqual(["GET", "GET"]);
  });

  it("rejects stale scope, future erasure receipts, deployment-wide selectors and missing credentials before network access", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.abort.installationId = "another"; },
      (f: ReturnType<typeof fixture>) => { f.abort.applicationErasedAt = 9999; },
      (f: ReturnType<typeof fixture>) => { f.configuration.catalog[0].scope = "deployment"; },
      (f: ReturnType<typeof fixture>) => { f.credentials.secretAccessKey = ""; },
    ]) {
      const f = fixture(); mutate(f);
      await expect(f.run(true)).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it("validates every abort URL before mutating, including keys that URL normalization would change", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(page([{ key: `${prefix}valid`, uploadId: "a" }, { key: `${prefix}../other/file`, uploadId: "b" }]));
    await expect(f.run(true)).rejects.toThrow("exact address");
    expect(f.requests().map((request) => request.method)).toEqual(["GET"]);
  });

  it.each(["<not-a-page/>", "<!DOCTYPE foo [<!ENTITY private SYSTEM 'file:///secret'>]><foo>&private;</foo>", "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>"])("does not turn malformed XML into an empty report", async (body) => {
    const f = fixture(); f.transport.mockResolvedValueOnce(new Response(body));
    await expect(f.run()).rejects.toThrow("invalid metadata");
    expect(f.files.has("r2-multipart-capture-report.json")).toBe(false);
  });

  it("redacts failing responses and rejects oversized metadata", async () => {
    const failed = fixture(); failed.transport.mockResolvedValueOnce(new Response("secret upstream response", { status: 403 }));
    await expect(failed.run()).rejects.toThrow(/^R2 multipart enumeration returned HTTP 403$/);
    const oversized = fixture(); oversized.transport.mockResolvedValueOnce(new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(oversized.run()).rejects.toThrow("invalid metadata");
    expect(oversized.files.has("r2-multipart-capture-report.json")).toBe(false);
  });
});
