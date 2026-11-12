import { env } from "cloudflare:workers";
import { describe, it } from "vitest";
import { openBlobStore } from "../src/blob/index.ts";
import { S3BlobStore } from "../src/blob/s3.ts";
import { blobContract } from "./blob-contract.ts";

blobContract("R2", () => openBlobStore(env));

const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
if (endpoint && bucket && accessKeyId && secretAccessKey) {
  blobContract("S3", () => new S3BlobStore({ endpoint, bucket, region: env.S3_REGION ?? "us-east-1", accessKeyId, secretAccessKey }));
} else {
  describe("blob store: S3", () => { it.skip("needs GSV_TEST_S3_ENDPOINT and credentials", () => {}); });
}
