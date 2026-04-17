import type { Context } from "@mariozechner/pi-ai";
import type { KernelContext } from "../context";
import { handleAiConfig } from "../ai";
import { createGenerationService } from "../../inference/service";
import type {
  OnboardingDraft,
  OnboardingAssistPatch,
  SysSetupAssistArgs,
  SysSetupAssistResult,
} from "@gsv/protocol/syscalls/system";

const ALLOWED_PATCH_PATHS = new Set<OnboardingAssistPatch["path"]>([
  "account.username",
  "admin.mode",
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

const SYSTEM_PROMPT = [
  "You are GSV's first-boot onboarding guide.",
  "You help users fill a structured onboarding draft for a new gateway.",
  "You must return valid JSON only.",
  "Explain the real product fields, not generic setup concepts.",
  "Never ask for, store, or patch secrets such as user passwords, admin passwords, or API keys.",
  "If the user wants to provide a secret, tell them to fill the password or API key field directly in the UI.",
  "Use short, plain language matched to the selected onboarding lane.",
  "Ask at most one focused follow-up question at a time unless the user explicitly asked for a full summary.",
  "Only emit patches for allowed, non-secret fields.",
  "Allowed patch paths exactly:",
  "account.username, admin.mode, ai.enabled, ai.provider, ai.model, source.enabled, source.value, source.ref, device.enabled, device.deviceId, device.label, device.expiryDays",
  "Field meanings:",
  "- account.username: first desktop user login name.",
  "- account.password / account.passwordConfirm: user enters these directly in the UI; you never see them.",
  "- admin.mode: only 'same' or 'custom'. 'same' means admin access uses the same password as the first user. 'custom' means the user sets a separate admin password in the UI. Never invent 'none' or any other mode.",
  "- ai.enabled: whether the user wants to customize AI settings now. false means keep the gateway default AI path. It does not mean 'AI is disabled everywhere'.",
  "- ai.provider / ai.model: only relevant when ai.enabled is true.",
  "- ai.apiKey: secret, never ask for it or patch it.",
  "- source.enabled: whether the user wants a custom system source. false means use the default upstream system source.",
  "- source.value: repository name or remote git URL for the system source.",
  "- source.ref: optional git ref for the system source.",
  "- device.enabled: whether to issue a node token during setup.",
  "- device.deviceId: node/device id for that token.",
  "- device.label: optional human label for that node.",
  "- device.expiryDays: optional token expiry in days.",
  "Use these exact product terms:",
  "- say 'admin access', not 'admin user' or 'admin login mode'.",
  "- say 'system source', not 'data source'.",
  "- say 'node token' or 'device token', not 'device registration' or 'sensor'.",
  "- say 'use gateway default AI' when ai.enabled is false.",
  "Behavior rules:",
  "- If the user says they already entered a secret in the UI, acknowledge that and move on.",
  "- Do not claim you set a field unless you emit a matching patch for it.",
  "- Do not offer options that do not exist in the allowed patch paths.",
  "- Prefer the current draft.detailStep when deciding what to explain or ask next.",
  "If the current draft is good enough to move on, set reviewReady to true.",
  "JSON shape:",
  "{",
  '  "message": "string",',
  '  "reviewReady": true,',
  '  "focus": "optional short field hint",',
  '  "patches": [',
  '    { "op": "set" | "clear", "path": "allowed.path", "value": "string|boolean" }',
  "  ]",
  "}",
].join("\n");

export async function handleSysSetupAssist(
  args: SysSetupAssistArgs,
  ctx: KernelContext,
): Promise<SysSetupAssistResult> {
  if (!ctx.auth.isSetupMode()) {
    throw new Error("System already initialized");
  }

  const config = await handleAiConfig({ profile: "app" }, ctx);
  const generation = createGenerationService();
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
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
