export type ExtensionRuntimeState = {
  manualReconnectSuppressed: boolean;
};

const RUNTIME_STATE_KEY = "gsvExtensionRuntimeState";

export async function loadRuntimeState(): Promise<ExtensionRuntimeState> {
  const raw = await chrome.storage.local.get(RUNTIME_STATE_KEY);
  // SAFETY: chrome.storage.local returns JSON-compatible values for this key.
  return normalizeRuntimeState(raw[RUNTIME_STATE_KEY] as ExtensionBoundaryValue);
}

export async function saveRuntimeState(state: ExtensionRuntimeState): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_STATE_KEY]: normalizeRuntimeState(state) });
}

function normalizeRuntimeState(value: ExtensionBoundaryValue): ExtensionRuntimeState {
  // SAFETY: chrome.storage values are JSON-like records at this persistence boundary.
  const record = value && !Array.isArray(value) && Object(value) === value
    ? value as { [key: string]: ExtensionBoundaryValue }
    : {};
  return {
    manualReconnectSuppressed: record.manualReconnectSuppressed === true,
  };
}
