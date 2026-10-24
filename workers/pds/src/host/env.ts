import type { HostFirehose } from "./firehose";
import type { HostedRepo } from "./repo";

/** Bindings and settings for one PDS origin that hosts many repositories. */
export interface HostEnv {
  REPOS: DurableObjectNamespace<HostedRepo>;
  FIREHOSE: DurableObjectNamespace<HostFirehose>;
  BLOBS: R2Bucket;
  /** Origin that each repository's DID document names as its PDS, such as https://pds.ship.space. */
  PDS_ORIGIN: string;
  /** did:plc directory that receives this host's identity operations. */
  PLC_URL: string;
  /** Hex secp256k1 private key that signs this host's PLC operations. */
  PLC_ROTATION_KEY: string;
  /** did:key of an offline recovery key, ranked above the rotation key in every new DID. */
  PLC_RECOVERY_KEY?: string;
}
