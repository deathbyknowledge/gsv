import { z } from "zod";
import { feedSchema, PROTOCOL } from "./frames.ts";
import { op } from "./op.ts";

const ownerId = z.string();

export const connect = op({
  name: "connect",
  kind: "owner",
  verb: "read",
  effect: "read",
  args: z.object({
    protocol: z.literal(PROTOCOL),
    client: z.object({ name: z.string().max(64), version: z.string().max(32), platform: z.string().max(32) }),
    since: z.object({ events: z.number().int().nonnegative().optional(), ledger: z.number().int().nonnegative().optional() }).optional(),
    watches: z.array(feedSchema).max(64).optional(),
  }),
  result: z.object({
    owner: ownerId,
    person: ownerId,
    resumed: z.union([z.literal(true), z.literal("reset")]),
    minVersion: z.record(z.string(), z.string()),
    deprecations: z.array(z.object({ op: z.string(), until: z.string() })),
  }),
  errors: ["bad_request", "unauthorized", "moved", "upgrade_required", "unavailable"],
  timeoutMs: 10_000,
  secretFields: [],
  doc: "The first request on a control socket: names the client, resumes cursors and declares watches.",
});

/** The operation list; later milestones add the rest of 10-syscall-catalog. */
export const OPERATIONS = [connect] as const;
