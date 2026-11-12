import { checkHash, readBody, type BlobBody, type BlobStore, type MultipartUpload } from "./blob.ts";

/** The blob store over an R2 binding. The only place the runtime touches R2. */
export class R2BlobStore implements BlobStore {
  private readonly bucket: R2Bucket;
  constructor(bucket: R2Bucket) { this.bucket = bucket; }

  async put(key: string, body: BlobBody, opts: { sha256?: string } = {}): Promise<void> {
    const { bytes, sha256 } = await readBody(body);
    checkHash(opts.sha256, sha256);
    await this.bucket.put(key, bytes, { sha256, customMetadata: { sha256 } });
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.bucket.get(key, range ? { range: range.length === undefined ? { offset: range.offset } : range } : {});
    return object?.body ?? null;
  }

  async head(key: string): Promise<{ size: number; sha256?: string } | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    const sha256 = object.customMetadata?.sha256;
    return sha256 ? { size: object.size, sha256 } : { size: object.size };
  }

  async delete(keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 1000) await this.bucket.delete(keys.slice(index, index + 1000));
  }

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
    const page = await this.bucket.list(cursor ? { prefix, cursor } : { prefix });
    return page.truncated ? { keys: page.objects.map(object => object.key), cursor: page.cursor } : { keys: page.objects.map(object => object.key) };
  }

  async multipart(key: string): Promise<MultipartUpload> {
    return this.wrap(await this.bucket.createMultipartUpload(key));
  }

  resume(key: string, id: string): MultipartUpload {
    return this.wrap(this.bucket.resumeMultipartUpload(key, id));
  }

  private wrap(upload: R2MultipartUpload): MultipartUpload {
    return {
      id: upload.uploadId,
      part: async (n, body) => ({ etag: (await upload.uploadPart(n, (await readBody(body)).bytes)).etag }),
      complete: async parts => { await upload.complete([...parts].sort((a, b) => a.n - b.n).map(part => ({ partNumber: part.n, etag: part.etag }))); },
      abort: () => upload.abort(),
    };
  }
}
