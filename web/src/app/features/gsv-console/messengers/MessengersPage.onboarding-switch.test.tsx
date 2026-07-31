import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import type {
  ConsoleAdapter,
  ConsoleResourceState,
} from "../domain/consoleModels";
import {
  availableConsoleAdapter,
  createTestRoot,
  deferred,
  flowStepNodes,
  nodeWithLabel,
} from "./messengerTestHarness";

const mocks = vi.hoisted(() => ({
  connectAdapter: vi.fn(),
  consumeLinkCode: vi.fn(),
  currentFlow: null as unknown,
  currentStep: -1,
  inventory: [] as ConsoleAdapter[],
}));

function resource<T>(data: T): ConsoleResourceState<T> {
  return {
    data,
    isUnavailable: false,
    isLoading: false,
    isRefreshing: false,
    isError: false,
    errorText: "",
    isEmpty: false,
  };
}

vi.mock("../hooks/useConsoleData", () => ({
  useConnectConsoleAdapter: () => ({
    isPending: false,
    mutateAsync: mocks.connectAdapter,
  }),
  useConsoleAccounts: () => ({
    accounts: [],
    resource: resource([]),
  }),
  useConsoleAdapterInventory: () => ({
    adapters: mocks.inventory,
    resource: resource(mocks.inventory),
  }),
  useConsoleIdentityLinks: () => ({
    links: [],
    resource: resource([]),
  }),
  useConsumeIdentityLinkCode: () => ({
    isPending: false,
    mutateAsync: mocks.consumeLinkCode,
  }),
  useDisconnectConsoleAdapter: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("../../gsv-shell/unsaved/unsavedGuard", () => ({
  useUnsavedGuard: () => undefined,
  useUnsavedGuardLeave: () => (leave: () => void) => leave(),
}));

vi.mock("../components/ConsolePageTemplate", () => ({
  ConsolePage: ({ children }: { children: ComponentChildren }) => children,
  ConsoleResourceBoundary: <T,>({
    render: renderResource,
    resource: resourceState,
  }: {
    render: (data: T) => ComponentChildren;
    resource: ConsoleResourceState<T>;
  }) => resourceState.data === null ? null : renderResource(resourceState.data),
}));

vi.mock("../card-template/CardListTemplate", () => ({
  CardListTemplate: () => null,
}));

vi.mock("../components/ConsoleDetailPage", () => ({
  ConsoleDetailPage: () => null,
}));

vi.mock("./MessengerDetailPage", () => ({
  MessengerDetailPage: () => null,
}));

vi.mock("./MessengerLinkCodePanel", () => ({
  MessengerLinkCodePanel: () => null,
}));

vi.mock("../connect-flows/ConnectFlowShell", () => ({
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
}));

import { MessengersPage } from "./MessengersPage";

let root: ReturnType<typeof createTestRoot> | null = null;

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) {
    throw new Error("The messenger onboarding flow is not mounted");
  }
  return mocks.currentFlow as ConnectFlowDef;
}

function currentStepNodes() {
  return flowStepNodes(currentFlow(), mocks.currentStep);
}

async function renderPage(initialDetailId: string): Promise<void> {
  root ??= createTestRoot("The onboarding switch harness");
  await root.render(<MessengersPage initialDetailId={initialDetailId} />);
}

async function clickStepButton(label: string): Promise<void> {
  const button = nodeWithLabel(currentStepNodes(), label);
  expect(button.props.disabled).not.toBe(true);
  await act(() => {
    button.props.onClick?.();
  });
}

async function reachConnectStep(): Promise<void> {
  await clickStepButton("NEXT");
  await clickStepButton("NEXT");
  expect(mocks.currentStep).toBe(2);
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.connectAdapter.mockReset();
  mocks.consumeLinkCode.mockReset();
  mocks.currentFlow = null;
  mocks.currentStep = -1;
  mocks.inventory = [
    availableConsoleAdapter("discord"),
    availableConsoleAdapter("telegram"),
  ];
  root = null;
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("MessengersPage onboarding platform switches", () => {
  it("isolates Telegram from a pending Discord connection and form state", async () => {
    const pendingDiscord = deferred<ConnectConsoleAdapterResult>();
    mocks.connectAdapter.mockReturnValue(pendingDiscord.promise);
    await renderPage("discord");
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
      pendingSubmit = nodeWithLabel(nodes, "CONNECT").props.onClick?.() as Promise<void>;
    });
    expect(pendingSubmit).toBeInstanceOf(Promise);
    expect(mocks.connectAdapter).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "discord",
      config: { botToken: "discord-private-token" },
    }));

    await renderPage("telegram");

    expect(currentFlow().title).toBe("Connect Telegram bot");
    expect(mocks.currentStep).toBe(0);
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
    expect(mocks.currentStep).toBe(2);
    expect(currentFlow().steps[mocks.currentStep]?.status).toBe("NOT CONNECTED");
    expect(nodeWithLabel(currentStepNodes(), "ACCESS TOKEN").props.value).toBe("");
  });
});
