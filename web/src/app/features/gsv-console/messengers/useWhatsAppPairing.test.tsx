import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConsoleAdapterAccount } from "../domain/consoleModels";
import { createTestRoot, deferred } from "./messengerTestHarness";
import {
  type WhatsAppPairingDependencies,
  type WhatsAppPairingOutcome,
  useWhatsAppPairing,
} from "./useWhatsAppPairing";

const mocks = vi.hoisted(() => ({
  connectPending: false,
  dataUpdatedAt: 0,
  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
  lastStatusOptions: null as Parameters<WhatsAppPairingDependencies["useConsoleAdapters"]>[0] | null,
  mutateAsync: vi.fn(),
  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
  statuses: [] as ConsoleAdapterAccount[],
}));

const pairingDependencies: WhatsAppPairingDependencies = {
  useConnectConsoleAdapter: () => ({
    isPending: mocks.connectPending,
    mutateAsync: mocks.mutateAsync,
  }),
  useConsoleAdapters: (options) => {
    mocks.lastStatusOptions = options;
    return {
      adapters: mocks.statuses,
      dataUpdatedAt: mocks.dataUpdatedAt,
    };
  },
};

const NOW = 1_800_000_000_000;

type PairingProps = Parameters<typeof useWhatsAppPairing>[0];
type PairingResult = ReturnType<typeof useWhatsAppPairing>;

function challengeResult(
  accountId: string,
  data: string,
  expiresAt = NOW + 30_000,
): ConnectConsoleAdapterResult {
  return {
    ok: true,
    adapter: "whatsapp",
    accountId,
    connected: false,
    authenticated: false,
    challenge: {
      type: "qr",
      data,
      format: "raw",
      expiresAt,
    },
  };
}

function connectedAccount(accountId: string): ConsoleAdapterAccount {
  return {
    adapter: "whatsapp",
    accountId,
    connected: true,
    authenticated: true,
    mode: "websocket",
    lastActivity: NOW,
    error: "",
    extra: { selfE164: "+31612345678" },
  };
}

let root: ReturnType<typeof createTestRoot> | null = null;
let pairing: PairingResult | null = null;

function Harness(props: PairingProps) {
  pairing = useWhatsAppPairing(props, pairingDependencies);
  return null;
}

function currentPairing(): PairingResult {
  if (!pairing) {
    throw new Error("WhatsApp pairing hook is not mounted");
  }
  return pairing;
}

async function renderPairing(props: PairingProps): Promise<void> {
  root ??= createTestRoot("The hook harness");
  await root.render(<Harness {...props} />);
}

async function unmountPairing(): Promise<void> {
  await root?.unmount();
  root = null;
  pairing = null;
}

const defaultProps: PairingProps = {
  accountId: "default",
  forceRelink: false,
  pairScreenActive: true,
  reconnectExisting: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", globalThis);
  mocks.connectPending = false;
  mocks.dataUpdatedAt = 0;
  mocks.lastStatusOptions = null;
  mocks.mutateAsync.mockReset();
  mocks.statuses = [];
  root = null;
  pairing = null;
});

afterEach(async () => {
  await unmountPairing();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWhatsAppPairing", () => {
  it("ignores a stale result after switching accounts", async () => {
    const first = deferred<ConnectConsoleAdapterResult>();
    mocks.mutateAsync
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(challengeResult("account-2", "second-qr"));
    await renderPairing(defaultProps);

    let firstOutcome!: Promise<WhatsAppPairingOutcome>;
    await act(() => {
      firstOutcome = currentPairing().pair();
    });
    expect(currentPairing().pairingStarted).toBe(true);

    await renderPairing({ ...defaultProps, accountId: "account-2" });
    expect(currentPairing().pairingStarted).toBe(false);
    expect(currentPairing().qrSource).toBeNull();

    first.resolve(challengeResult("default", "stale-qr"));
    let outcome: WhatsAppPairingOutcome | undefined;
    await act(async () => {
      outcome = await firstOutcome;
    });

    expect(outcome).toBe("superseded");
    expect(currentPairing().qrSource).toBeNull();
    await act(async () => {
      outcome = await currentPairing().pair();
    });
    expect(outcome).toBe("challenge");
    expect(currentPairing().qrSource).toEqual({ kind: "raw", value: "second-qr" });
    expect(mocks.mutateAsync).toHaveBeenLastCalledWith({
      adapter: "whatsapp",
      accountId: "account-2",
    });
  });

  it("uses destructive force only for the first relink attempt", async () => {
    mocks.mutateAsync
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(challengeResult("default", "retry-qr"));
    await renderPairing({ ...defaultProps, forceRelink: true });

    let outcome: WhatsAppPairingOutcome | undefined;
    await act(async () => {
      outcome = await currentPairing().pair();
    });
    expect(outcome).toBe("error");
    await act(async () => {
      outcome = await currentPairing().pair();
    });

    expect(outcome).toBe("challenge");
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(1, {
      adapter: "whatsapp",
      accountId: "default",
      config: { force: true },
    });
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(2, {
      adapter: "whatsapp",
      accountId: "default",
    });
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("accepts a fresh polled status as pairing confirmation", async () => {
    mocks.mutateAsync.mockResolvedValueOnce(challengeResult("default", "pairing-qr"));
    await renderPairing(defaultProps);

    await act(async () => {
      await currentPairing().pair();
    });
    expect(mocks.lastStatusOptions).toMatchObject({
      enabled: true,
      refetchInterval: 2_000,
    });

    mocks.statuses = [connectedAccount("default")];
    mocks.dataUpdatedAt = NOW + 1;
    await renderPairing(defaultProps);

    expect(currentPairing().paired).toBe(true);
    expect(currentPairing().pairedPhone).toBe("+31612345678");
    expect(currentPairing().result).toMatchObject({
      accountId: "default",
      connected: true,
      authenticated: true,
    });
    expect(currentPairing().qrSource).toBeNull();
  });

  it("refreshes an expired QR challenge once", async () => {
    const refreshed = deferred<ConnectConsoleAdapterResult>();
    mocks.mutateAsync
      .mockResolvedValueOnce(challengeResult("default", "first-qr", NOW + 1_000))
      .mockReturnValueOnce(refreshed.promise);
    await renderPairing(defaultProps);

    await act(async () => {
      await currentPairing().pair();
    });
    expect(currentPairing().qrSource).toEqual({ kind: "raw", value: "first-qr" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    refreshed.resolve(challengeResult("default", "second-qr", NOW + 30_000));
    await act(async () => {
      await refreshed.promise;
      await Promise.resolve();
    });
    expect(currentPairing().qrSource).toEqual({ kind: "raw", value: "second-qr" });
  });

  it("supersedes a pending request when unmounted", async () => {
    const pending = deferred<ConnectConsoleAdapterResult>();
    mocks.mutateAsync.mockReturnValueOnce(pending.promise);
    await renderPairing(defaultProps);

    let outcomePromise!: Promise<WhatsAppPairingOutcome>;
    await act(() => {
      outcomePromise = currentPairing().pair();
    });
    await unmountPairing();
    pending.resolve(challengeResult("default", "late-qr"));

    let outcome: WhatsAppPairingOutcome | undefined;
    await act(async () => {
      outcome = await outcomePromise;
    });
    expect(outcome).toBe("superseded");
  });

  it("cancels QR expiry timers when unmounted", async () => {
    mocks.mutateAsync.mockResolvedValueOnce(
      challengeResult("default", "expiring-qr", NOW + 1_000),
    );
    await renderPairing(defaultProps);
    await act(async () => {
      await currentPairing().pair();
    });

    await unmountPairing();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
