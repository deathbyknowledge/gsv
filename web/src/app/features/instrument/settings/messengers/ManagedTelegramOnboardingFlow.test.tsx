import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../../../../components/connect-flow/connectFlowTypes";
import type { ConsoleIdentityLink } from "../../../../domain/system/consoleModels";
import type { ConsoleAdapterPairingLink } from "../../../../services/system/consoleService";
import {
  collectText,
  createTestRoot,
  flowStepNodes,
  nodeWithLabel,
} from "../../../../testing/testHarness";
import { LinkQrCode } from "./LinkQrCode";
import { ManagedTelegramOnboardingFlow, type ManagedTelegramDependencies } from "./ManagedTelegramOnboardingFlow";

type Disconnect = ReturnType<ManagedTelegramDependencies["useDisconnectConsoleAdapterPairing"]>["mutateAsync"];

const mocks = vi.hoisted(() => ({
  create: vi.fn<(adapter: string) => Promise<ConsoleAdapterPairingLink>>(),
  // SAFETY: the harness initializes this slot before a test reads the mounted flow.
  currentFlow: null as ConnectFlowDef | null,
  currentStep: -1,
  disconnect: vi.fn<Disconnect>(),
  inspect: vi.fn(),
  confirm: vi.fn(),
  onConnected: vi.fn<(detailId: string) => void>(),
  refresh: vi.fn<() => void>(),
}));

const dependencies: ManagedTelegramDependencies = {
  useConsoleAdapterPairingInfo: () => ({
    data: {
      adapter: "telegram",
      accountId: "managed",
      configured: true,
      botUsername: "official_gsv_bot",
      pairingLinks: true,
      setupUrl: "https://ship.example/chat/settings?section=messengers&messenger=telegram",
    },
    isError: false,
    error: null,
  }),
  useCreateConsoleAdapterPairingLink: () => ({ isPending: false, mutateAsync: mocks.create }),
  useDisconnectConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: mocks.disconnect }),
  useInspectConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: mocks.inspect }),
  useConfirmConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: mocks.confirm }),
  useUnsavedGuard: () => undefined,
  ConnectFlowShell: ({ current, flow }) => {
    mocks.currentFlow = flow;
    mocks.currentStep = current;
    return null;
  },
};

let root: ReturnType<typeof createTestRoot> | null = null;
let issuedAt = 0;

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) throw new Error("Flow is not mounted");
  return mocks.currentFlow;
}

function nodes() {
  return flowStepNodes(currentFlow(), mocks.currentStep);
}

