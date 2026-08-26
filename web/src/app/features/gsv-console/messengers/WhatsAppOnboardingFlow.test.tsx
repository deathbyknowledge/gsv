import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  createTestRoot,
  flowStepNodes,
  nodeWithLabel,
} from "./messengerTestHarness";
import { WhatsAppOnboardingFlow, type WhatsAppOnboardingDependencies } from "./WhatsAppOnboardingFlow";

const mocks = vi.hoisted(() => ({
  consumeLinkCode: vi.fn(),
  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
  currentFlow: null as ConnectFlowDef | null,
  currentStep: -1,
  pair: vi.fn(),
}));

const dependencies: WhatsAppOnboardingDependencies = {
  ConnectFlowShell: ({ current, flow }: { current: number; flow: ConnectFlowDef }) => {
    mocks.currentFlow = flow;
    mocks.currentStep = current;
    return null;
  },
  useConsumeIdentityLinkCode: () => ({
    isPending: false,
    mutateAsync: mocks.consumeLinkCode,
  }),
  useUnsavedGuard: () => undefined,
  useUnsavedGuardLeave: () => (leave: () => void) => leave(),
  useWhatsAppPairing: () => ({
    error: "",
    isPending: false,
    liveAccount: null,
    pair: mocks.pair,
    paired: true,
    pairedPhone: "+31612345678",
    pairingStarted: true,
    qrSource: null,
    result: {
      ok: true,
      adapter: "whatsapp",
      accountId: "default",
      connected: true,
      authenticated: true,
    },
    secondsRemaining: 0,
  }),
};

let root: ReturnType<typeof createTestRoot> | null = null;

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) {
    throw new Error("WhatsApp onboarding flow is not mounted");
  }
  return mocks.currentFlow;
}

function linkStepNodes() {
  return flowStepNodes(currentFlow(), "link");
}

function buttonLabels(): string[] {
  return linkStepNodes()
    .filter((node) => node.props.onClick && node.props.variant)
    .map((node) => node.props.label ?? "");
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.consumeLinkCode.mockReset();
  mocks.consumeLinkCode.mockResolvedValue({
    linked: true,
    link: {
      adapter: "whatsapp",
      accountId: "default",
      actorId: "31600000000@s.whatsapp.net",
      uid: 0,
      createdAt: 1_800_000_000_000,
      linkedByUid: 0,
    },
  });
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  mocks.pair.mockReset();
  root = null;
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("WhatsAppOnboardingFlow identity linking", () => {
  it("keeps paired accounts in finalization until code consumption succeeds", async () => {
    root = createTestRoot("The onboarding harness");
    await root.render(
      <WhatsAppOnboardingFlow
        onBack={() => undefined}
        onConnected={() => undefined}
        dependencies={dependencies}
      />,
    );

    expect(mocks.currentStep).toBe(2);
    expect(buttonLabels()).toEqual(["BACK", "LINK USER"]);

    await act(() => {
      nodeWithLabel(linkStepNodes(), "AUTHORIZATION CODE").props.onChange?.("ABC123");
    });
    expect(nodeWithLabel(linkStepNodes(), "LINK USER").props.disabled).toBe(false);
    await act(async () => {
      nodeWithLabel(linkStepNodes(), "LINK USER").props.onClick?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.consumeLinkCode).toHaveBeenCalledWith({ code: "ABC123" });
    expect(buttonLabels()).toEqual(["VIEW ACCOUNT", "DONE"]);
  });
});
