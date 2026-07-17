import type { KernelContext } from "../context";
import { handleAiTextGenerate } from "../ai";
import type {
  OnboardingDraft,
  OnboardingAssistPatch,
  SysSetupAssistArgs,
  SysSetupAssistResult,
} from "@humansandmachines/gsv/protocol";
import { SETUP_ASSIST_SYSTEM_PROMPT } from "../../prompts/setup-assist";
import { authorizeSetupToken } from "../../auth/setup-token";
import {
  assertSafeBootstrapSource,
  assertSafeBootstrapText,
} from "./bootstrap-source";

const ALLOWED_PATCH_PATHS = new Set<OnboardingAssistPatch["path"]>([
  "account.username",
  "account.agentName",
  "admin.mode",
  "system.timezone",
  "ai.enabled",
  "ai.provider",
  "ai.model",
  "source.enabled",
  "source.value",
  "source.ref",
  "device.enabled",
  "device.deviceId",
  "device.label",
  "device.expiryDays",
]);
const MAX_ASSIST_MESSAGE_BYTES = 4 * 1024;
const MAX_ASSIST_MESSAGES = 128;
const MAX_ASSIST_PROMPT_BYTES = 32 * 1024;
const MAX_DRAFT_FIELD_BYTES = 2 * 1024;

export async function handleSysSetupAssist(
  args: SysSetupAssistArgs,
  ctx: KernelContext,
): Promise<SysSetupAssistResult> {
  if (!ctx.auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  await authorizeSetupToken(
    ctx.env,
    args.setupToken,
    Date.now(),
    ctx.managedSetupTokenPolicy,
  );
  const input = parseAssistInput(args);
  ctx.consumeSetupAssistAllowance();

  const result = await handleAiTextGenerate({
    systemPrompt: SETUP_ASSIST_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: input.prompt,
      timestamp: Date.now(),
    }],
    sessionAffinityKey: "setup-assist",
  }, ctx);

  if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
    throw new Error(result.message.errorMessage || `Setup assist generation ended with ${result.message.stopReason}`);
  }

  return parseAssistResponse(result.text ?? "");
}

function parseAssistInput(args: SysSetupAssistArgs): { prompt: string } {
  const record = asRecord(args);
  const lane = record?.lane;
  if (lane !== "quick" && lane !== "customize" && lane !== "advanced") {
    throw new Error("Invalid setup assistance request");
  }
  const draft = sanitizeDraft(record?.draft);
  if (!Array.isArray(record?.messages) || record.messages.length > MAX_ASSIST_MESSAGES) {
    throw new Error("Invalid setup assistance request");
  }
  const messages = record.messages.slice(-8).map((value) => {
    const message = asRecord(value);
    if (
      (message?.role !== "user" && message?.role !== "assistant")
      || typeof message.content !== "string"
      || byteLength(message.content) > MAX_ASSIST_MESSAGE_BYTES
    ) {
      throw new Error("Invalid setup assistance request");
    }
    assertSafeBootstrapText(message.content);
    return { role: message.role, content: message.content };
  });
  const prompt = JSON.stringify({ lane, draft, messages }, null, 2);
  if (byteLength(prompt) > MAX_ASSIST_PROMPT_BYTES) {
    throw new Error("Invalid setup assistance request");
  }
  return { prompt };
}

function parseAssistResponse(raw: string): SysSetupAssistResult {
  const candidate = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Setup assist returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Setup assist returned invalid payload");
  }

  const record = parsed as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : "I need one more detail before you continue.";
  const reviewReady = record.reviewReady === true;
  const focus = typeof record.focus === "string" && record.focus.trim() ? record.focus.trim() : undefined;
  const patches = Array.isArray(record.patches)
    ? record.patches.flatMap(parsePatch)
    : [];

  return { message, reviewReady, focus, patches };
}

function parsePatch(value: unknown): OnboardingAssistPatch[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const op = record.op === "clear" ? "clear" : record.op === "set" ? "set" : null;
  const path = typeof record.path === "string" ? record.path as OnboardingAssistPatch["path"] : null;
  if (!op || !path || !ALLOWED_PATCH_PATHS.has(path)) return [];

  if (op === "clear") {
    return [{ op, path }];
  }

  if (
    typeof record.value !== "string" &&
    typeof record.value !== "boolean" &&
    typeof record.value !== "number"
  ) {
    return [];
  }
  if (path === "source.value" && typeof record.value === "string") {
    assertSafeBootstrapSource(record.value);
  }

  return [{
    op,
    path,
    value: typeof record.value === "number" ? String(record.value) : record.value,
  }];
}

function sanitizeDraft(value: unknown): OnboardingDraft {
  const draft = requireRecord(value);
  const account = requireRecord(draft.account);
  const admin = requireRecord(draft.admin);
  const system = requireRecord(draft.system);
  const ai = requireRecord(draft.ai);
  const source = requireRecord(draft.source);
  const device = requireRecord(draft.device);
  if (
    !isOneOf(draft.lane, ["quick", "customize", "advanced"])
    || !isOneOf(draft.mode, ["manual", "guided"])
    || !isOneOf(draft.stage, ["welcome", "details", "review"])
    || !isOneOf(draft.detailStep, ["account", "admin", "system", "ai", "source", "device"])
    || !isOneOf(admin.mode, ["same", "custom"])
    || typeof ai.enabled !== "boolean"
    || typeof source.enabled !== "boolean"
    || typeof device.enabled !== "boolean"
  ) {
    throw new Error("Invalid setup assistance request");
  }
  const sourceValue = readDraftString(source.value);
  assertSafeBootstrapSource(sourceValue);
  return {
    lane: draft.lane,
    mode: draft.mode,
    stage: draft.stage,
    detailStep: draft.detailStep,
    account: {
      username: readDraftString(account.username),
      agentName: readDraftString(account.agentName),
      password: "",
      passwordConfirm: "",
    },
    admin: {
      mode: admin.mode,
      password: "",
      passwordConfirm: "",
    },
    system: { timezone: readDraftString(system.timezone) },
    ai: {
      enabled: ai.enabled,
      provider: readDraftString(ai.provider),
      model: readDraftString(ai.model),
      apiKey: "",
    },
    source: {
      enabled: source.enabled,
      value: sourceValue,
      ref: readDraftString(source.ref),
    },
    device: {
      enabled: device.enabled,
      deviceId: readDraftString(device.deviceId),
      label: readDraftString(device.label),
      expiryDays: readDraftString(device.expiryDays),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error("Invalid setup assistance request");
  return record;
}

function readDraftString(value: unknown): string {
  if (typeof value !== "string" || byteLength(value) > MAX_DRAFT_FIELD_BYTES) {
    throw new Error("Invalid setup assistance request");
  }
  return value;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return trimmed;
}
