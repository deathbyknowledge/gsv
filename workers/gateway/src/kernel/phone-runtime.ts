import type { PhoneCall, PhoneTranscriptLine, SysPhoneGetResult } from "@humansandmachines/gsv/protocol";
import { phoneChangeSchema, type PhoneActor, type PhoneChange } from "@humansandmachines/gsv/services/phone";
import { R2MountBackend } from "../fs/backends/r2";
import type { ProcessPhoneRuntimeEvent } from "../protocol/process-frames";
import { raceWithAbort } from "../shared/abort";
import { accountIdentity } from "./accounts";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { acquirePhone } from "./phone-service";
import type { ResponsibilityStore } from "./responsibility-store";

const NOTIFICATION_TIMEOUT_MS = 10_000;
const actor = { kind: "system", component: "phone" } as const;

/** The blocker a waiting responsibility carries while its call is live. */
export function phoneCallBlocker(callId: string): string {
  return `phone call ${callId}`;
}

/**
 * Checked again before delivery: a question whose deadline passed, or a call whose
 * work was already settled, has nothing left for Ship to do.
 */
export function admitQueuedPhoneEvent(ownerUid: number, event: ProcessPhoneRuntimeEvent, responsibilities: ResponsibilityStore): boolean {
  const work = responsibilities.get(ownerUid, event.responsibilityId);
  if (!work || work.state === "resolved" || work.state === "cancelled") return false;
  return event.type !== "phone.asked" || event.deadlineAt > Date.now();
}

/**
 * Applies calls service notifications. A notification carries only identity, so the
 * Kernel reads the call through its own capability, ignores revisions older than one
 * it applied, raises each question with Ship once, and settles an ended call once:
 * it files the transcript under the Ship account's home and hands the result to Ship.
 */
export class PhoneRuntime {
  constructor(readonly host: Kernel) {}

