import type { ComponentChild, ComponentChildren, VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ConnectFlowDef, ConnectNav } from "../connect-flows/connectFlowTypes";
import type { ConsoleAdapter, ConsoleAdapterAccount } from "../domain/consoleModels";

export type TestNodeProps = {
  boxed?: boolean;
  children?: ComponentChildren;
  disabled?: boolean;
  label?: string;
  message?: string;
  onChange?: (value: string) => void;
  onClick?: () => void | Promise<void>;
  status?: string;
  tone?: string;
  value?: string;
  variant?: string;
};

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function consoleAdapterAccount(adapter: string, accountId: string): ConsoleAdapterAccount {
  return {
    adapter,
    accountId,
    connected: true,
    authenticated: true,
    mode: adapter === "whatsapp" ? "websocket" : "bot",
    lastActivity: null,
    error: "",
    extra: {},
  };
}

export function availableConsoleAdapter(
  adapter: string,
  accounts: ConsoleAdapterAccount[] = [],
): ConsoleAdapter {
  return {
    adapter,
    available: true,
    supportsConnect: true,
    supportsDisconnect: true,
    supportsSend: true,
    supportsStatus: true,
    supportsActivity: true,
    accounts,
  };
}

function fakeContainer(owner: string): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error(`${owner} must not render DOM nodes`);
    },
    removeChild: () => {
      throw new Error(`${owner} must not render DOM nodes`);
    },
  } as unknown as Element;
}

export function createTestRoot(owner: string) {
  const container = fakeContainer(owner);
  return {
    async render(node: ComponentChild): Promise<void> {
      await act(() => {
        render(node, container);
      });
    },
    async unmount(): Promise<void> {
      await act(() => {
        render(null, container);
      });
    },
  };
}

export const unusedConnectNav: ConnectNav = {
  onBack: () => undefined,
  onNext: () => undefined,
  goTo: () => undefined,
  isFirst: false,
  isLast: false,
};

export function collectNodes(value: ComponentChildren): Array<VNode<TestNodeProps>> {
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

export function collectText(value: ComponentChildren): string {
  if (Array.isArray(value)) {
    return value.map(collectText).filter(Boolean).join(" ");
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return value && typeof value === "object" && "props" in value
    ? collectText((value as VNode<TestNodeProps>).props.children)
    : "";
}

export function nodeWithLabel(
  nodes: Array<VNode<TestNodeProps>>,
  label: string,
): VNode<TestNodeProps> {
  const node = nodes.find((candidate) => candidate.props.label === label);
  if (!node) {
    throw new Error(`Could not find ${label}`);
  }
  return node;
}

export function flowStepNodes(
  flow: ConnectFlowDef,
  step: number | string,
): Array<VNode<TestNodeProps>> {
  const match = typeof step === "number"
    ? flow.steps[step]
    : flow.steps.find((candidate) => candidate.key === step);
  if (!match) {
    throw new Error(`The connect flow has no step ${step}`);
  }
  return collectNodes(match.render(unusedConnectNav));
}
