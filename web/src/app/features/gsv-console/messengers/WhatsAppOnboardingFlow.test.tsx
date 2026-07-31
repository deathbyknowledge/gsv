import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  createTestRoot,
  flowStepNodes,
  nodeWithLabel,
} from "./messengerTestHarness";

const mocks = vi.hoisted(() => ({
  consumeLinkCode: vi.fn(),
  currentFlow: null as unknown,
  currentStep: -1,
  pair: vi.fn(),
}));

vi.mock("../connect-flows/ConnectFlowShell", () => ({
  ConnectFlowShell: ({ current, flow }: { current: number; flow: unknown }) => {
    mocks.currentFlow = flow;
    mocks.currentStep = current;
    return null;
  },
}));

vi.mock("../hooks/useConsoleData", () => ({
  useConsumeIdentityLinkCode: () => ({
    isPending: false,
    mutateAsync: mocks.consumeLinkCode,
  }),
}));

vi.mock("../../gsv-shell/unsaved/unsavedGuard", () => ({
  useUnsavedGuard: () => undefined,
  useUnsavedGuardLeave: () => (leave: () => void) => leave(),
}));

vi.mock("./useWhatsAppPairing", () => ({
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
}));

import { WhatsAppOnboardingFlow } from "./WhatsAppOnboardingFlow";

let root: ReturnType<typeof createTestRoot> | null = null;

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) {
    throw new Error("WhatsApp onboarding flow is not mounted");
  }
  return mocks.currentFlow as ConnectFlowDef;
}

function linkStepNodes() {
  return flowStepNodes(currentFlow(), "link");
}

function buttonLabels(): string[] {
  return linkStepNodes()
    .filter((node) => typeof node.props.onClick === "function" && node.props.variant)
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
