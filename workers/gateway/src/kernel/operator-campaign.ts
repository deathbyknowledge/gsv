import { z } from "zod";
import type { Kernel } from "./do";
import { kernelPeerContext } from "./peer";
import { handleSchedulerAdd, normalizeScheduleExpression } from "./scheduler";
import { ownerTimezone } from "./timezone";

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

/**
 * A one-off operator message: the Ship gets one scheduled responsibility, due
 * at the first of `slots` still ahead in its owner's timezone, or at once
 * while it is before `latest` there. Temporary; remove once it has run.
 */
export const operatorCampaignSchema = z.strictObject({
  name: z.string().min(1).max(120),
  message: z.string().min(1).max(4000),
  slots: z.array(localTime).min(1).max(4),
  latest: localTime,
  dryRun: z.boolean(),
});
export type OperatorCampaign = z.infer<typeof operatorCampaignSchema>;

export type OperatorCampaignResult = {
  status: "scheduled" | "would-schedule" | "exists" | "too-late" | "no-ship";
  atMs: number | null;
  timezone: string | null;
  messengers: number;
  lastActiveAt: number | null;
};

/** Leaves at least this long before a slot that is about to pass. */
const LEAD_MS = 60_000;
/** A Ship whose slots have passed hears it this soon. */
const NOW_DELAY_MS = 120_000;

export async function scheduleOperatorCampaign(
  host: Pick<Kernel, "procs" | "auth" | "caps" | "config" | "adapters" | "installationId" | "buildKernelContext">,
  input: OperatorCampaign,
  now = Date.now(),
): Promise<OperatorCampaignResult> {
  const messengers = host.adapters.identityLinks.list().length;
  const ship = host.procs.list().find((process) => process.isPersonalController);
  const account = ship ? host.auth.getPasswdByUid(ship.ownerUid) : null;
  if (!ship || !account) return { status: "no-ship", atMs: null, timezone: null, messengers, lastActiveAt: null };
  const identity = {
    uid: account.uid, gid: account.gid, gids: host.auth.resolveGids(account.username, account.gid),
    username: account.username, home: account.home, cwd: account.home,
  };
  const ctx = host.buildKernelContext({
    peer: kernelPeerContext({ installationId: host.installationId, identity, calls: host.caps.resolve(identity.gids) }),
    callerOwnerUid: account.uid,
  });
  const timezone = ownerTimezone(host.config, account.uid);
  const base = { timezone, messengers, lastActiveAt: ship.lastActiveAt };
  for (let offset = 0; ; offset += 100) {
    const page = ctx.schedules.list({ ownerUid: account.uid, includeDisabled: true, limit: 100, offset });
    if (page.records.some((schedule) => schedule.name === input.name)) return { ...base, status: "exists", atMs: null };
    if (page.records.length === 0 || offset + page.records.length >= page.count) break;
  }
  const at = (time: string) => {
    const expression = normalizeScheduleExpression({ kind: "at", localTime: time, timezone }, ctx);
    if (expression.kind !== "at") throw new Error("A local time resolves to a one-shot");
    return expression.atMs;
  };
  const atMs = input.slots.map(at).find((slot) => slot > now + LEAD_MS) ?? (now < at(input.latest) ? now + NOW_DELAY_MS : null);
  if (atMs === null) return { ...base, status: "too-late", atMs: null };
  if (input.dryRun) return { ...base, status: "would-schedule", atMs };
  await handleSchedulerAdd({
    name: input.name,
    expression: { kind: "at", atMs },
    target: { kind: "responsibility", message: input.message },
  }, ctx);
  return { ...base, status: "scheduled", atMs };
}
