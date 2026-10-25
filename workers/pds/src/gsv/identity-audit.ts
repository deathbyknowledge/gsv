import { FIREHOSE_NAME } from "../host/firehose";
import type { IdentityEvent } from "../host/repo";
import type { PdsEnv } from "./env";

/** The most identities one audit request reads. */
export const AUDIT_PAGE = 25;

/** The audit's reads of the directory a second, unless the operator asks for more. */
export const AUDIT_READS_PER_SECOND = 1;

/** The most reads a second the operator can ask the audit for. */
export const MAX_AUDIT_READS_PER_SECOND = 10;

/** One page of the operator's audit: how many identities it read, those the host steps aside for, and those it couldn't read. */
export type IdentityAuditPage = {
  checked: number;
  steppedAside: Array<IdentityEvent & { did: string; handle: string }>;
  unread: string[];
  /** Where the next page starts; absent from the last page. */
  cursor?: string;
  /**
   * Set when the directory answered 429, which ends the page before the
   * identity it refused: the seconds it asked the host to wait, or null when
   * it named none. The next page starts at that identity, from the beginning
   * when `cursor` is absent.
   */
  retryAfter?: number | null;
};

/**
 * Reads again the log of each identity on a page of the host's directory, one
 * at a time and at most `readsPerSecond` a second, judging it as each
 * repository's own check does. A suspected leak of the host's rotation key is
 * the reason to run it. The page names only the identities the host steps
 * aside for and those it couldn't read, by DID and handle.
 */
export async function auditIdentities(
  env: PdsEnv,
  { limit, readsPerSecond, cursor }: { limit: number; readsPerSecond: number; cursor?: string },
): Promise<IdentityAuditPage> {
  const { hosted, cursor: next } = await env.FIREHOSE.getByName(FIREHOSE_NAME).listHosted(limit, cursor);
  const page: IdentityAuditPage = { checked: 0, steppedAside: [], unread: [], cursor: next };
  let resume = cursor;
  for (const { did, name } of hosted) {
    await scheduler.wait(1000 / readsPerSecond);
    const audited = await env.REPOS.getByName(name).auditIdentity();
    if (audited?.outcome === "busy") return { ...page, cursor: resume, retryAfter: audited.retryAfter };
    resume = did;
    if (!audited) continue;
    page.checked += 1;
    if (audited.outcome === "unread") page.unread.push(audited.did);
    if (audited.steppedAside) page.steppedAside.push({ did: audited.did, handle: audited.handle, ...audited.steppedAside });
  }
  return page;
}
