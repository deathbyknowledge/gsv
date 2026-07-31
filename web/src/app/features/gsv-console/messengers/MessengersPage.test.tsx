import type { ComponentChildren } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleResourceState,
} from "../domain/consoleModels";

const mocks = vi.hoisted(() => ({
  detailRenders: [] as Array<{
    accountId: string;
    identityLinkCount: number;
    onLinkIdentity: (() => void) | undefined;
  }>,
  inventory: [] as ConsoleAdapter[],
  inventoryResourceState: {
    isError: false,
    isLoading: false,
    isRefreshing: false,
    isUnavailable: false,
  },
  linkPanelRenders: [] as Array<{
    errorText: string | undefined;
    linkCount: number;
    refreshing: boolean;
  }>,
  onboardingRenders: [] as Array<{
    adapterId: string;
    existingAccountIds: string[];
    forceRelink: boolean;
    initialAccountId: string | null;
    onBack: () => void;
  }>,
  platformRenders: [] as string[],
}));

function resource<T>(
  data: T,
  state: Partial<Pick<
    ConsoleResourceState<T>,
    "isError" | "isLoading" | "isRefreshing" | "isUnavailable"
  >> = {},
): ConsoleResourceState<T> {
  return {
    data,
    isUnavailable: state.isUnavailable ?? false,
    isLoading: state.isLoading ?? false,
    isRefreshing: state.isRefreshing ?? false,
    isError: state.isError ?? false,
    errorText: "",
    isEmpty: false,
  };
}

vi.mock("../hooks/useConsoleData", () => ({
  useConsoleAccounts: () => ({
    accounts: [],
    resource: resource([]),
  }),
  useConsoleAdapterInventory: () => ({
    adapters: mocks.inventory,
    resource: resource(mocks.inventory, mocks.inventoryResourceState),
  }),
  useConsoleIdentityLinks: () => ({
    links: [],
    resource: resource([]),
  }),
  useDisconnectConsoleAdapter: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn(),
  }),
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
  ConsoleDetailPage: (props: { title: string }) => {
    mocks.platformRenders.push(props.title);
    return null;
  },
}));

vi.mock("./MessengerDetailPage", () => ({
  MessengerDetailPage: (props: {
    adapter: ConsoleAdapterAccount;
    identityLinks: readonly unknown[];
    onLinkIdentity?: () => void;
  }) => {
    mocks.detailRenders.push({
      accountId: props.adapter.accountId,
      identityLinkCount: props.identityLinks.length,
      onLinkIdentity: props.onLinkIdentity,
    });
    return null;
  },
}));

vi.mock("./MessengerLinkCodePanel", () => ({
  MessengerLinkCodePanel: (props: {
    errorText?: string;
    linkCount: number;
    refreshing: boolean;
  }) => {
    mocks.linkPanelRenders.push({
      errorText: props.errorText,
      linkCount: props.linkCount,
      refreshing: props.refreshing,
    });
    return null;
  },
}));

vi.mock("./MessengerOnboardingFlow", () => ({
  MessengerOnboardingFlow: (props: {
    adapterId: string;
    existingAccountIds?: readonly string[];
    forceRelink?: boolean;
    initialAccountId?: string | null;
    onBack: () => void;
  }) => {
    mocks.onboardingRenders.push({
      adapterId: props.adapterId,
      existingAccountIds: [...(props.existingAccountIds ?? [])],
      forceRelink: props.forceRelink ?? false,
      initialAccountId: props.initialAccountId ?? null,
      onBack: props.onBack,
    });
    return null;
  },
}));

import { MessengersPage } from "./MessengersPage";

