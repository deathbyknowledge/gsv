import type { GSVClient } from "@humansandmachines/gsv/client";
import { z } from "zod";
import type {
  OnboardingDetailStep,
  OnboardingAssistMessage,
  OnboardingAssistPatch,
  OnboardingDraft,
  OnboardingLane,
  OnboardingMode,
  OnboardingStage,
} from "@humansandmachines/gsv/protocol";
import { readInstallationOnboardingToken } from "./installationOnboarding";

const STORAGE_ONBOARDING = "gsv.ui.onboarding.v2";

const onboardingMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
const onboardingDraftSchema = z.object({
  lane: z.enum(["quick", "customize", "advanced"]).optional(),
  mode: z.enum(["manual", "guided"]).optional(),
  stage: z.enum(["welcome", "details", "review"]).optional(),
  detailStep: z.enum(["account", "admin", "system", "ai", "device"]).optional(),
  account: z.object({ username: z.string().optional(), agentName: z.string().optional(), password: z.string().optional(), passwordConfirm: z.string().optional() }).optional(),
  admin: z.object({ mode: z.enum(["same", "custom"]).optional(), password: z.string().optional(), passwordConfirm: z.string().optional() }).optional(),
  system: z.object({ timezone: z.string().optional() }).optional(),
  ai: z.object({ enabled: z.boolean().optional(), provider: z.string().optional(), model: z.string().optional(), apiKey: z.string().optional() }).optional(),
  device: z.object({ enabled: z.boolean().optional(), deviceId: z.string().optional(), label: z.string().optional(), expiryDays: z.string().optional() }).optional(),
});
const persistedSnapshotSchema = z.object({
  draft: onboardingDraftSchema.optional(),
  messages: z.array(onboardingMessageSchema).optional(),
  error: z.string().nullable().optional(),
  focus: z.string().nullable().optional(),
  reviewReady: z.boolean().optional(),
});

export type OnboardingSnapshot = {
  draft: OnboardingDraft;
  messages: OnboardingAssistMessage[];
  busy: boolean;
  error: string | null;
  focus: string | null;
  reviewReady: boolean;
};

export type OnboardingService = {
  snapshot: () => OnboardingSnapshot;
  subscribe: (listener: (snapshot: OnboardingSnapshot) => void) => () => void;
  reset: (username?: string) => void;
  setLane: (lane: OnboardingLane) => void;
  setMode: (mode: OnboardingMode) => void;
  setStage: (stage: OnboardingStage) => void;
  setDetailStep: (step: OnboardingDetailStep) => void;
  replaceDraft: (draft: OnboardingDraft) => void;
  updateDraft: (updater: (draft: OnboardingDraft) => OnboardingDraft) => void;
  assist: (message: string) => Promise<void>;
};

export type OnboardingClient = Pick<GSVClient, "requestOnce">;

function deriveGatewayUrlFromOrigin(): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultDraft(username = ""): OnboardingDraft {
  return {
    lane: "quick",
    mode: "manual",
    stage: "welcome",
    detailStep: "account",
    account: {
      username,
      agentName: "",
      password: "",
      passwordConfirm: "",
    },
    admin: {
      mode: "same",
      password: "",
      passwordConfirm: "",
    },
    system: {
      timezone: defaultTimezone(),
    },
    ai: {
      enabled: false,
      provider: "",
      model: "",
      apiKey: "",
    },
    device: {
      enabled: false,
      deviceId: "",
      label: "",
      expiryDays: "",
    },
  };
}

function sanitizeDraftForStorage(draft: OnboardingDraft): OnboardingDraft {
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

function mergeDraft(
  username: string,
  draft: z.infer<typeof onboardingDraftSchema> | null | undefined,
): OnboardingDraft {
  const base = defaultDraft(username);
  return {
    ...base,
    ...draft,
    account: {
      ...base.account,
      ...draft?.account,
    },
    admin: {
      ...base.admin,
      ...draft?.admin,
    },
    system: {
      ...base.system,
      ...draft?.system,
    },
    ai: {
      ...base.ai,
      ...draft?.ai,
    },
    device: {
      ...base.device,
      ...draft?.device,
    },
  };
}

function readPersistedDraft(username = ""): OnboardingSnapshot {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_ONBOARDING);
    if (!raw) {
      return {
        draft: defaultDraft(username),
        messages: [],
        busy: false,
        error: null,
        focus: null,
        reviewReady: false,
      };
    }
    const decoded: unknown = JSON.parse(raw);
    const parsed = persistedSnapshotSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error("Invalid persisted onboarding state");
    }
    return {
      draft: mergeDraft(username, parsed.data.draft),
      messages: parsed.data.messages ?? [],
      busy: false,
      error: parsed.data.error ?? null,
      focus: parsed.data.focus ?? null,
      reviewReady: parsed.data.reviewReady === true,
    };
  } catch {
    return {
      draft: defaultDraft(username),
      messages: [],
      busy: false,
      error: null,
      focus: null,
      reviewReady: false,
    };
  }
}

function persist(snapshot: OnboardingSnapshot): void {
  try {
    window.sessionStorage.setItem(STORAGE_ONBOARDING, JSON.stringify({
      draft: sanitizeDraftForStorage(snapshot.draft),
      messages: snapshot.messages,
      error: snapshot.error,
      focus: snapshot.focus,
      reviewReady: snapshot.reviewReady,
    }));
  } catch {
    // Ignore persistence failures.
  }
}

