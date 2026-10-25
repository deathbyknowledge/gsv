import { FIREHOSE_NAME } from "../host/firehose";
import type { IdentityEvent } from "../host/repo";
import type { PdsEnv } from "./env";

/** The most identities one audit request reads. */
export const AUDIT_PAGE = 25;

/** The least time between two of the audit's reads of the directory, which keeps it to four a second. */
const AUDIT_READ_INTERVAL_MS = 250;

/** One page of the operator's audit: how many identities it read, those the host steps aside for, and those it couldn't read. */
export type IdentityAuditPage = {
  checked: number;
  steppedAside: Array<IdentityEvent & { did: string; handle: string }>;
  unread: string[];
  cursor?: string;
};

/**
 * Reads again the log of each identity on a page of the host's directory, one
 * at a time, judging it as each repository's own check does. A suspected leak
 * of the host's rotation key is the reason to run it. The page names only the
 * identities the host steps aside for and those it couldn't read, by DID and handle.
 */
export async function auditIdentities(env: PdsEnv, limit: number, cursor?: string): Promise<IdentityAuditPage> {
  const { hosted, cursor: next } = await env.FIREHOSE.getByName(FIREHOSE_NAME).listHosted(limit, cursor);
  const page: IdentityAuditPage = { checked: 0, steppedAside: [], unread: [], cursor: next };
  for (const { name } of hosted) {
    await scheduler.wait(AUDIT_READ_INTERVAL_MS);
    const audited = await env.REPOS.getByName(name).auditIdentity();
    if (!audited) continue;
    page.checked += 1;
    if (!audited.read) page.unread.push(audited.did);
    if (audited.steppedAside) page.steppedAside.push({ did: audited.did, handle: audited.handle, ...audited.steppedAside });
  }
  return page;
}
