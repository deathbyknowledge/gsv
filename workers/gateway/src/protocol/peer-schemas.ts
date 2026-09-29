import type {
  ConnectedPeer,
  PeerGrant,
  PeerPrincipal,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

/**
 * Runtime checks for the peer identity the Kernel and Processes exchange over
 * Durable Object RPC and keep in hibernation attachments. Each schema is pinned
 * to the SDK type it mirrors, so a protocol change fails to type-check here
 * instead of silently accepting stale payloads.
 */

export const processIdentitySchema = z.object({
  uid: z.number().int(),
  gid: z.number().int(),
  gids: z.array(z.number().int()),
  username: z.string(),
  home: z.string(),
  cwd: z.string(),
}) satisfies z.ZodType<ProcessIdentity>;

export const peerPrincipalSchema = z.object({
  kind: z.enum(["human", "machine", "service"]),
  account: processIdentitySchema,
}) satisfies z.ZodType<PeerPrincipal>;

export const peerGrantSchema = z.object({
  calls: z.array(z.string()),
  signals: z.array(z.string()),
  implements: z.array(z.string()),
}) satisfies z.ZodType<PeerGrant>;

export const connectedPeerSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  principal: peerPrincipalSchema,
  grant: peerGrantSchema,
}) satisfies z.ZodType<ConnectedPeer>;