function isDetailStep(value: string | null | undefined): value is OnboardingDetailStep {
  return value === "account" ||
    value === "admin" ||
    value === "system" ||
    value === "ai" ||
    value === "device";
}

function detailStepFromPatchPath(path: OnboardingAssistPatch["path"]): OnboardingDetailStep {
  if (path.startsWith("account.")) return "account";
  if (path.startsWith("admin.")) return "admin";
  if (path.startsWith("system.")) return "system";
  if (path.startsWith("ai.")) return "ai";
  return "device";
}

export function createOnboardingService(
  client: OnboardingClient,
  initialUsername = "",
): OnboardingService {
  const listeners = new Set<(snapshot: OnboardingSnapshot) => void>();
  let state = readPersistedDraft(initialUsername);

  const emit = (): void => {
    persist(state);
    for (const listener of listeners) {
      listener(state);
    }
  };

  const setState = (next: OnboardingSnapshot): void => {
    state = next;
    emit();
  };

  const applyPatch = (draft: OnboardingDraft, patch: OnboardingAssistPatch): OnboardingDraft => {
    const next = structuredClone(draft);
    const textValue = z.string().safeParse(patch.value);
    const booleanValue = z.boolean().safeParse(patch.value);
    const text = textValue.success ? textValue.data : String(patch.value ?? "");
    const enabled = booleanValue.success ? booleanValue.data : false;
    switch (patch.path) {
      case "account.username": next.account.username = patch.op === "clear" ? "" : text; break;
      case "account.agentName": next.account.agentName = patch.op === "clear" ? "" : text; break;
      case "admin.mode": next.admin.mode = patch.op === "clear" ? "same" : (text === "custom" ? "custom" : "same"); break;
      case "system.timezone": next.system.timezone = patch.op === "clear" ? defaultTimezone() : text; break;
      case "ai.enabled": next.ai.enabled = patch.op === "clear" ? false : enabled; break;
      case "ai.provider": next.ai.provider = patch.op === "clear" ? "" : text; break;
      case "ai.model": next.ai.model = patch.op === "clear" ? "" : text; break;
      case "device.enabled": next.device.enabled = patch.op === "clear" ? false : enabled; break;
      case "device.deviceId": next.device.deviceId = patch.op === "clear" ? "" : text; break;
      case "device.label": next.device.label = patch.op === "clear" ? "" : text; break;
      case "device.expiryDays": next.device.expiryDays = patch.op === "clear" ? "" : text; break;
    }
    return next;
  };

  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: (username = "") => {
      setState({
        draft: defaultDraft(username),
        messages: [],
        busy: false,
        error: null,
        focus: null,
        reviewReady: false,
      });
    },
    setLane: (lane) => {
      setState({
        ...state,
        draft: {
          ...state.draft,
          lane,
          mode: "manual",
          stage: "details",
          detailStep: "account",
        },
        error: null,
        focus: null,
        reviewReady: false,
      });
    },
    setMode: (mode) => {
      setState({
        ...state,
        draft: {
          ...state.draft,
          mode,
        },
        error: null,
        focus: null,
        reviewReady: false,
      });
    },
    setStage: (stage) => {
      setState({
        ...state,
        draft: {
          ...state.draft,
          stage,
        },
        error: null,
      });
    },
    setDetailStep: (detailStep) => {
      setState({
        ...state,
        draft: {
          ...state.draft,
          detailStep,
        },
        error: null,
      });
    },
    replaceDraft: (draft) => {
      setState({
        ...state,
        draft,
        error: null,
        focus: null,
        reviewReady: false,
      });
    },
    updateDraft: (updater) => {
      setState({
        ...state,
        draft: updater(state.draft),
        error: null,
        focus: null,
        reviewReady: false,
      });
    },
    assist: async (message) => {
      const trimmed = message.trim();
      if (!trimmed) return;

      const url = deriveGatewayUrlFromOrigin();
      const currentState = state;
      const userMessage: OnboardingAssistMessage = { role: "user", content: trimmed };
      const nextMessages = [...currentState.messages, userMessage];
      setState({
        ...currentState,
        busy: true,
        error: null,
        focus: null,
        messages: nextMessages,
      });

      try {
        const onboardingToken = readInstallationOnboardingToken();
        const result = await client.requestOnce(url, "sys.setup.assist", {
          lane: currentState.draft.lane,
          draft: sanitizeDraftForStorage(currentState.draft),
          messages: nextMessages,
          ...(onboardingToken ? { onboardingToken } : undefined),
        });
        const latestState = state;
        let nextDraft = latestState.draft;
        for (const patch of result.patches) {
          nextDraft = applyPatch(nextDraft, patch);
        }
        if (isDetailStep(result.focus)) {
          nextDraft = {
            ...nextDraft,
            detailStep: result.focus,
          };
        } else if (result.patches.length > 0) {
          nextDraft = {
            ...nextDraft,
            detailStep: detailStepFromPatchPath(result.patches[0]!.path),
          };
        }
        const settledMessages = latestState.messages.length >= nextMessages.length
          ? latestState.messages
          : nextMessages;
        setState({
          draft: nextDraft,
          busy: false,
          error: null,
          focus: result.focus ?? null,
          reviewReady: result.reviewReady,
          messages: [...settledMessages, { role: "assistant", content: result.message }],
        });
      } catch (error) {
        setState({
          ...currentState,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          messages: nextMessages,
        });
      }
    },
  };
}
