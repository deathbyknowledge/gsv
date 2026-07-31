import type { ComponentChildren, VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectFlowDef, ConnectNav } from "../connect-flows/connectFlowTypes";

const mocks = vi.hoisted(() => ({
  consumeLinkCode: vi.fn(),
  currentFlow: null as unknown,
  currentStep: -1,
  pair: vi.fn(),
}));

vi.mock("../connect-flows/ConnectFlowShell", () => ({
  ConnectFlowShell: ({
    current,
    flow,
  }: {
    current: number;
    flow: unknown;
  }) => {
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

type TestNodeProps = {
  children?: ComponentChildren;
  disabled?: boolean;
  label?: string;
  onChange?: (value: string) => void;
  onClick?: () => void;
  value?: string;
  variant?: string;
};

const unusedNav: ConnectNav = {
  onBack: () => undefined,
  onNext: () => undefined,
  goTo: () => undefined,
  isFirst: false,
  isLast: true,
};

function fakeContainer(): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error("The onboarding harness must not render DOM nodes");
    },
    removeChild: () => {
      throw new Error("The onboarding harness must not render DOM nodes");
    },
  } as unknown as Element;
}

function currentFlow(): ConnectFlowDef {
  if (!mocks.currentFlow) {
    throw new Error("WhatsApp onboarding flow is not mounted");
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

function linkStepNodes(): Array<VNode<TestNodeProps>> {
  const linkStep = currentFlow().steps.find((step) => step.key === "link");
  if (!linkStep) {
    throw new Error("WhatsApp onboarding flow has no identity-link step");
  }
  return collectNodes(linkStep.render(unusedNav));
}

function buttonLabels(nodes: Array<VNode<TestNodeProps>>): string[] {
  return nodes
    .filter((node) => typeof node.props.onClick === "function" && node.props.variant)
    .map((node) => node.props.label ?? "");
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

async function renderFlow(): Promise<void> {
  container = fakeContainer();
  await act(() => {
    render(
      <WhatsAppOnboardingFlow
        onBack={() => undefined}
        onConnected={() => undefined}
      />,
      container!,
    );
  });
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

describe("WhatsAppOnboardingFlow identity linking", () => {
  it("keeps paired but unlinked accounts in the wizard", async () => {
    await renderFlow();

    expect(mocks.currentStep).toBe(2);
    expect(buttonLabels(linkStepNodes())).toEqual(["BACK", "LINK USER"]);
  });

  it("shows account completion actions after successful code consumption", async () => {
    await renderFlow();

    let nodes = linkStepNodes();
    await act(() => {
      nodeWithLabel(nodes, "AUTHORIZATION CODE").props.onChange?.("ABC123");
    });

    nodes = linkStepNodes();
    expect(nodeWithLabel(nodes, "LINK USER").props.disabled).toBe(false);
    await act(async () => {
      nodeWithLabel(nodes, "LINK USER").props.onClick?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.consumeLinkCode).toHaveBeenCalledWith({ code: "ABC123" });
    expect(buttonLabels(linkStepNodes())).toEqual(["VIEW ACCOUNT", "DONE"]);
  });
});
