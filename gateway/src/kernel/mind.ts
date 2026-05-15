import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import type { ProcMindDeliverResult } from "../syscalls/proc";
import type { KernelContext } from "./context";
import {
  LOCAL_PROCESS_AUTHORITY,
  processAuthorityKey,
  type ProcessAuthority,
} from "./authority";

const MIND_PROCESS_HASH_BYTES = 16;

export type MindEventInput = {
  identity: ProcessIdentity;
  source: string;
  threadKey: string;
  title?: string;
  text?: string;
  body?: unknown;
  metadata?: Record<string, unknown>;
  includeStructuredData?: boolean;
  authority?: ProcessAuthority;
};

export type MindEventResult =
  | {
      ok: true;
      pid: string;
      conversationId: string;
      runId: string;
      queued?: boolean;
    }
  | { ok: false; error: string };

export async function dispatchMindEvent(
  ctx: KernelContext,
  input: MindEventInput,
): Promise<MindEventResult> {
  const authority = input.authority ?? LOCAL_PROCESS_AUTHORITY;
  const pid = await mindPid(input.identity.uid, input.source, input.threadKey, authority);
  const conversationId = mindConversationId(input.source, input.threadKey);
  const existing = ctx.procs.get(pid);
  const shouldSpawn = !existing || existing.state !== "running";
  const label = input.title?.trim()
    ? `Mind: ${input.title.trim().slice(0, 80)}`
    : `Mind: ${input.source}`;

  if (shouldSpawn) {
    const parent = ctx.procs.ensureInit(input.identity);
    ctx.procs.spawn(pid, input.identity, {
      parentPid: parent.pid,
      profile: "mind",
      label,
      cwd: authority.kind === "remote-social" ? authority.sandboxRoot : input.identity.cwd,
      workspaceId: input.identity.workspaceId,
      authority,
    });

    const setIdentityFrame: RequestFrame<"proc.setidentity"> = {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: {
        pid,
        identity: input.identity,
        profile: "mind",
      },
    };
    const setIdentity = await sendFrameToProcess(pid, setIdentityFrame);
    const setIdentityError = responseError(setIdentity);
    if (setIdentityError) {
      return { ok: false, error: setIdentityError };
    }
  }

  const frame: RequestFrame<"proc.mind.deliver"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.mind.deliver",
    args: {
      pid,
      conversationId,
      message: renderMindEvent(input),
    },
  };
  const delivered = await sendFrameToProcess(pid, frame);
  const deliveredError = responseError(delivered);
  if (deliveredError) {
    return { ok: false, error: deliveredError };
  }

  const result = delivered && delivered.type === "res" && delivered.ok
    ? delivered.data as ProcMindDeliverResult | undefined
    : undefined;
  if (!result?.ok) {
    return {
      ok: false,
      error: result && "error" in result ? result.error : "Mind process did not accept event",
    };
  }

  return {
    ok: true,
    pid,
    conversationId: result.conversationId,
    runId: result.runId,
    ...(result.queued ? { queued: true } : {}),
  };
}

function renderMindEvent(input: MindEventInput): string {
  const lines = [
    `Source: ${input.source}`,
    `Thread: ${input.threadKey}`,
  ];
  if (input.title?.trim()) {
    lines.push(`Title: ${input.title.trim()}`);
  }
  if (input.text?.trim()) {
    lines.push("", input.text.trim());
  }
  if (input.includeStructuredData !== false) {
    const structured = compactObject({
      body: input.body,
      metadata: input.metadata,
    });
    if (Object.keys(structured).length > 0) {
      lines.push("", "Structured event data:", JSON.stringify(structured, null, 2));
    }
  }
  return lines.join("\n");
}

async function mindPid(
  uid: number,
  source: string,
  threadKey: string,
  authority: ProcessAuthority,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${processAuthorityKey(authority)}\n${source}\n${threadKey}`),
  );
  const bytes = [...new Uint8Array(digest)].slice(0, MIND_PROCESS_HASH_BYTES);
  return `mind:${uid}:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mindConversationId(source: string, threadKey: string): string {
  return `mind:${source}:${threadKey}`.replace(/\s+/g, "-").slice(0, 240);
}

function responseError(response: unknown): string | null {
  if (!response || typeof response !== "object" || (response as { type?: unknown }).type !== "res") {
    return null;
  }
  const res = response as ResponseFrame;
  return res.ok ? null : res.error.message;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
