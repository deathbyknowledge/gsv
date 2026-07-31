import type { ComponentChildren, VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConnectFlowDef, ConnectNav } from "../connect-flows/connectFlowTypes";
import type {
  ConsoleAdapter,
  ConsoleResourceState,
} from "../domain/consoleModels";

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

type TestNodeProps = {
  children?: ComponentChildren;
  disabled?: boolean;
  label?: string;
  message?: string;
  onChange?: (value: string) => void;
  onClick?: () => void | Promise<void>;
  status?: string;
  value?: string;
  variant?: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const unusedNav: ConnectNav = {
  onBack: () => undefined,
  onNext: () => undefined,
  goTo: () => undefined,
  isFirst: false,
  isLast: false,
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function availableAdapter(adapter: string): ConsoleAdapter {
  return {
    adapter,
    available: true,
    supportsConnect: true,
    supportsDisconnect: true,
    supportsSend: true,
    supportsStatus: true,
    supportsActivity: true,
    accounts: [],
  };
}

function fakeContainer(): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error("The onboarding switch harness must not render DOM nodes");
    },
    removeChild: () => {
      throw new Error("The onboarding switch harness must not render DOM nodes");
    },
  } as unknown as Element;
}

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) {
    throw new Error("The messenger onboarding flow is not mounted");
  }
  return mocks.currentFlow as ConnectFlowDef;
}

function collectNodes(value: ComponentChildren): Array<VNode<TestNodeProps>> {
  const nodes: Array<VNode<TestNodeProps>> = [];
  const visit = (child: ComponentChildren): void => {
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (!child || typeof child !== "object" || !("props" in child)) {
      return;
    }
    const node = child as VNode<TestNodeProps>;
    nodes.push(node);
    visit(node.props.children);
  };
  visit(value);
  return nodes;
}

function currentStepNodes(): Array<VNode<TestNodeProps>> {
  const step = currentFlow().steps[mocks.currentStep];
  if (!step) {
    throw new Error(`The messenger onboarding flow has no step ${mocks.currentStep}`);
  }
  return collectNodes(step.render(unusedNav));
}

function nodeWithLabel(
  nodes: Array<VNode<TestNodeProps>>,
  label: string,
): VNode<TestNodeProps> {
  const node = nodes.find((candidate) => candidate.props.label === label);
  if (!node) {
    throw new Error(`Could not find ${label}`);
  }
  return node;
}

let container: Element | null = null;

async function renderPage(initialDetailId: string): Promise<void> {
  if (!container) {
    container = fakeContainer();
  }
  await act(() => {
    render(<MessengersPage initialDetailId={initialDetailId} />, container!);
  });
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
    availableAdapter("discord"),
    availableAdapter("telegram"),
  ];
  container = null;
});

afterEach(async () => {
  if (container) {
    await act(() => {
      render(null, container!);
    });
  }
  container = null;
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

    const connect = nodeWithLabel(nodes, "CONNECT");
    let pendingSubmit: Promise<void> | undefined;
    await act(() => {
      pendingSubmit = connect.props.onClick?.() as Promise<void> | undefined;
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
