import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  collectText,
  createTestRoot,
  flowStepNodes,
  nodeWithLabel,
} from "./messengerTestHarness";
import {
  ManagedSlackOnboardingFlow,
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
        adapter: "slack",
        accountId: "managed",
        configured: true,
        installUrl: "https://slack.gsv.example/slack/install",
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
    adapter: "slack",
    accountId: "workspace:route-id",
    actorId: "U12345",
    surfaceId: "D12345",
    routeScope: "actor",
    expiresAt: Date.now() + 60_000,
    linked: false,
  });
  mocks.confirm.mockResolvedValue({
    paired: true,
    adapter: "slack",
    accountId: "workspace:route-id",
    actorId: "U12345",
    surfaceId: "D12345",
    uid: 1000,
  });
  root = createTestRoot("Managed Slack onboarding harness");
  await root.render(
    <ManagedSlackOnboardingFlow
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

describe("ManagedSlackOnboardingFlow", () => {
  it("opens the official app install without asking for standalone tokens", () => {
    expect(mocks.infoAdapter).toBe("slack");
    expect(currentFlow().title).toBe("Connect Slack");
    const allNodes = currentFlow().steps.flatMap((step) => flowStepNodes(currentFlow(), step.key));
    expect(allNodes.some((node) => node.props.label === "BOT TOKEN")).toBe(false);
    expect(allNodes.some((node) => node.props.label === "APP-LEVEL TOKEN")).toBe(false);
    const install = nodes().find((node) => (
      node.props.href === "https://slack.gsv.example/slack/install"
    ));
    expect(collectText(install)).toBe("INSTALL GSV IN SLACK");
    expect(install?.props.href)
      .toBe("https://slack.gsv.example/slack/install");
  });

  it("pairs the Slack author and opens the workspace account detail", async () => {
    await click("I HAVE A CODE");
    await act(() => {
      nodeWithLabel(nodes(), "PAIRING CODE").props.onChange?.("abcd-efgh-jklm");
    });
    await click("CHECK CODE");

    expect(mocks.inspect).toHaveBeenCalledWith({
      adapter: "slack",
      code: "ABCD-EFGH-JKLM",
    });
    expect(nodeWithLabel(nodes(), "Slack user U12345").props.sub).toBe("Slack ID U12345");

    await click("YES, CONNECT THIS IDENTITY");
    expect(mocks.confirm).toHaveBeenCalledWith({
      adapter: "slack",
      code: "ABCD-EFGH-JKLM",
    });
    await click("VIEW SLACK");
    expect(mocks.onConnected).toHaveBeenCalledWith("slack:workspace:route-id");
  });
});