/**
 * Lets the requests a render or a click started answer. An answer that lands between two acts
 * re-renders on Preact's own schedule, whose effects wait on a timer, so fake time moves past it.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(50);
  });
}

async function click(label: string): Promise<void> {
  const node = nodeWithLabel(nodes(), label);
  await act(async () => {
    await node.props.onClick?.();
  });
  await settle();
}

async function mount(links: ConsoleIdentityLink[] = [], disabled = false): Promise<void> {
  root ??= createTestRoot("Managed Telegram onboarding harness");
  await root.render(
    <ManagedTelegramOnboardingFlow
      onBack={() => undefined}
      onConnected={mocks.onConnected}
      disabled={disabled}
      dependencies={dependencies}
      links={links}
      onRefreshLinks={mocks.refresh}
    />,
  );
  await settle();
}

function telegramLink(linkedAt: number | undefined): ConsoleIdentityLink {
  const link: ConsoleIdentityLink = {
    adapter: "telegram",
    accountId: "managed",
    actorId: "12345",
    uid: 1000,
    createdAt: 1,
    linkedByUid: 1000,
    actorName: "Hank Human",
    actorHandle: "@hank",
  };
  if (linkedAt !== undefined) link.linkedAt = linkedAt;
  return link;
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  for (const mock of [mocks.create, mocks.disconnect, mocks.inspect, mocks.confirm, mocks.onConnected, mocks.refresh]) mock.mockReset();
  issuedAt = 1_700_000_000_000;
  mocks.create.mockImplementation(async () => {
    issuedAt += 60_000;
    return {
      adapter: "telegram",
      code: "ABCD-EFGH-JKLM",
      url: "https://t.me/official_gsv_bot?start=ABCDEFGHJKLM",
      createdAt: issuedAt,
      expiresAt: issuedAt + 600_000,
    };
  });
  mocks.disconnect.mockResolvedValue({ disconnected: true });
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ManagedTelegramOnboardingFlow", () => {
  it("makes a single-use link on open and never asks for a token or a code", async () => {
    await mount();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith("telegram");
    expect(currentFlow().title).toBe("Connect Telegram");
    expect(mocks.currentStep).toBe(0);
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    const everything = collectText(currentFlow().steps.flatMap((step) => step.render({} as never)));
    expect(everything).not.toContain("BotFather");
    expect(nodes().some((node) => node.props.label === "ACCESS TOKEN" || node.props.label === "TELEGRAM CODE")).toBe(false);

    const open = nodeWithLabel(nodes(), "OPEN TELEGRAM");
    expect(open.props.href).toBe("https://t.me/official_gsv_bot?start=ABCDEFGHJKLM");
    expect(open.props.variant).toBe("primary");
    expect(open.props.disabled).toBe(false);
    expect(nodes().find((node) => node.type === LinkQrCode)?.props).toMatchObject({
      url: "https://t.me/official_gsv_bot?start=ABCDEFGHJKLM",
      label: "QR code that opens Telegram with your one-time code",
    });
    expect(collectText(nodes())).toContain("You can also send ABCD-EFGH-JKLM to @official_gsv_bot in Telegram.");
    expect(collectText(nodes())).toContain("Waiting for your message. This link works once, for 10 minutes.");
  });

  it("moves on once the Kernel reports the account this link connected, and names it", async () => {
    await mount();
    // A connection older than this link is someone's earlier one, not the answer to it.
    await mount([telegramLink(issuedAt - 1)]);
    expect(mocks.currentStep).toBe(0);
    await mount([telegramLink(undefined)]);
    expect(mocks.currentStep).toBe(0);

    await mount([telegramLink(issuedAt + 5_000)]);
    expect(mocks.currentStep).toBe(1);
    expect(nodeWithLabel(nodes(), "Hank Human").props.sub).toBe("@hank · Telegram ID 12345");
    expect(nodes().some((node) => node.props.text?.includes("Hank Human now reaches your Ship"))).toBe(true);
    await click("VIEW TELEGRAM");
    expect(mocks.onConnected).toHaveBeenCalledWith("telegram:managed");
  });

  it("looks for the connection while it waits, and offers a new link once this one expires", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(collectText(nodes())).toContain("This link expired. Make a new one to connect.");
    expect(nodes().some((node) => node.props.label === "OPEN TELEGRAM")).toBe(false);
    const calls = mocks.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(calls);

    await click("MAKE A NEW LINK");
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(nodeWithLabel(nodes(), "OPEN TELEGRAM").props.href).toBe("https://t.me/official_gsv_bot?start=ABCDEFGHJKLM");
  });

  it("disconnects an account that is not the person's, then makes a new link", async () => {
    await mount();
    const linked = telegramLink(issuedAt + 5_000);
    await mount([linked]);
    await click("DISCONNECT");
    expect(mocks.disconnect).toHaveBeenCalledWith({ adapter: "telegram", accountId: "managed", actorId: "12345" });
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    // The old connection is older than the new link, so the flow waits again even before the list refreshes.
    expect(mocks.currentStep).toBe(0);
    expect(nodeWithLabel(nodes(), "OPEN TELEGRAM").props.disabled).toBe(false);
  });

  it("shows why a link could not be made and lets the person try again", async () => {
    mocks.create.mockRejectedValueOnce(new Error("Telegram is not available right now."));
    await mount();
    expect(nodes().some((node) => node.props.variant === "error" && node.props.text === "Telegram is not available right now.")).toBe(true);
    expect(nodes().some((node) => node.props.label === "OPEN TELEGRAM")).toBe(false);
    await click("MAKE A NEW LINK");
    expect(nodes().some((node) => node.props.variant === "error")).toBe(false);
    expect(nodeWithLabel(nodes(), "OPEN TELEGRAM").props.disabled).toBe(false);
  });

  it("makes no link while the host suspends pairing", async () => {
    await mount([], true);
    expect(mocks.create).not.toHaveBeenCalled();
    const open = nodeWithLabel(nodes(), "OPEN TELEGRAM");
    expect(open.props.disabled).toBe(true);
    expect(open.props.href).toBeUndefined();
  });
});
