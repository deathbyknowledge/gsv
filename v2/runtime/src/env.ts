import type { Directory } from "./directory/directory.ts";
import type { Owner } from "./owner/owner.ts";
import type { Process } from "./process/process.ts";
import type { Space } from "./space/space.ts";
import type { Target } from "./target/target.ts";
import type { Volume } from "./volume/volume.ts";

/** Bindings and variables the config compiler emits for both Cloudflare and workerd. */
export interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>;
  SPACE: DurableObjectNamespace<Space>;
  OWNER: DurableObjectNamespace<Owner>;
  PROCESS: DurableObjectNamespace<Process>;
  VOLUME: DurableObjectNamespace<Volume>;
  TARGET: DurableObjectNamespace<Target>;
  /** The web UI's built assets. Every deployment serves one. */
  ASSETS: Fetcher;
  /** Present on Cloudflare; on workerd the blob store is S3 over fetch. */
  BLOBS?: R2Bucket;
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  /** On workerd, the only outbound route allowed onto private networks, so a local S3 server is reachable and nothing else is. */
  S3_NETWORK?: Fetcher;
  /** Spaces live at `<handle>.<domain>`; sign-in and setup pages at the domain itself. */
  GSV_DOMAIN: string;
  GSV_RELEASE: string;
  /** The handle of the space whose admins are the operators; the setup link creates it. */
  GSV_OPERATOR_SPACE: string;
  /** One secret per deployment: space keys derive from it. */
  GSV_SECRET: string;
  /** `<expiresAt ms>.<sha256 hex of the setup code>`, written by `gsv deploy`. Empty once unused links don't matter. */
  GSV_SETUP?: string;
}