  async changed(raw: PhoneChange): Promise<void> {
    const change = phoneChangeSchema.parse(raw);
    if (change.installationId !== this.host.installationId) return;
    if (!await this.ownerAdmitted(change.ownerUid)) return;
    const known = this.host.phoneCalls.get(change.callId);
    if (known && (known.ownerUid !== change.ownerUid || known.settledAt !== null || known.revision > change.revision)) return;

    const ctx = this.host.buildKernelContext({ callerOwnerUid: change.ownerUid });
    const owner: PhoneActor = { ownerUid: change.ownerUid, human: false };
    const signal = AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS);
    const service = await acquirePhone(ctx, signal);
    try {
      const current = await raceWithAbort(service.get(owner, change.callId), signal);
      const { call } = current;
      if (call.callId !== change.callId || call.ownerUid !== change.ownerUid || call.revision < change.revision) return;
      let transcriptPath: string | null = null;
      if (call.state === "ended") {
        transcriptPath = await this.fileTranscript(current, ctx);
        if (transcriptPath && !current.transcriptPath) {
          await raceWithAbort(service.transcriptFiled(owner, call.callId, transcriptPath), signal);
        }
      }
      if (!await this.ownerAdmitted(change.ownerUid)) return;
      const queued = this.apply(call, transcriptPath);
      this.host.connectionRuntime.broadcastToUserUid(call.ownerUid, "phone.changed", {
        callId: call.callId, revision: call.revision, state: call.state,
      });
      if (queued) await this.host.shipEventRuntime.queue(call.ownerUid);
      await this.host.responsibilityRuntime.reconcileResponsibilityWake(call.ownerUid);
    } finally { service[Symbol.dispose]?.(); }
  }

  /** Records the revision and queues Ship's part in one transaction. Returns whether an event was queued. */
  private apply(call: PhoneCall, transcriptPath: string | null): boolean {
    const now = Date.now();
    return this.host.ctx.storage.transactionSync(() => {
      const known = this.host.phoneCalls.get(call.callId);
      if (known && (known.settledAt !== null || known.revision > call.revision)) return false;
      this.host.phoneCalls.observe(call.ownerUid, call.callId, call.revision, call.state, now);
      const work = call.responsibilityId ? this.host.responsibilities.get(call.ownerUid, call.responsibilityId) : null;
      const open = work && work.state !== "resolved" && work.state !== "cancelled" ? work : null;
      const common = {
        callId: call.callId, to: call.brief.to,
        ...(call.brief.business === undefined ? {} : { business: call.brief.business }),
      };

      if (call.state === "ended") {
        this.host.phoneCalls.settle(call.callId, transcriptPath, now);
        if (!open) return false;
        const ownBlocker = open.blocker === phoneCallBlocker(call.callId);
        const forShip = open.assignee.kind === "ship";
        this.host.responsibilities.update({
          ownerUid: call.ownerUid, id: open.id,
          patch: {
            ...(ownBlocker ? { state: "open" as const, blocker: null, nextCheckAtMs: now } : {}),
            details: { ...open.details, phoneCall: { callId: call.callId, outcome: call.outcome ?? "failed", ...(transcriptPath ? { transcriptPath } : {}) } },
          },
          actor, observedByShip: false, announced: forShip, now,
        });
        if (!forShip) return false;
        const event: ProcessPhoneRuntimeEvent = {
          type: "phone.ended", ...common, outcome: call.outcome ?? "failed",
          ...(call.summary === undefined ? {} : { summary: call.summary }),
          ...(call.reason === undefined ? {} : { reason: call.reason }),
          ...(transcriptPath ? { transcriptPath } : {}),
          responsibilityId: open.id,
          ledgerRevision: this.host.responsibilities.revision(call.ownerUid),
        };
        this.host.shipEvents.enqueue(call.ownerUid, `phone.ended:${call.callId}`, event, now);
        return true;
      }

      const question = call.question;
      if (call.state !== "asking" || !question || question.answer !== undefined || question.deadlineAt <= now) return false;
      // The callee is waiting now, so Ship hears the question even for work delegated to a crew Process.
      if (!open || known?.askedQuestionId === question.questionId) return false;
      this.host.phoneCalls.asked(call.callId, question.questionId, now);
      const event: ProcessPhoneRuntimeEvent = {
        type: "phone.asked", ...common,
        questionId: question.questionId, question: question.question, deadlineAt: question.deadlineAt,
        responsibilityId: open.id,
        ledgerRevision: this.host.responsibilities.revision(call.ownerUid),
      };
      this.host.shipEvents.enqueue(call.ownerUid, `phone.asked:${call.callId}:${question.questionId}`, event, now);
      return true;
    });
  }

  /** Writes the transcript once under the Ship account's home; a retried notification rewrites the same file. */
  private async fileTranscript(current: SysPhoneGetResult, ctx: KernelContext): Promise<string | null> {
    if (current.transcriptPath) return current.transcriptPath;
    if (!current.transcript) return null;
    const { call } = current;
    const shipUid = ctx.auth.getPersonalAgentUid(call.ownerUid) ?? call.ownerUid;
    const entry = ctx.auth.getPasswdByUid(shipUid);
    if (!entry) throw new Error("The call's owner has no home for its transcript");
    const identity = accountIdentity(ctx.auth, entry);
    const day = new Date(call.createdAt).toISOString().slice(0, 10);
    const directory = `${identity.home}/calls`;
    const path = `${directory}/${day}-${call.callId}.md`;
    const files = new R2MountBackend(ctx.env.STORAGE, identity);
    await files.mkdir(directory, { recursive: true });
    await files.writeFile(path, renderTranscript(call, current.transcript), { contentType: "text/markdown; charset=utf-8" });
    return path;
  }

  private async ownerAdmitted(ownerUid: number): Promise<boolean> {
    this.host.retirement.assertActive();
    const gate = await this.host.onboarding.managedWorkGate();
    this.host.retirement.assertActive();
    return gate.allowed && !!this.host.auth.getPasswdByUid(ownerUid) && !this.host.auth.isAccountDisabled(ownerUid);
  }
}

function renderTranscript(call: PhoneCall, lines: PhoneTranscriptLine[]): string {
  const callee = call.brief.business ?? call.brief.to;
  const speaker: Record<PhoneTranscriptLine["speaker"], string> = {
    agent: "Assistant", callee, note: "Note from the owner", answer: "Answer from the owner",
  };
  const started = call.answeredAt ?? call.createdAt;
  const clock = (at: number) => {
    const seconds = Math.max(0, Math.round((at - started) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return [
    `# Call to ${callee}`,
    "",
    `- Number: ${call.brief.to}`,
    `- For: ${call.brief.onBehalfOf}`,
    `- Goal: ${call.brief.goal}`,
    `- Placed: ${new Date(call.createdAt).toISOString()}`,
    `- Outcome: ${call.outcome ?? "unknown"}${call.reason ? ` (${call.reason})` : ""}`,
    ...(call.durationSeconds === undefined ? [] : [`- Duration: ${call.durationSeconds} s`]),
    ...(call.summary ? ["", "## Summary", "", call.summary] : []),
    "",
    "## Transcript",
    "",
    ...(lines.length === 0 ? ["(nothing was said)"] : lines.map((line) => `**${speaker[line.speaker]}** [${clock(line.at)}]: ${line.text}`)),
    "",
  ].join("\n");
}
