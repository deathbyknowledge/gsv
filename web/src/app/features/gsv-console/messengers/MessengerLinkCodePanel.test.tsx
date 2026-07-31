import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectNodes,
  collectText,
  createTestRoot,
  nodeWithLabel,
} from "./messengerTestHarness";

const mocks = vi.hoisted(() => ({
  children: null as ComponentChildren,
  isPending: false,
  mutateAsync: vi.fn(),
}));

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
    mocks.children = children;
    return null;
  },
}));

import { MessengerLinkCodePanel } from "./MessengerLinkCodePanel";

let root: ReturnType<typeof createTestRoot> | null = null;

function currentNodes() {
  if (!mocks.children) {
    throw new Error("The link-code panel is not rendered");
  }
  return collectNodes(mocks.children);
}

async function renderPanel(): Promise<void> {
  root ??= createTestRoot("The link-code panel harness");
  await root.render(<MessengerLinkCodePanel linkCount={0} refreshing={false} />);
}

async function enterCode(code: string): Promise<void> {
  await act(() => {
    nodeWithLabel(currentNodes(), "AUTHORIZATION CODE").props.onChange?.(code);
  });
}

async function submitCode(): Promise<void> {
  const button = nodeWithLabel(currentNodes(), "LINK IDENTITY");
  expect(button.props.disabled).toBe(false);
  await act(async () => {
    await button.props.onClick?.();
  });
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.children = null;
  mocks.isPending = false;
  mocks.mutateAsync.mockReset();
  root = null;
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("MessengerLinkCodePanel", () => {
  it("clears successful codes without exposing raw messenger identifiers", async () => {
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
    await enterCode("ABCD-EFGH");

    await submitCode();

    expect(mocks.mutateAsync).toHaveBeenCalledWith({ code: "ABCD-EFGH" });
    expect(nodeWithLabel(currentNodes(), "AUTHORIZATION CODE").props.value).toBe("");
    expect(nodeWithLabel(currentNodes(), "LINKED").props.tone).toBe("online");
    const renderedText = collectText(mocks.children);
    expect(renderedText).toContain("identity linked to the signed-in GSV user");
    expect(renderedText).not.toContain(accountId);
    expect(renderedText).not.toContain(actorId);
  });

  it("retains the authorization code when linking fails", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("Authorization code expired"));
    await renderPanel();
    await enterCode("RETRY-CODE");

    await submitCode();

    expect(nodeWithLabel(currentNodes(), "AUTHORIZATION CODE").props.value)
      .toBe("RETRY-CODE");
    expect(nodeWithLabel(currentNodes(), "ERROR").props.tone).toBe("error");
    expect(collectText(mocks.children)).toContain("Authorization code expired");
  });
});
