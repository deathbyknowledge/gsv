import type { Env } from "../env.ts";
import type { BlobStore } from "./blob.ts";
import { R2BlobStore } from "./r2.ts";
import { S3BlobStore, type S3Config } from "./s3.ts";

export type { BlobStore } from "./blob.ts";
export { PART_BYTES } from "./blob.ts";

/** R2 when the deployment binds it, else the S3-compatible store the config names. */
export function openBlobStore(env: Env): BlobStore {
  if (env.BLOBS) return new R2BlobStore(env.BLOBS);
  const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("No blob store is configured");
  const config: S3Config = { endpoint, bucket, region: env.S3_REGION ?? "auto", accessKeyId, secretAccessKey };
  const network = env.S3_NETWORK;
  if (network) config.fetch = (url, init) => network.fetch(url, init);
  return new S3BlobStore(config);
}
