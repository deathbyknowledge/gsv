import type {
  AdapterAccount,
  AdapterConnectChallenge,
  AdapterKind,
  AdaptersState,
  AdapterMutationResult,
} from "../app/types";

function normalizeAdapter(value: unknown): AdapterKind {
  return value === "discord" ? "discord" : "whatsapp";
}

function normalizeAccount(value: unknown): AdapterAccount {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    accountId: typeof raw.accountId === "string" ? raw.accountId : "unknown",
    connected: raw.connected === true,
    authenticated: raw.authenticated === true,
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    lastActivity: typeof raw.lastActivity === "number" ? raw.lastActivity : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    extra: raw.extra && typeof raw.extra === "object" ? (raw.extra as Record<string, unknown>) : undefined,
  };
}

function normalizeChallenge(value: unknown): AdapterConnectChallenge | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== "string" || !raw.type.trim()) {
    return undefined;
  }
  return {
    type: raw.type,
    message: typeof raw.message === "string" ? raw.message : undefined,
    data: typeof raw.data === "string" ? raw.data : undefined,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    extra: raw.extra && typeof raw.extra === "object" ? (raw.extra as Record<string, unknown>) : undefined,
  };
}

async function loadAdapterStatus(kernel: any, adapter: AdapterKind): Promise<AdapterAccount[]> {
  const result = await kernel.request("adapter.status", { adapter });
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  return accounts.map(normalizeAccount);
}

export async function loadState(kernel: any): Promise<AdaptersState> {
  const [whatsapp, discord] = await Promise.all([
    loadAdapterStatus(kernel, "whatsapp"),
    loadAdapterStatus(kernel, "discord"),
  ]);
  return {
    statusByAdapter: {
      whatsapp,
      discord,
    },
  };
}

export async function connectAccount(kernel: any, args: any): Promise<AdapterMutationResult> {
  const adapter = normalizeAdapter(args?.adapter);
  const accountId = String(args?.accountId ?? "").trim();
  if (!accountId) {
    return {
      ok: false,
      adapter,
      accountId: "",
      statusText: "Account name is required.",
      error: "Account name is required.",
    };
  }
  const result = await kernel.request("adapter.connect", {
    adapter,
    accountId,
    config: args?.config && typeof args.config === "object" ? args.config : undefined,
  });
  if (result?.ok !== true) {
    return {
      ok: false,
      adapter,
      accountId,
      statusText: typeof result?.error === "string" ? result.error : `Failed to connect ${adapter}.`,
      error: typeof result?.error === "string" ? result.error : `Failed to connect ${adapter}.`,
      challenge: normalizeChallenge(result?.challenge),
    };
  }
  const challenge = normalizeChallenge(result.challenge);
  return {
    ok: true,
    adapter,
    accountId,
    connected: result.connected === true,
    authenticated: result.authenticated === true,
    challenge,
    statusText: challenge
      ? challenge.message || `Continue the ${adapter} pairing flow for ${accountId}.`
      : typeof result.message === "string" && result.message.trim()
        ? result.message.trim()
        : `${accountId} is now connected to ${adapter}.`,
  };
}

export async function disconnectAccount(kernel: any, args: any): Promise<AdapterMutationResult> {
  const adapter = normalizeAdapter(args?.adapter);
  const accountId = String(args?.accountId ?? "").trim();
  if (!accountId) {
    return {
      ok: false,
      adapter,
      accountId: "",
      statusText: "Account name is required.",
      error: "Account name is required.",
    };
  }
  const result = await kernel.request("adapter.disconnect", {
    adapter,
    accountId,
  });
  if (result?.ok !== true) {
    return {
      ok: false,
      adapter,
      accountId,
      statusText: typeof result?.error === "string" ? result.error : `Failed to disconnect ${accountId}.`,
      error: typeof result?.error === "string" ? result.error : `Failed to disconnect ${accountId}.`,
    };
  }
  return {
    ok: true,
    adapter,
    accountId,
    statusText: typeof result.message === "string" && result.message.trim()
      ? result.message.trim()
      : `${accountId} was disconnected from ${adapter}.`,
  };
}
