export type ExtensionRuntimeState = {
  manualReconnectSuppressed: boolean;
};

const RUNTIME_STATE_KEY = "gsvExtensionRuntimeState";

export async function loadRuntimeState(): Promise<ExtensionRuntimeState> {
  const raw = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  return normalizeRuntimeState(raw[RUNTIME_STATE_KEY]);
}

export async function saveRuntimeState(state: ExtensionRuntimeState): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_STATE_KEY]: normalizeRuntimeState(state) });
}

function normalizeRuntimeState(value: unknown): ExtensionRuntimeState {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    manualReconnectSuppressed: record.manualReconnectSuppressed === true,
  };
}
