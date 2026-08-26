import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  collectText,
  createTestRoot,
  flowStepNodes,
  nodeWithLabel,
} from "./messengerTestHarness";
import { ManagedTelegramOnboardingFlow, type ManagedTelegramDependencies } from "./ManagedTelegramOnboardingFlow";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
  currentFlow: null as ConnectFlowDef | null,
  currentStep: -1,
  inspect: vi.fn(),
}));

const dependencies: ManagedTelegramDependencies = {
  useConsoleAdapterPairingInfo: () => ({
    data: {
      adapter: "telegram",
      accountId: "managed",
      configured: true,
      botUsername: "official_gsv_bot",
    },
    isError: false,
    error: null,
  }),
  useInspectConsoleAdapterPairing: () => ({
    isPending: false,
    mutateAsync: mocks.inspect,
  }),
  useConfirmConsoleAdapterPairing: () => ({
    isPending: false,
    mutateAsync: mocks.confirm,
  }),
  useUnsavedGuard: () => undefined,
  ConnectFlowShell: ({
    current,
    flow,
  }: {
    current: number;
    flow: ConnectFlowDef;
  }) => {
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
  mocks.inspect.mockReset();
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  mocks.inspect.mockResolvedValue({
    adapter: "telegram",
    accountId: "managed",
    actorId: "12345",
    surfaceId: "12345",
    actorName: "Hank Human",
    actorHandle: "@hank",
    expiresAt: Date.now() + 60_000,
    linked: false,
  });
  mocks.confirm.mockResolvedValue({
    paired: true,
    adapter: "telegram",
    accountId: "managed",
    actorId: "12345",
    surfaceId: "12345",
    uid: 1000,
  });
  root = createTestRoot("Managed Telegram onboarding harness");
  await root.render(
    <ManagedTelegramOnboardingFlow onBack={() => undefined} onConnected={() => undefined} dependencies={dependencies} />,
  );
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("ManagedTelegramOnboardingFlow", () => {
  it("starts with the official bot and never asks the user for a BotFather token", async () => {
    expect(currentFlow().title).toBe("Connect Telegram");
    expect(mocks.currentStep).toBe(0);
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    expect(collectText(currentFlow().steps.flatMap((step) => step.render({} as never))))
      .not.toContain("BotFather");
    expect(nodes().some((node) => node.props.label === "ACCESS TOKEN")).toBe(false);
    expect(collectText(nodes())).toContain("OPEN @official_gsv_bot");
  });

  it("reveals the Telegram identity before linking it to Personal", async () => {
    await click("I HAVE A CODE");
    expect(mocks.currentStep).toBe(1);
    await act(() => {
      nodeWithLabel(nodes(), "PAIRING CODE").props.onChange?.("abcd-efgh-jklm");
    });
    await click("CHECK CODE");

    expect(mocks.inspect).toHaveBeenCalledWith({
      adapter: "telegram",
      code: "ABCD-EFGH-JKLM",
    });
    expect(mocks.currentStep).toBe(2);
    expect(nodeWithLabel(nodes(), "@hank").props.sub).toBe("Telegram ID 12345");

    await click("YES, CONNECT THIS IDENTITY");
    expect(mocks.confirm).toHaveBeenCalledWith({
      adapter: "telegram",
      code: "ABCD-EFGH-JKLM",
    });
    expect(mocks.currentStep).toBe(3);
    const success = nodes().find((node) =>
      node.props.text?.includes("personal intelligence")
    );
    expect(success).toBeTruthy();
  });
});
