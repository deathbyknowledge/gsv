import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConsoleAdapterAccount } from "../domain/consoleModels";

const mocks = vi.hoisted(() => ({
  connectPending: false,
  dataUpdatedAt: 0,
  lastStatusOptions: null as Record<string, unknown> | null,
  mutateAsync: vi.fn(),
  statuses: [] as ConsoleAdapterAccount[],
}));

vi.mock("../hooks/useConsoleData", () => ({
  useConnectConsoleAdapter: () => ({
    isPending: mocks.connectPending,
    mutateAsync: mocks.mutateAsync,
  }),
  useConsoleAdapters: (options: Record<string, unknown>) => {
    mocks.lastStatusOptions = options;
    return {
      adapters: mocks.statuses,
      dataUpdatedAt: mocks.dataUpdatedAt,
    };
  },
}));

import {
  type WhatsAppPairingOutcome,
  useWhatsAppPairing,
} from "./useWhatsAppPairing";

const NOW = 1_800_000_000_000;

type PairingProps = Parameters<typeof useWhatsAppPairing>[0];
type PairingResult = ReturnType<typeof useWhatsAppPairing>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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

function fakeContainer(): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error("The hook harness must not render DOM nodes");
    },
    removeChild: () => {
      throw new Error("The hook harness must not render DOM nodes");
    },
  } as unknown as Element;
}

let container: Element | null = null;
let pairing: PairingResult | null = null;

function Harness(props: PairingProps) {
  pairing = useWhatsAppPairing(props);
  return null;
}

function currentPairing(): PairingResult {
  if (!pairing) {
    throw new Error("WhatsApp pairing hook is not mounted");
  }
  return pairing;
}

async function renderPairing(props: PairingProps): Promise<void> {
  if (!container) {
    container = fakeContainer();
  }
  await act(() => {
    render(<Harness {...props} />, container!);
  });
}

async function unmountPairing(): Promise<void> {
  if (!container) {
    return;
  }
  await act(() => {
    render(null, container!);
  });
  container = null;
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
  container = null;
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
