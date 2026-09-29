import type { KernelContext } from "../context";
import { handleAiTextGenerate } from "../ai";
import type {
  OnboardingDraft,
  OnboardingAssistPatch,
  SysSetupAssistArgs,
  SysSetupAssistResult,
} from "@humansandmachines/gsv/protocol";
import { SETUP_ASSIST_SYSTEM_PROMPT } from "../../prompts/setup-assist";
import { z } from "zod";

const ALLOWED_PATCH_PATHS = new Set<OnboardingAssistPatch["path"]>([
  "account.username",
  "account.agentName",
  "admin.mode",
  "system.timezone",
  "ai.enabled",
  "ai.provider",
  "ai.model",
  "device.enabled",
  "device.deviceId",
  "device.label",
  "device.expiryDays",
]);
const setupPatchPathSchema = z.enum([
  "account.username", "account.agentName", "admin.mode", "system.timezone",
  "ai.enabled", "ai.provider", "ai.model", "device.enabled", "device.deviceId",
  "device.label", "device.expiryDays",
]);
const setupPatchSchema = z.object({
  op: z.enum(["set", "clear"]),
  path: setupPatchPathSchema,
  value: z.union([z.string(), z.boolean(), z.number()]).optional(),
});
const setupAssistResponseSchema = z.object({
  message: z.string().optional(),
  reviewReady: z.boolean().optional(),
  focus: z.string().optional(),
  patches: z.array(z.unknown()).optional(),
});
const setupWireSchema = z.unknown();
type SetupWireValue = z.input<typeof setupWireSchema>;

export async function handleSysSetupAssist(
  args: SysSetupAssistArgs,
  ctx: KernelContext,
): Promise<SysSetupAssistResult> {
  if (!ctx.auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const result = await handleAiTextGenerate({
    systemPrompt: SETUP_ASSIST_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: JSON.stringify({
        lane: args.lane,
        draft: redactDraft(args.draft),
        messages: args.messages.slice(-8),
      }, null, 2),
      timestamp: Date.now(),
    }],
    sessionAffinityKey: "setup-assist",
  }, ctx);

  if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
    throw new Error(result.message.errorMessage || `Setup assist generation ended with ${result.message.stopReason}`);
  }

  return parseAssistResponse(result.text ?? "");
}

function parseAssistResponse(raw: string): SysSetupAssistResult {
  const candidate = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Setup assist returned invalid JSON");
  }

  const record = setupAssistResponseSchema.safeParse(parsed);
  if (!record.success) throw new Error("Setup assist returned invalid payload");
  const message = record.data.message?.trim()
    ? record.data.message.trim()
    : "I need one more detail before you continue.";
  const reviewReady = record.data.reviewReady === true;
  const focus = record.data.focus?.trim() ? record.data.focus.trim() : undefined;
  const patches = record.data.patches
    ? record.data.patches.flatMap(parsePatch)
    : [];

  return { message, reviewReady, focus, patches };
}

function parsePatch(value: SetupWireValue): OnboardingAssistPatch[] {
  const parsed = setupPatchSchema.safeParse(value);
  if (!parsed.success || !ALLOWED_PATCH_PATHS.has(parsed.data.path)) return [];
  const { op, path } = parsed.data;

  if (op === "clear") {
    return [{ op, path }];
  }

  if (parsed.data.value === undefined) {
    return [];
  }

  const numericValue = z.number().safeParse(parsed.data.value);
  const stringValue = z.string().safeParse(parsed.data.value);
  const booleanValue = z.boolean().safeParse(parsed.data.value);
  return [{
    op,
    path,
    value: numericValue.success
      ? String(numericValue.data)
      : stringValue.success
        ? stringValue.data
        : booleanValue.data,
  }];
}

function redactDraft(draft: OnboardingDraft): OnboardingDraft {
  return {
    ...draft,
    account: {
      ...draft.account,
      password: "",
      passwordConfirm: "",
    },
    admin: {
      ...draft.admin,
      password: "",
      passwordConfirm: "",
    },
    ai: {
      ...draft.ai,
      apiKey: "",
    },
  };
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
