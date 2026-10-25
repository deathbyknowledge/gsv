import type {
  ModerationSubject,
  PdsModerationService,
  RepositoryModeration,
  SubjectStatus,
  SubjectStatusUpdate,
} from "@humansandmachines/gsv/services/pds";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { z } from "zod";
import type { JsonObject } from "../http";
import type { AdminAuditRecorder, OperatorAuditResult } from "./insight";

/** The Ship page waits for the PDS as long as it waits for the Ship's health. */
const VIEW_TIMEOUT_MS = 3_000;
const REASON_MAX_LENGTH = 500;
/** A trimmed text field; a blank one reads as absent. */
const field = (maxLength: number) => z.string().max(maxLength).nullish().transform((value) => value?.trim() || undefined);
/** What a takedown or restore form, or its JSON body, says. */
const takedownRequestSchema = z.object({
  subject: field(2_048),
  uri: field(2_048),
  cid: field(128),
  reason: field(REASON_MAX_LENGTH),
});
type TakedownRequest = z.infer<typeof takedownRequestSchema>;
/** The PDS answers a subject it doesn't hold, or can't take down, with one of these XRPC errors. */
const PDS_REFUSAL = /^(?:InvalidRequest|RecordNotFound|BlobNotFound|RepoNotFound|RepoDeleted): (.+)$/s;

/** What the Ship page shows of the Ship's repository on the open network. */
export type ShipOpenNetwork =
  | { kind: "ok"; repository: RepositoryModeration }
  | { kind: "none" }
  | { kind: "unavailable"; reason: "timed out" | "failed" };

export type TakedownSubjectKind = "account" | "record" | "blob";

/** The Ship's whole account, one of its records by AT URI, or one of its files by CID, and the reason its person reads. */
export type TakedownInput =
  | { subject: "account"; reason: string }
  | { subject: "record"; uri: string; reason: string }
  | { subject: "blob"; cid: string; reason: string };

/**
 * Takedowns of what a Ship publishes on the open network. The deployment's PDS
 * keeps each one with the Ship's repository and every public read honours it;
 * Accounts records the operator's action and reason in the audit log.
 */
export class ShipTakedowns {
  constructor(
    private readonly pds: PdsModerationService,
    private readonly timeoutMs = VIEW_TIMEOUT_MS,
  ) {}

  /** The Ship's open-network account and what its host has taken down; null before the Ship's first outward act. */
  repository(installationId: string): Promise<RepositoryModeration | null> {
    return this.pds.getRepository(installationId);
  }

  /** Best effort, for the Ship page: a slow or failed read must not hide the rest of it. */
  async view(installationId: string): Promise<ShipOpenNetwork> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const repository = await Promise.race([
        this.pds.getRepository(installationId),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.timeoutMs); }),
      ]);
      if (repository === "timeout") return { kind: "unavailable", reason: "timed out" };
      return repository ? { kind: "ok", repository } : { kind: "none" };
    } catch (error) {
      console.warn("[Operator] Ship takedowns unavailable:", exceptionDiagnostics(error));
      return { kind: "unavailable", reason: "failed" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Takes a subject down; the PDS keeps `ref`, the audit event that records the action, with it. */
  async takeDown(installationId: string, input: TakedownInput, ref?: string): Promise<SubjectStatus> {
    const { did } = await this.requireRepository(installationId);
    let subject: ModerationSubject;
    if (input.subject === "account") subject = { $type: "com.atproto.admin.defs#repoRef", did };
    else if (input.subject === "blob") subject = { $type: "com.atproto.admin.defs#repoBlobRef", did, cid: input.cid };
    else {
      // A takedown names the record's current version, which the operator needn't know.
      const status = await this.pds.getSubjectStatus(installationId, { uri: input.uri });
      if (status?.subject.$type !== "com.atproto.repo.strongRef") throw new Error(`request names no record of this Ship: ${input.uri}`);
      subject = status.subject;
    }
    return await this.update(installationId, { subject, takedown: ref ? { applied: true, ref } : { applied: true }, reason: input.reason });
  }

  /** Restores what the Ship's host has taken down, named by its DID, AT URI or CID. */
  async restore(installationId: string, key: string): Promise<SubjectStatus> {
    const repository = await this.requireRepository(installationId);
    const takedown = repository.takedowns.find(({ subject }) => takedownSubjectKey(subject) === key);
    if (!takedown) throw new Error("request names nothing this Ship has taken down");
    return await this.update(installationId, { subject: takedown.subject, takedown: { applied: false } });
  }

  private async requireRepository(installationId: string): Promise<RepositoryModeration> {
    const repository = await this.pds.getRepository(installationId);
    if (!repository) throw new Error("request names a Ship with no repository on the open network yet");
    return repository;
  }

  private async update(installationId: string, input: SubjectStatusUpdate): Promise<SubjectStatus> {
    try {
      return await this.pds.updateSubjectStatus(installationId, input);
    } catch (error) {
      const refusal = error instanceof Error ? PDS_REFUSAL.exec(error.message) : null;
      if (refusal) throw new Error(`request refused by the open-network host: ${refusal[1]}`);
      throw error;
    }
  }
}

/**
 * Runs an operator's takedown or restore, read from a form or JSON body, under
 * its audit event. A takedown needs a reason, because the Ship's person reads it.
 */
export async function runTakedownAction(
  takedowns: ShipTakedowns,
  audited: AdminAuditRecorder,
  request: Request,
  installationId: string,
  action: "takedown" | "restore",
  body: JsonObject,
): Promise<SubjectStatus> {
  const parsed = takedownRequestSchema.safeParse(body);
  if (!parsed.success) throw new Error(`request ${parsed.error.issues[0]?.path.join(".") || "body"} is invalid`);
  const values = parsed.data;
  const describe = (result: SubjectStatus): OperatorAuditResult => ({ detail: { subject: takedownSubjectKind(result.subject) } });
  if (action === "restore") {
    const { subject } = values;
    if (!subject) throw new Error("request subject is required");
    return await audited(request, { name: "ship.restore", installationId, reason: values.reason ?? null },
      () => takedowns.restore(installationId, subject), describe);
  }
  const { reason } = values;
  if (!reason) throw new Error("request reason is required: the Ship's person reads it");
  const input = takedownInput(values, reason);
  return await audited(request, { name: "ship.takedown", installationId, reason },
    (eventId) => takedowns.takeDown(installationId, input, eventId), describe);
}

/** The key the PDS keeps a takedown by: the account's DID, the record's AT URI or the blob's CID. */
export function takedownSubjectKey(subject: ModerationSubject): string {
  switch (subject.$type) {
    case "com.atproto.admin.defs#repoRef": return subject.did;
    case "com.atproto.repo.strongRef": return subject.uri;
    case "com.atproto.admin.defs#repoBlobRef": return subject.cid;
  }
}

export function takedownSubjectKind(subject: ModerationSubject): TakedownSubjectKind {
  switch (subject.$type) {
    case "com.atproto.admin.defs#repoRef": return "account";
    case "com.atproto.repo.strongRef": return "record";
    case "com.atproto.admin.defs#repoBlobRef": return "blob";
  }
}

function takedownInput({ subject, uri, cid }: TakedownRequest, reason: string): TakedownInput {
  switch (subject) {
    case "account": return { subject: "account", reason };
    case "record":
      if (!uri) throw new Error("request needs the record's AT URI");
      return { subject: "record", uri, reason };
    case "blob":
      if (!cid) throw new Error("request needs the file's CID");
      return { subject: "blob", cid, reason };
    default: throw new Error("request subject must be account, record or blob");
  }
}
