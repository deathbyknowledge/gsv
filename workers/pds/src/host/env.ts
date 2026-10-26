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
  /**
   * did:key of the operator's offline recovery key, ranked above the rotation
   * key in every DID, so the operator can undo what the host's key signs.
   */
  PLC_RECOVERY_KEY: string;
  /** Public address where the network can reach the host's operator, named by describeServer. */
  PDS_CONTACT_EMAIL?: string;
  /** The operator's privacy policy and terms of service, linked from describeServer. */
  PDS_PRIVACY_POLICY_URL?: string;
  PDS_TERMS_OF_SERVICE_URL?: string;
  /** Comma-separated HTTPS origins of the relays the host asks to crawl it, such as https://bsky.network; without one, it asks none. */
  PDS_RELAYS?: string;
}
