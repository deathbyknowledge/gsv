import { GsvFailure } from "@gsv/catalog";
import { checkHash, hex, readBody, type BlobBody, type BlobStore, type MultipartUpload } from "./blob.ts";

export type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

/** The blob store over any S3-compatible server, path-style, signed with SigV4 over fetch. */
export class S3BlobStore implements BlobStore {
  private readonly config: S3Config;
  constructor(config: S3Config) { this.config = config; }

  async put(key: string, body: BlobBody, opts: { sha256?: string } = {}): Promise<void> {
    const { bytes, sha256 } = await readBody(body);
    checkHash(opts.sha256, sha256);
    await this.send("PUT", key, {}, { body: bytes, sha256, headers: { "x-amz-meta-sha256": sha256 } });
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<ReadableStream<Uint8Array> | null> {
    const headers: Record<string, string> = range ? { range: `bytes=${range.offset}-${range.length === undefined ? "" : range.offset + range.length - 1}` } : {};
    const response = await this.send("GET", key, {}, { headers, allow: [404] });
    return response.status === 404 ? null : response.body;
  }

  async head(key: string): Promise<{ size: number; sha256?: string } | null> {
    const response = await this.send("HEAD", key, {}, { allow: [404] });
    if (response.status === 404) return null;
    const size = Number(response.headers.get("content-length") ?? 0);
    const sha256 = response.headers.get("x-amz-meta-sha256");
    return sha256 ? { size, sha256 } : { size };
  }

  async delete(keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 16) {
      await Promise.all(keys.slice(index, index + 16).map(key => this.send("DELETE", key, {}, {})));
    }
  }

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (cursor) query["continuation-token"] = cursor;
    const xml = await (await this.send("GET", "", query, {})).text();
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map(match => unescapeXml(match[1] ?? ""));
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    return next ? { keys, cursor: unescapeXml(next) } : { keys };
  }

  async multipart(key: string): Promise<MultipartUpload> {
    const xml = await (await this.send("POST", key, { uploads: "" }, {})).text();
    const id = /<UploadId>([^<]*)<\/UploadId>/.exec(xml)?.[1];
    if (!id) throw new GsvFailure("unavailable", "The blob store did not start the upload.");
    return this.resume(key, unescapeXml(id));
  }

  resume(key: string, id: string): MultipartUpload {
    return {
      id,
      part: async (n, body) => {
        const { bytes, sha256 } = await readBody(body);
        const response = await this.send("PUT", key, { partNumber: String(n), uploadId: id }, { body: bytes, sha256 });
        const etag = response.headers.get("etag");
        if (!etag) throw new GsvFailure("unavailable", "The blob store did not acknowledge the part.");
        return { etag };
      },
      complete: async parts => {
        const body = encoder.encode(`<CompleteMultipartUpload>${[...parts].sort((a, b) => a.n - b.n)
          .map(part => `<Part><PartNumber>${part.n}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`);
        const response = await this.send("POST", key, { uploadId: id }, { body, sha256: hex(await crypto.subtle.digest("SHA-256", body)) });
        // A completion can fail inside a 200 response.
        if ((await response.text()).includes("<Error>")) throw new GsvFailure("unavailable", "The blob store did not complete the upload.");
      },
      abort: async () => { await this.send("DELETE", key, { uploadId: id }, { allow: [404] }); },
    };
  }

  private async send(
    method: string,
    key: string,
    query: Record<string, string>,
    opts: { body?: ArrayBuffer | ArrayBufferView; sha256?: string; headers?: Record<string, string>; allow?: number[] },
  ): Promise<Response> {
    const endpoint = new URL(this.config.endpoint);
    const path = `/${this.config.bucket}${key ? `/${key.split("/").map(uriEncode).join("/")}` : ""}`;
    const canonicalQuery = Object.keys(query).sort().map(name => `${uriEncode(name)}=${uriEncode(query[name] ?? "")}`).join("&");
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": opts.sha256 ?? EMPTY_SHA256,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).filter(([name]) => name.startsWith("x-amz-"))),
    };
    const signed = Object.keys(headers).sort();
    const canonicalRequest = [method, path, canonicalQuery, ...signed.map(name => `${name}:${(headers[name] ?? "").trim()}`), "", signed.join(";"), headers["x-amz-content-sha256"]].join("\n");
    const scope = `${amzDate.slice(0, 8)}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)))].join("\n");
    let signingKey: BufferSource = encoder.encode(`AWS4${this.config.secretAccessKey}`);
    for (const part of [amzDate.slice(0, 8), this.config.region, "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
    const signature = hex(await hmac(signingKey, stringToSign));
    const requestHeaders = new Headers({ ...opts.headers, ...headers });
    requestHeaders.delete("host");
    requestHeaders.set("authorization", `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`);
    const url = `${endpoint.origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const response = await fetch(url, { method, headers: requestHeaders, ...(opts.body ? { body: opts.body } : {}) });
    if (!response.ok && !(opts.allow ?? []).includes(response.status)) {
      await response.body?.cancel();
      throw new GsvFailure("unavailable", `The blob store answered ${response.status} to ${method}.`);
    }
    return response;
  }
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
