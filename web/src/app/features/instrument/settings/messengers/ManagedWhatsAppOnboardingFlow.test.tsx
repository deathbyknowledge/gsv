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
import {
  ManagedWhatsAppOnboardingFlow,
  type ManagedTelegramDependencies,
} from "./ManagedTelegramOnboardingFlow";

const LINK_URL = "https://wa.me/34600000000?text=Connect%20my%20Ship%20ABCD-EFGH-JKLM";

const mocks = vi.hoisted(() => ({
  create: vi.fn<(adapter: string) => Promise<ConsoleAdapterPairingLink>>(),
  // SAFETY: the harness initializes this slot before a test reads the mounted flow.
  currentFlow: null as ConnectFlowDef | null,
  currentStep: -1,
  infoAdapter: "",
  onConnected: vi.fn<(detailId: string) => void>(),
  unreachableCallingCodes: ["55", "62"],
}));

const dependencies: ManagedTelegramDependencies = {
  useConsoleAdapterPairingInfo: (adapter) => {
    mocks.infoAdapter = adapter;
    return {
      data: {
        adapter: "whatsapp",
        accountId: "managed",
        configured: true,
        installUrl: "https://wa.me/34600000000",
        unreachableCallingCodes: mocks.unreachableCallingCodes,
        pairingLinks: true,
        setupUrl: "https://ship.example/chat/settings?section=messengers&messenger=whatsapp",
      },
      isError: false,
      error: null,
    };
  },
  useCreateConsoleAdapterPairingLink: () => ({ isPending: false, mutateAsync: mocks.create }),
  useDisconnectConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useInspectConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useConfirmConsoleAdapterPairing: () => ({ isPending: false, mutateAsync: vi.fn() }),
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

async function mount({ links = [], disabled = false }: { links?: ConsoleIdentityLink[]; disabled?: boolean } = {}): Promise<void> {
  root ??= createTestRoot("Managed WhatsApp onboarding harness");
  await root.render(
    <ManagedWhatsAppOnboardingFlow
      onBack={() => undefined}
      onConnected={mocks.onConnected}
      disabled={disabled}
      dependencies={dependencies}
      links={links}
    />,
  );
  await settle();
}

async function remount(options?: { links?: ConsoleIdentityLink[]; disabled?: boolean }): Promise<void> {
  await root?.unmount();
  root = null;
  await mount(options);
}

/** The account the person's message connected, as `sys.link.list` reports it. */
function connected(fields: Partial<ConsoleIdentityLink>): ConsoleIdentityLink {
  return { adapter: "whatsapp", accountId: "managed", actorId: "34611111189", uid: 1000, createdAt: 1, linkedByUid: 1000, linkedAt: issuedAt + 5_000, ...fields };
}

beforeEach(async () => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { languages: ["pt-BR", "id"] });
  mocks.create.mockReset();
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  mocks.infoAdapter = "";
  mocks.unreachableCallingCodes = ["55", "62"];
  mocks.onConnected.mockReset();
  issuedAt = 1_700_000_000_000;
  mocks.create.mockImplementation(async () => {
    issuedAt += 60_000;
    return { adapter: "whatsapp", code: "ABCD-EFGH-JKLM", url: LINK_URL, createdAt: issuedAt, expiresAt: issuedAt + 600_000 };
  });
  await mount();
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("ManagedWhatsAppOnboardingFlow", () => {
  it("opens WhatsApp on the operator's number with a one-time code and never asks for credentials or a code", () => {
    expect(mocks.infoAdapter).toBe("whatsapp");
    expect(mocks.create).toHaveBeenCalledWith("whatsapp");
    expect(currentFlow().title).toBe("Connect WhatsApp");
    const allNodes = currentFlow().steps.flatMap((step) => flowStepNodes(currentFlow(), step.key));
    expect(allNodes.some((node) => node.props.label === "ACCESS TOKEN" || node.props.label === "WHATSAPP CODE")).toBe(false);
    const instructions = nodes().find((node) => node.props.text?.includes("Clicking \"Open WhatsApp\""));
    expect(instructions?.props.text).toBe(
      "Clicking \"Open WhatsApp\" opens a message to Ship with your one-time code. Send it, and this page connects on its own.",
    );
    expect(collectText(nodes())).toContain("You can also send ABCD-EFGH-JKLM to +34600000000 in WhatsApp.");
    const open = nodeWithLabel(nodes(), "OPEN WHATSAPP");
    expect(open.props.href).toBe(LINK_URL);
    expect(open.props.variant).toBe("primary");
  });

  it("makes no link and disables opening WhatsApp while the host suspends pairing", async () => {
    mocks.create.mockClear();
    await remount({ disabled: true });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(nodeWithLabel(nodes(), "OPEN WHATSAPP").props.disabled).toBe(true);
  });

  it("folds the countries the number cannot reach behind their flags, whatever the device's language", async () => {
    const note = () => {
      const text = collectText(nodes());
      return text.includes("can't connect") ? text : undefined;
    };
    const withCodes = async (codes: string[]) => {
      mocks.unreachableCallingCodes = codes;
      await remount();
    };
    vi.stubGlobal("navigator", { languages: ["en-US", "es-ES"] });
    await remount();
    expect(note()).toContain("🇧🇷 🇮🇩 WhatsApp numbers from Brazil (+55) and Indonesia (+62) can't connect: Meta blocks them.");
    const flags = nodes().find((node) => node.type === "summary" && node.props["aria-label"] === "Countries this WhatsApp number can't reach");
    expect(collectText(flags?.props.children)).toBe("🇧🇷 🇮🇩");
    expect(nodes().some((node) => node.props.variant === "warning")).toBe(false);

    await withCodes(["62"]);
    expect(note()).toContain("🇮🇩 WhatsApp numbers from Indonesia (+62) can't connect");
    expect(note()).not.toContain("Brazil");

    await withCodes([]);
    expect(note()).toBeUndefined();
  });

  it("says that a number already talking to another Ship is asked there before it moves", () => {
    expect(collectText(nodes())).toContain(
      "Already talking to another Ship from this WhatsApp account? Ship asks you there before moving it here.",
    );
  });

  it("names the account by profile name and masked number once it connects, then opens its detail", async () => {
    await mount({ links: [connected({ actorName: "Hank Human", actorHandle: "+34•••••••89" })] });
    expect(mocks.currentStep).toBe(1);
    expect(nodeWithLabel(nodes(), "Hank Human").props.sub).toBe("WhatsApp number +34•••••••89");
    expect(collectText(nodes())).not.toContain("34611111189");
    const done = nodeWithLabel(nodes(), "VIEW WHATSAPP");
    await act(async () => {
      await done.props.onClick?.();
    });
    expect(mocks.onConnected).toHaveBeenCalledWith("whatsapp:managed");
  });

  it("names a username sender by username when WhatsApp keeps their number private", async () => {
    await mount({
      links: [connected({ actorId: "US.13491208655302741918", actorName: "Sheena Nelson", actorHandle: "@realsheenanelson" })],
    });
    expect(nodeWithLabel(nodes(), "Sheena Nelson").props.sub).toBe("WhatsApp username @realsheenanelson");
    expect(collectText(nodes())).not.toContain("WhatsApp number");
    expect(collectText(nodes())).not.toContain("US.13491208655302741918");
  });
});
