import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  MessengerOnboardingFlow,
  type MessengerOnboardingDependencies,
} from "./MessengerOnboardingFlow";
import {
  collectText,
  createTestRoot,
  deferred,
  flowStepNodes,
  nodeWithLabel,
  unusedConnectNav,
} from "./messengerTestHarness";

type OnboardingTestState = {
  currentFlow: ConnectFlowDef | null;
  currentStep: number;
};

const connectAdapter = vi.fn<() => Promise<ConnectConsoleAdapterResult>>();
const consumeLinkCode = vi.fn(async () => ({ linked: false, link: null }));
const state: OnboardingTestState = {
  currentFlow: null,
  currentStep: -1,
};

function testDependencies(): MessengerOnboardingDependencies {
  return {
    ConnectFlowShell: ({ current, flow }) => {
      state.currentFlow = flow;
      state.currentStep = current;
      return <></>;
    },
    useConnectAdapter: () => ({
      isPending: false,
      mutateAsync: connectAdapter,
    }),
    useConsumeLinkCode: () => ({
      isPending: false,
      mutateAsync: consumeLinkCode,
    }),
    useUnsavedGuard: () => undefined,
    useUnsavedGuardLeave: () => (leave) => leave(),
  };
}

let root: ReturnType<typeof createTestRoot> | null = null;

function currentFlow(): ConnectFlowDef {
  if (!state.currentFlow) {
    throw new Error("The messenger onboarding flow is not mounted");
  }
  return state.currentFlow;
}

function currentStepNodes() {
  return flowStepNodes(currentFlow(), state.currentStep);
}

async function renderFlow(adapterId: string): Promise<void> {
  root ??= createTestRoot("The onboarding switch harness");
  await root.render(
    <MessengerOnboardingFlow
      key={adapterId}
      adapterId={adapterId}
      dependencies={testDependencies()}
      onBack={() => undefined}
      onConnected={() => undefined}
    />,
  );
}

async function clickStepButton(label: string): Promise<void> {
  const button = nodeWithLabel(currentStepNodes(), label);
  expect(button.props.disabled).not.toBe(true);
  await act(() => button.props.onClick?.());
}

async function reachConnectStep(): Promise<void> {
  await clickStepButton("NEXT");
  await clickStepButton("NEXT");
  expect(state.currentStep).toBe(2);
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  connectAdapter.mockReset();
  consumeLinkCode.mockClear();
  state.currentFlow = null;
  state.currentStep = -1;
  root = null;
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("messenger onboarding platform switches", () => {
  it("connects standalone Slack with its bot and Socket Mode tokens", async () => {
    connectAdapter.mockResolvedValue({
      ok: true,
      adapter: "slack",
      accountId: "default",
      connected: true,
      authenticated: true,
    });
    await renderFlow("slack");
    expect(currentFlow().title).toBe("Connect Slack app");
    expect(collectText(currentFlow().steps[0]!.render(unusedConnectNav))).toContain(
      "enable Socket Mode and Interactivity",
    );
    expect(collectText(currentFlow().steps[1]!.render(unusedConnectNav))).toContain(
      "files:read, files:write",
    );
    await reachConnectStep();

    const nodes = currentStepNodes();
    await act(() => {
      nodeWithLabel(nodes, "BOT TOKEN").props.onChange?.("xoxb-private");
      nodeWithLabel(nodes, "APP-LEVEL TOKEN").props.onChange?.("xapp-private");
    });
    await clickStepButton("CONNECT");

    expect(connectAdapter).toHaveBeenCalledWith({
      adapter: "slack",
      accountId: "default",
      config: {
        botToken: "xoxb-private",
        appToken: "xapp-private",
      },
    });
  });

  it("isolates Telegram from a pending Discord connection and form state", async () => {
    const pendingDiscord = deferred<ConnectConsoleAdapterResult>();
    connectAdapter.mockReturnValue(pendingDiscord.promise);
    await renderFlow("discord");
    expect(currentFlow().title).toBe("Connect Discord bot");
    await reachConnectStep();

    let nodes = currentStepNodes();
    await act(() => {
      nodeWithLabel(nodes, "ACCESS TOKEN").props.onChange?.("discord-private-token");
    });
    nodes = currentStepNodes();
    expect(nodeWithLabel(nodes, "ACCESS TOKEN").props.value).toBe("discord-private-token");

    let pendingSubmit: Promise<void> | undefined;
    await act(() => {
      const clicked = nodeWithLabel(nodes, "CONNECT").props.onClick?.();
      if (!(clicked instanceof Promise)) {
        throw new Error("CONNECT did not start an asynchronous submission");
      }
      pendingSubmit = clicked;
    });
    expect(pendingSubmit).toBeInstanceOf(Promise);
    expect(connectAdapter).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "discord",
      config: { botToken: "discord-private-token" },
    }));

    await renderFlow("telegram");

    expect(currentFlow().title).toBe("Connect Telegram bot");
    expect(state.currentStep).toBe(0);
    await reachConnectStep();
    nodes = currentStepNodes();
    expect(nodeWithLabel(nodes, "ACCESS TOKEN").props).toMatchObject({
      message: "",
      status: "none",
      value: "",
    });

    pendingDiscord.resolve({
      ok: true,
      adapter: "discord",
      accountId: "discord-bot",
      connected: true,
      authenticated: true,
    });
    await act(async () => {
      await pendingSubmit;
      await Promise.resolve();
    });

    expect(currentFlow().title).toBe("Connect Telegram bot");
    expect(state.currentStep).toBe(2);
    expect(currentFlow().steps[state.currentStep]?.status).toBe("NOT CONNECTED");
    expect(nodeWithLabel(currentStepNodes(), "ACCESS TOKEN").props.value).toBe("");
  });
});
