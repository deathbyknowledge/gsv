import type { GatewayClient } from "./gateway-client";
import type {
  OnboardingDetailStep,
  OnboardingAssistMessage,
  OnboardingAssistPatch,
  OnboardingDraft,
  OnboardingLane,
  OnboardingMode,
  OnboardingStage,
} from "@gsv/protocol/syscalls/system";

const STORAGE_ONBOARDING = "gsv.ui.onboarding.v1";

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

function deriveGatewayUrlFromOrigin(): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws`;
}

function defaultDraft(username = ""): OnboardingDraft {
  return {
    lane: "quick",
    mode: "guided",
    stage: "welcome",
    detailStep: "account",
    account: {
      username,
      password: "",
      passwordConfirm: "",
    },
    admin: {
      mode: "same",
      password: "",
    },
    ai: {
      enabled: false,
      provider: "",
      model: "",
      apiKey: "",
    },
    source: {
      enabled: false,
      value: "",
      ref: "",
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
    },
    ai: {
      ...draft.ai,
      apiKey: "",
    },
  };
}

function mergeDraft(username: string, draft: Partial<OnboardingDraft> | null | undefined): OnboardingDraft {
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
    ai: {
      ...base.ai,
      ...draft?.ai,
    },
    source: {
      ...base.source,
      ...draft?.source,
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
    const parsed = JSON.parse(raw) as Partial<OnboardingSnapshot>;
    return {
      draft: mergeDraft(username, parsed.draft),
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.filter((entry): entry is OnboardingAssistMessage =>
          Boolean(entry) &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).role !== undefined &&
          typeof (entry as Record<string, unknown>).content === "string",
        )
        : [],
      busy: false,
      error: typeof parsed.error === "string" ? parsed.error : null,
      focus: typeof parsed.focus === "string" ? parsed.focus : null,
      reviewReady: parsed.reviewReady === true,
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
    value === "ai" ||
    value === "source" ||
    value === "device";
}

function detailStepFromPatchPath(path: OnboardingAssistPatch["path"]): OnboardingDetailStep {
  if (path.startsWith("account.")) return "account";
  if (path.startsWith("admin.")) return "admin";
  if (path.startsWith("ai.")) return "ai";
  if (path.startsWith("source.")) return "source";
  return "device";
}

export function createOnboardingService(
  client: GatewayClient,
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
    const next = structuredClone(draft) as OnboardingDraft;
    const [section, key] = patch.path.split(".") as [keyof OnboardingDraft, string];
    if (!(section in next)) return draft;
    if (patch.op === "clear") {
      if (section === "ai" || section === "source" || section === "device") {
        (next[section] as Record<string, unknown>)[key] = key === "enabled" ? false : "";
      } else if (section === "admin") {
        (next.admin as Record<string, unknown>)[key] = key === "mode" ? "same" : "";
      } else if (section === "account" && key === "username") {
        next.account.username = "";
      }
      return next;
    }
    (next[section] as Record<string, unknown>)[key] = patch.value;
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
      const mode: OnboardingMode = lane === "advanced" ? "manual" : lane === "quick" ? "guided" : state.draft.mode;
      setState({
        ...state,
        draft: {
          ...state.draft,
          lane,
          mode,
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
        const result = await client.setupAssist(url, {
          lane: currentState.draft.lane,
          draft: sanitizeDraftForStorage(currentState.draft),
          messages: nextMessages,
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
