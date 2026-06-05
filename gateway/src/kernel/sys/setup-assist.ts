import type { Context } from "@earendil-works/pi-ai";
import type { KernelContext } from "../context";
import { handleAiConfig } from "../ai";
import { createGenerationService } from "../../inference/service";
import type {
  OnboardingDraft,
  OnboardingAssistPatch,
  SysSetupAssistArgs,
  SysSetupAssistResult,
} from "@gsv/protocol/syscalls/system";
import { SETUP_ASSIST_SYSTEM_PROMPT } from "../../prompts/setup-assist";

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

export async function handleSysSetupAssist(
  args: SysSetupAssistArgs,
  ctx: KernelContext,
): Promise<SysSetupAssistResult> {
  if (!ctx.auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const config = await handleAiConfig({}, ctx);
  const generation = createGenerationService();
  const context: Context = {
    systemPrompt: SETUP_ASSIST_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          lane: args.lane,
          draft: redactDraft(args.draft),
          messages: args.messages.slice(-8),
        }, null, 2),
        timestamp: Date.now(),
      },
    ],
  };

  const raw = await generation.generateText({
    purpose: "mcp.analysis",
    config,
    context,
    sessionAffinityKey: "setup-assist",
  });

  return parseAssistResponse(raw);
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

  return [{
    op,
    path,
    value: typeof record.value === "number" ? String(record.value) : record.value,
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
