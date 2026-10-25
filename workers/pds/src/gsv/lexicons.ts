import type { HostedAccount, LexObject, RecordPut } from "../host/repo";
import { XrpcError } from "../host/xrpc";
import type { PdsEnv } from "./env";
import { SHIP_LEXICONS } from "./generated/ship-lexicons";

/**
 * The object that holds the deployment's lexicon account. It isn't an
 * installation ID, and can't be one, so neither the Kernel's binding nor a
 * deletion addresses it.
 */
export const LEXICON_REPOSITORY = "operator/lexicons";

/** The collection that publishes a lexicon, under its NSID as the record key. */
const LEXICON_SCHEMA = "com.atproto.lexicon.schema";

/** One lexicon document, as its file in lexicons/ has it. */
export type ShipLexicon = LexObject & { id: string };

/** The deployment's lexicon account, and the lexicons of this release it hasn't published as they are. */
export type LexiconAccount = {
  /** The handle the deployment configures for the account, or null when it publishes no lexicons. */
  handle: string | null;
  account: HostedAccount | null;
  /** NSIDs whose published record differs from this release's lexicon, or that aren't published yet. */
  pending: string[];
};

/** The deployment's lexicon account, as the operator's status request reports it. */
export async function lexiconAccount(env: PdsEnv, lexicons: readonly ShipLexicon[] = SHIP_LEXICONS): Promise<LexiconAccount> {
  const repo = env.REPOS.getByName(LEXICON_REPOSITORY);
  const account = await repo.account();
  return {
    handle: env.PDS_LEXICON_HANDLE ?? null,
    account,
    pending: account ? await repo.changedRecords(LEXICON_SCHEMA, records(lexicons)) : lexicons.map((lexicon) => lexicon.id),
  };
}

/**
 * Creates the lexicon account for the handle the deployment configures, or
 * returns the one it has. The PLC directory keeps the account's DID for good,
 * so only an operator's request creates it, naming the handle it expects. A
 * handle Accounts routes to a Ship is refused, and once the deployment has an
 * account, so is any other handle.
 */
export async function createLexiconAccount(env: PdsEnv, handle: string): Promise<LexiconAccount> {
  const configured = configuredHandle(env);
  if (handle.toLowerCase() !== configured) {
    throw new XrpcError("InvalidHandle", `This deployment's lexicon handle is ${configured}, not ${handle}`, 409);
  }
  if ((await env.INSTALLATION_DIRECTORY.resolveHostname(configured)).found) {
    throw new XrpcError("HandleNotAvailable", `${configured} is a Ship's address`, 409);
  }
  try {
    await env.REPOS.getByName(LEXICON_REPOSITORY).create(configured, `${LEXICON_REPOSITORY}/`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("RepoConflict")) {
      throw new XrpcError("AccountExists", "This deployment's lexicon account has another handle", 409);
    }
    throw error;
  }
  return lexiconAccount(env);
}

/**
 * Publishes each of this release's lexicons whose record differs, as a
 * com.atproto.lexicon.schema record keyed by its NSID, in one commit, and
 * returns the NSIDs it wrote. It never deletes a record, so a lexicon a later
 * release drops stays published.
 */
export async function publishLexicons(env: PdsEnv, lexicons: readonly ShipLexicon[] = SHIP_LEXICONS): Promise<string[]> {
  configuredHandle(env);
  const repo = env.REPOS.getByName(LEXICON_REPOSITORY);
  if (!await repo.account()) throw new XrpcError("AccountNotFound", "This deployment has no lexicon account yet", 404);
  return repo.putChangedRecords(LEXICON_SCHEMA, records(lexicons));
}

/**
 * Publishes what changed on schedule, as a deploy's lexicons take over. It
 * does nothing until the operator has published once, so no deploy makes the
 * first publish, and it never creates the account.
 */
export async function republishLexicons(env: PdsEnv, lexicons: readonly ShipLexicon[] = SHIP_LEXICONS): Promise<string[]> {
  if (!env.PDS_LEXICON_HANDLE) return [];
  const repo = env.REPOS.getByName(LEXICON_REPOSITORY);
  if (!(await repo.collections()).includes(LEXICON_SCHEMA)) return [];
  return repo.putChangedRecords(LEXICON_SCHEMA, records(lexicons));
}

function configuredHandle(env: PdsEnv): string {
  if (!env.PDS_LEXICON_HANDLE) throw new XrpcError("LexiconsNotConfigured", "This deployment configures no lexicon handle", 400);
  return env.PDS_LEXICON_HANDLE;
}

function records(lexicons: readonly ShipLexicon[]): RecordPut[] {
  return lexicons.map((lexicon) => ({ rkey: lexicon.id, record: { ...lexicon, $type: LEXICON_SCHEMA } }));
}
