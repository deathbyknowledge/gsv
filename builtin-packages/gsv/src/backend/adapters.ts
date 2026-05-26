import type {
  AdapterAccount,
  AdapterConnectChallenge,
  AdapterKind,
  AdapterMutationResult,
  AdaptersState,
  ConnectAdapterArgs,
  DisconnectAdapterArgs,
} from "../app/features/integrations/types";

type KernelClientLike = {
  request(method: string, payload?: unknown): Promise<unknown>;
};

function normalizeAdapter(value: unknown): AdapterKind {
  if (value === "discord") return "discord";
  if (value === "telegram") return "telegram";
  return "whatsapp";
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

async function loadAdapterStatus(kernel: KernelClientLike, adapter: AdapterKind): Promise<AdapterAccount[]> {
  const result = await kernel.request("adapter.status", { adapter });
  const raw = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  return accounts.map(normalizeAccount);
}

export async function loadAdaptersState(kernel: KernelClientLike): Promise<AdaptersState> {
  const [whatsapp, discord, telegram] = await Promise.all([
    loadAdapterStatus(kernel, "whatsapp"),
    loadAdapterStatus(kernel, "discord"),
    loadAdapterStatus(kernel, "telegram"),
  ]);
  return {
    statusByAdapter: {
      whatsapp,
      discord,
      telegram,
    },
  };
}

export async function connectAdapter(kernel: KernelClientLike, args: ConnectAdapterArgs): Promise<AdapterMutationResult> {
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
  const raw = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (raw.ok !== true) {
    const error = typeof raw.error === "string" ? raw.error : `Failed to connect ${adapter}.`;
    return {
      ok: false,
      adapter,
      accountId,
      statusText: error,
      error,
      challenge: normalizeChallenge(raw.challenge),
    };
  }

  const challenge = normalizeChallenge(raw.challenge);
  return {
    ok: true,
    adapter,
    accountId,
    connected: raw.connected === true,
    authenticated: raw.authenticated === true,
    challenge,
    statusText: challenge
      ? challenge.message || `Continue the ${adapter} pairing flow for ${accountId}.`
      : typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : `${accountId} is now connected to ${adapter}.`,
  };
}

export async function disconnectAdapter(
  kernel: KernelClientLike,
  args: DisconnectAdapterArgs,
): Promise<AdapterMutationResult> {
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
  const raw = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (raw.ok !== true) {
    const error = typeof raw.error === "string" ? raw.error : `Failed to disconnect ${accountId}.`;
    return {
      ok: false,
      adapter,
      accountId,
      statusText: error,
      error,
    };
  }

  return {
    ok: true,
    adapter,
    accountId,
    statusText: typeof raw.message === "string" && raw.message.trim()
      ? raw.message.trim()
      : `${accountId} was disconnected from ${adapter}.`,
  };
}
