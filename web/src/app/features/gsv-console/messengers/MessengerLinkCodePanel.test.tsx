import type { ComponentChildren } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PanelSnapshot = {
  button: {
    disabled: boolean;
    label: string;
    onClick: () => void | Promise<void>;
  } | null;
  input: {
    onChange: (value: string) => void;
    value: string;
  } | null;
  notice: {
    label: string;
    tone: string;
  } | null;
  text: string[];
};

const mocks = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
  snapshots: [] as PanelSnapshot[],
}));

function capturePanel(children: ComponentChildren): PanelSnapshot {
  const snapshot: PanelSnapshot = {
    button: null,
    input: null,
    notice: null,
    text: [],
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "string" || typeof value === "number") {
      snapshot.text.push(String(value));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }

    const props = (value as { props?: Record<string, unknown> }).props;
    if (!props) {
      return;
    }
    if (
      props.label === "AUTHORIZATION CODE"
      && typeof props.onChange === "function"
    ) {
      snapshot.input = {
        onChange: props.onChange as (next: string) => void,
        value: typeof props.value === "string" ? props.value : "",
      };
    }
    if (
      props.variant === "success"
      && typeof props.label === "string"
      && typeof props.onClick === "function"
    ) {
      snapshot.button = {
        disabled: props.disabled === true,
        label: props.label,
        onClick: props.onClick as () => void | Promise<void>,
      };
    }
    if (
      props.boxed === true
      && typeof props.label === "string"
      && typeof props.tone === "string"
    ) {
      snapshot.notice = {
        label: props.label,
        tone: props.tone,
      };
    }
    visit(props.children);
  };

  visit(children);
  return snapshot;
}

vi.mock("../hooks/useConsoleData", () => ({
  useConsumeIdentityLinkCode: () => ({
    isPending: mocks.isPending,
    mutateAsync: mocks.mutateAsync,
  }),
}));

vi.mock("../../gsv-shell/unsaved/unsavedGuard", () => ({
  useUnsavedGuard: () => undefined,
}));

vi.mock("../../../components/ui/Surface", () => ({
  Surface: ({ children }: { children: ComponentChildren }) => {
    mocks.snapshots.push(capturePanel(children));
    return null;
  },
}));

import { MessengerLinkCodePanel } from "./MessengerLinkCodePanel";

function fakeContainer(): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error("The link-code panel harness must not render DOM nodes");
    },
    removeChild: () => {
      throw new Error("The link-code panel harness must not render DOM nodes");
    },
  } as unknown as Element;
}

let container: Element | null = null;

function currentPanel(): PanelSnapshot {
  const snapshot = mocks.snapshots.at(-1);
  if (!snapshot) {
    throw new Error("The link-code panel is not rendered");
  }
  return snapshot;
}

async function renderPanel(): Promise<void> {
  if (!container) {
    container = fakeContainer();
  }
  await act(() => {
    render(
      <MessengerLinkCodePanel linkCount={0} refreshing={false} />,
      container!,
    );
  });
}

async function enterCode(code: string): Promise<void> {
  const input = currentPanel().input;
  if (!input) {
    throw new Error("The authorization-code input is missing");
  }
  await act(() => {
    input.onChange(code);
  });
}

async function submitCode(): Promise<void> {
  const button = currentPanel().button;
  if (!button) {
    throw new Error("The link-identity button is missing");
  }
  expect(button.disabled).toBe(false);
  await act(async () => {
    await button.onClick();
  });
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.isPending = false;
  mocks.mutateAsync.mockReset();
  mocks.snapshots = [];
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

describe("MessengerLinkCodePanel", () => {
  it("clears the authorization code after a successful link", async () => {
    mocks.mutateAsync.mockResolvedValue({ link: null });
    await renderPanel();
    await enterCode("ABCD-EFGH");

    await submitCode();

    expect(mocks.mutateAsync).toHaveBeenCalledWith({ code: "ABCD-EFGH" });
    expect(currentPanel().input?.value).toBe("");
    expect(currentPanel().notice).toEqual({ label: "LINKED", tone: "online" });
  });

  it("retains the authorization code when linking fails", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("Authorization code expired"));
    await renderPanel();
    await enterCode("RETRY-CODE");

    await submitCode();

    expect(currentPanel().input?.value).toBe("RETRY-CODE");
    expect(currentPanel().notice).toEqual({ label: "ERROR", tone: "error" });
    expect(currentPanel().text.join(" ")).toContain("Authorization code expired");
  });

  it("does not expose raw messenger identifiers in success copy", async () => {
    const accountId = "private-account-id";
    const actorId = "private-actor-id";
    mocks.mutateAsync.mockResolvedValue({
      link: {
        accountId,
        actorId,
        adapter: "whatsapp",
        createdAt: null,
        linkedByUid: null,
        uid: 1000,
      },
    });
    await renderPanel();
    await enterCode("SAFE-COPY");

    await submitCode();

    const renderedText = currentPanel().text.join(" ");
    expect(currentPanel().notice).toEqual({ label: "LINKED", tone: "online" });
    expect(renderedText).toContain("identity linked to the signed-in GSV user");
    expect(renderedText).not.toContain(accountId);
    expect(renderedText).not.toContain(actorId);
  });
});