function adapterAccount(adapter: string, accountId: string): ConsoleAdapterAccount {
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

function availableAdapter(
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

function fakeContainer(): Element {
  return {
    nodeType: 1,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    firstChild: null,
    childNodes: [],
    insertBefore: () => {
      throw new Error("The messenger route harness must not render DOM nodes");
    },
    removeChild: () => {
      throw new Error("The messenger route harness must not render DOM nodes");
    },
  } as unknown as Element;
}

let container: Element | null = null;

async function renderPage(props: {
  initialCreate?: boolean;
  initialDetailId?: string;
  onSelectionChange?: (selection: { createNew?: boolean } | null) => void;
}): Promise<void> {
  if (!container) {
    container = fakeContainer();
  }
  await act(() => {
    render(<MessengersPage {...props} />, container!);
  });
}

function lastOnboardingRender() {
  return mocks.onboardingRenders.at(-1);
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  mocks.detailRenders = [];
  mocks.inventory = [];
  mocks.inventoryResourceState = {
    isError: false,
    isLoading: false,
    isRefreshing: false,
    isUnavailable: false,
  };
  mocks.linkPanelRenders = [];
  mocks.onboardingRenders = [];
  mocks.platformRenders = [];
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

describe("MessengersPage onboarding routes", () => {
  it.each(["telegram", "discord", "whatsapp"])(
    "keeps bare %s platform onboarding open when the first account appears",
    async (adapterId) => {
      const onSelectionChange = vi.fn();
      mocks.inventory = [availableAdapter(adapterId)];

      await renderPage({ initialDetailId: adapterId, onSelectionChange });

      expect(onSelectionChange).not.toHaveBeenCalled();
      expect(lastOnboardingRender()).toEqual({
        adapterId,
        existingAccountIds: [],
        forceRelink: false,
        initialAccountId: null,
        onBack: expect.any(Function),
      });
      const rendersBeforeAccount = mocks.onboardingRenders.length;

      const accountId = `${adapterId}-first`;
      mocks.inventory = [
        availableAdapter(adapterId, [adapterAccount(adapterId, accountId)]),
      ];
      await renderPage({ initialDetailId: adapterId, onSelectionChange });

      expect(mocks.onboardingRenders.length).toBeGreaterThan(rendersBeforeAccount);
      expect(lastOnboardingRender()).toEqual({
        adapterId,
        existingAccountIds: [],
        forceRelink: false,
        initialAccountId: null,
        onBack: expect.any(Function),
      });
      expect(onSelectionChange).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicit create route open when inventory gains an account", async () => {
    mocks.inventory = [availableAdapter("telegram")];
    await renderPage({ initialCreate: true });

    expect(lastOnboardingRender()?.adapterId).toBe("telegram");
    const rendersBeforeAccount = mocks.onboardingRenders.length;

    mocks.inventory = [
      availableAdapter("telegram", [adapterAccount("telegram", "telegram-first")]),
    ];
    await renderPage({ initialCreate: true });

    expect(mocks.onboardingRenders.length).toBeGreaterThan(rendersBeforeAccount);
    expect(lastOnboardingRender()).toMatchObject({
      adapterId: "telegram",
      existingAccountIds: ["telegram-first"],
    });
  });

  it.each([
    ["loading", { isLoading: true }],
    ["stale refresh", { isRefreshing: true }],
  ])(
    "does not latch a %s zero-account result before an account appears",
    async (_label, resourceState) => {
      mocks.inventory = [availableAdapter("telegram")];
      mocks.inventoryResourceState = {
        ...mocks.inventoryResourceState,
        ...resourceState,
      };
      await renderPage({ initialDetailId: "telegram" });
      const onboardingRendersBeforeAccount = mocks.onboardingRenders.length;

      mocks.inventory = [
        availableAdapter("telegram", [adapterAccount("telegram", "telegram-first")]),
      ];
      mocks.inventoryResourceState = {
        isError: false,
        isLoading: false,
        isRefreshing: false,
        isUnavailable: false,
      };
      await renderPage({ initialDetailId: "telegram" });

      expect(mocks.onboardingRenders).toHaveLength(onboardingRendersBeforeAccount);
      expect(mocks.platformRenders.at(-1)).toBe("Telegram");
    },
  );

  it("releases implicit onboarding on Back without rewriting to create", async () => {
    const onSelectionChange = vi.fn();
    mocks.inventory = [availableAdapter("telegram")];
    await renderPage({ initialDetailId: "telegram", onSelectionChange });

    const onboarding = lastOnboardingRender();
    expect(onboarding?.adapterId).toBe("telegram");
    expect(onSelectionChange).not.toHaveBeenCalled();
    const panelRendersBeforeBack = mocks.linkPanelRenders.length;

    await act(() => {
      onboarding?.onBack();
    });

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(null);
    expect(onSelectionChange).not.toHaveBeenCalledWith({ createNew: true });
    expect(mocks.linkPanelRenders.length).toBeGreaterThan(panelRendersBeforeBack);
  });

  it("releases implicit onboarding when the parent selects another route", async () => {
    mocks.inventory = [availableAdapter("telegram")];
    await renderPage({ initialDetailId: "telegram" });
    expect(lastOnboardingRender()?.adapterId).toBe("telegram");

    const account = adapterAccount("telegram", "telegram-existing");
    mocks.inventory = [availableAdapter("telegram", [account])];
    await renderPage({ initialDetailId: "telegram:telegram-existing" });

    expect(mocks.detailRenders.at(-1)).toMatchObject({
      accountId: "telegram-existing",
      identityLinkCount: 0,
    });
  });

  it("offers identity-link recovery for an existing unlinked account", async () => {
    mocks.inventory = [
      availableAdapter("telegram", [adapterAccount("telegram", "telegram-existing")]),
    ];

    await renderPage({});

    expect(mocks.linkPanelRenders.at(-1)).toEqual({
      errorText: undefined,
      linkCount: 0,
      refreshing: false,
    });
  });

  it("routes an unlinked account detail to the identity-link recovery panel", async () => {
    const account = adapterAccount("telegram", "telegram-existing");
    mocks.inventory = [availableAdapter("telegram", [account])];

    await renderPage({ initialDetailId: "telegram:telegram-existing" });

    const detail = mocks.detailRenders.at(-1);
    expect(detail).toMatchObject({
      accountId: "telegram-existing",
      identityLinkCount: 0,
    });
    expect(detail?.onLinkIdentity).toBeTypeOf("function");
    const panelRendersBeforeAction = mocks.linkPanelRenders.length;

    await act(() => {
      detail?.onLinkIdentity?.();
    });

    expect(mocks.linkPanelRenders.length).toBeGreaterThan(panelRendersBeforeAction);
    expect(mocks.linkPanelRenders.at(-1)).toEqual({
      errorText: undefined,
      linkCount: 0,
      refreshing: false,
    });
  });
});
