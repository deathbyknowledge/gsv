import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../../../../components/connect-flow/connectFlowTypes";
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

const mocks = vi.hoisted(() => ({
  confirm: vi.fn<
    ReturnType<ManagedTelegramDependencies["useConfirmConsoleAdapterPairing"]>["mutateAsync"]
  >(),
  // SAFETY: the harness initializes this slot before a test reads the mounted flow.
  currentFlow: null as ConnectFlowDef | null,
  currentStep: -1,
  infoAdapter: "",
  inspect: vi.fn<
    ReturnType<ManagedTelegramDependencies["useInspectConsoleAdapterPairing"]>["mutateAsync"]
  >(),
  onConnected: vi.fn<(detailId: string) => void>(),
}));

const dependencies: ManagedTelegramDependencies = {
  useConsoleAdapterPairingInfo: (adapter) => {
    mocks.infoAdapter = adapter;
    return {
      data: {
        adapter: "whatsapp",
        accountId: "managed",
        configured: true,
        installUrl: "https://wa.me/34600000000?text=%2Flink",
      },
      isError: false,
      error: null,
    };
  },
  useInspectConsoleAdapterPairing: () => ({
    isPending: false,
    mutateAsync: mocks.inspect,
  }),
  useConfirmConsoleAdapterPairing: () => ({
    isPending: false,
    mutateAsync: mocks.confirm,
  }),
  useUnsavedGuard: () => undefined,
  ConnectFlowShell: ({ current, flow }) => {
    mocks.currentFlow = flow;
    mocks.currentStep = current;
    return null;
  },
};

let root: ReturnType<typeof createTestRoot> | null = null;

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) throw new Error("Flow is not mounted");
  return mocks.currentFlow;
}

function nodes() {
  return flowStepNodes(currentFlow(), mocks.currentStep);
}

async function click(label: string): Promise<void> {
  const node = nodeWithLabel(nodes(), label);
  await act(async () => {
    await node.props.onClick?.();
  });
}

beforeEach(async () => {
  vi.stubGlobal("document", {});
  mocks.confirm.mockReset();
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  mocks.infoAdapter = "";
  mocks.inspect.mockReset();
  mocks.onConnected.mockReset();
  mocks.inspect.mockResolvedValue({
    adapter: "whatsapp",
    accountId: "managed",
    actorId: "34611111189",
    surfaceId: "34611111189",
    actorName: "Hank Human",
    actorHandle: "+34•••••••89",
    expiresAt: Date.now() + 60_000,
    linked: false,
  });
  mocks.confirm.mockResolvedValue({
    paired: true,
    adapter: "whatsapp",
    accountId: "managed",
    actorId: "34611111189",
    surfaceId: "34611111189",
    uid: 1000,
  });
  root = createTestRoot("Managed WhatsApp onboarding harness");
  await root.render(
    <ManagedWhatsAppOnboardingFlow
      onBack={() => undefined}
      onConnected={mocks.onConnected}
      dependencies={dependencies}
    />,
  );
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("ManagedWhatsAppOnboardingFlow", () => {
  it("shows the operator's number and opens WhatsApp on it without asking for credentials", () => {
    expect(mocks.infoAdapter).toBe("whatsapp");
    expect(currentFlow().title).toBe("Connect WhatsApp");
    const allNodes = currentFlow().steps.flatMap((step) => flowStepNodes(currentFlow(), step.key));
    expect(allNodes.some((node) => node.props.label === "ACCESS TOKEN")).toBe(false);
    const instructions = nodes().find((node) => node.props.text?.includes("+34600000000"));
    expect(instructions?.props.text).toContain("send /link to get a new code");
    const open = nodes().find((node) => node.props.href === "https://wa.me/34600000000?text=%2Flink");
    expect(collectText(open)).toBe("OPEN WHATSAPP");
  });

  it("reveals the profile name and masked number before linking, then opens the account detail", async () => {
    await click("I HAVE A CODE");
    await act(() => {
      nodeWithLabel(nodes(), "PAIRING CODE").props.onChange?.("abcd-efgh-jklm");
    });
    await click("CHECK CODE");

    expect(mocks.inspect).toHaveBeenCalledWith({
      adapter: "whatsapp",
      code: "ABCD-EFGH-JKLM",
    });
    expect(nodeWithLabel(nodes(), "Hank Human").props.sub).toBe("WhatsApp number +34•••••••89");
    expect(collectText(nodes())).not.toContain("34611111189");

    await click("YES, CONNECT THIS IDENTITY");
    expect(mocks.confirm).toHaveBeenCalledWith({
      adapter: "whatsapp",
      code: "ABCD-EFGH-JKLM",
    });
    await click("VIEW WHATSAPP");
    expect(mocks.onConnected).toHaveBeenCalledWith("whatsapp:managed");
  });
});
