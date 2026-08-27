import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConsoleAdapter,
  ConsoleResourceState,
} from "../domain/consoleModels";
import {
  availableConsoleAdapter,
  consoleAdapterAccount,
  createTestRoot,
} from "./messengerTestHarness";
import {
  MessengersPage,
  type MessengersPageDependencies,
} from "./MessengersPage";

type MessengerPageTestState = {
  detailRenders: Array<{
    accountId: string;
    identityLinkCount: number;
    onLinkIdentity: (() => void) | undefined;
  }>;
  inventory: ConsoleAdapter[];
  inventoryResourceState: Pick<
    ConsoleResourceState<ConsoleAdapter[]>,
    "isError" | "isLoading" | "isRefreshing" | "isUnavailable"
  >;
  linkPanelRenders: Array<{
    errorText: string | undefined;
    linkCount: number;
    refreshing: boolean;
  }>;
  onboardingRenders: Array<{
    adapterId: string;
    existingAccountIds: string[];
    forceRelink: boolean;
    initialAccountId: string | null;
    onBack: () => void;
  }>;
  platformRenders: string[];
};

const mocks: MessengerPageTestState = {
  detailRenders: [],
  inventory: [],
  inventoryResourceState: {
    isError: false,
    isLoading: false,
    isRefreshing: false,
    isUnavailable: false,
  },
  linkPanelRenders: [],
  onboardingRenders: [],
  platformRenders: [],
};

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

function testDependencies(): MessengersPageDependencies {
  return {
    ConsolePage: ({ children }) => <>{children}</>,
    ConsoleResourceBoundary: ({ render, resource: resourceState }) => (
      <>{resourceState.data === null ? null : render(resourceState.data)}</>
    ),
    MessengerDetailPage: (props) => {
      mocks.detailRenders.push({
        accountId: props.adapter.accountId,
        identityLinkCount: props.identityLinks.length,
        onLinkIdentity: props.onLinkIdentity,
      });
      return <></>;
    },
    MessengerLinkCodePanel: (props) => {
      mocks.linkPanelRenders.push({
        errorText: props.errorText,
        linkCount: props.linkCount,
        refreshing: props.refreshing,
      });
      return <></>;
    },
    MessengerOnboardingFlow: (props) => {
      mocks.onboardingRenders.push({
        adapterId: props.adapterId,
        existingAccountIds: [...(props.existingAccountIds ?? [])],
        forceRelink: props.forceRelink ?? false,
        initialAccountId: props.initialAccountId ?? null,
        onBack: props.onBack,
      });
      return <></>;
    },
    MessengerPlatformPage: (props) => {
      mocks.platformRenders.push(props.adapter.adapter === "telegram" ? "Telegram" : props.adapter.adapter);
      return <></>;
    },
    MessengersRoster: () => <></>,
    useAccounts: () => ({ accounts: [], resource: resource([]) }),
    useAdapterInventory: () => ({
      adapters: mocks.inventory,
      resource: resource(mocks.inventory, mocks.inventoryResourceState),
    }),
    useIdentityLinks: () => ({ links: [], resource: resource([]) }),
    useDisconnectAdapter: () => ({
      error: null,
      isPending: false,
      mutateAsync: vi.fn(async () => ({ ok: true, message: "", error: "" })),
    }),
  };
}

let root: ReturnType<typeof createTestRoot> | null = null;

async function renderPage(props: {
  initialCreate?: boolean;
  initialDetailId?: string;
  onSelectionChange?: (selection: { createNew?: boolean } | null) => void;
}): Promise<void> {
  root ??= createTestRoot("The messenger route harness");
  await root.render(<MessengersPage dependencies={testDependencies()} {...props} />);
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
  root = null;
});

afterEach(async () => {
  await root?.unmount();
  root = null;
  vi.unstubAllGlobals();
});

describe("MessengersPage onboarding routes", () => {
  it.each(["telegram", "slack", "discord", "whatsapp"])(
    "keeps bare %s platform onboarding open when the first account appears",
    async (adapterId) => {
      const onSelectionChange = vi.fn();
      mocks.inventory = [availableConsoleAdapter(adapterId)];

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
        availableConsoleAdapter(adapterId, [consoleAdapterAccount(adapterId, accountId)]),
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
    mocks.inventory = [availableConsoleAdapter("telegram")];
    await renderPage({ initialCreate: true });

    expect(lastOnboardingRender()?.adapterId).toBe("telegram");
    const rendersBeforeAccount = mocks.onboardingRenders.length;

    mocks.inventory = [
      availableConsoleAdapter("telegram", [
        consoleAdapterAccount("telegram", "telegram-first"),
      ]),
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
      mocks.inventory = [availableConsoleAdapter("telegram")];
      mocks.inventoryResourceState = {
        ...mocks.inventoryResourceState,
        ...resourceState,
      };
      await renderPage({ initialDetailId: "telegram" });
      const onboardingRendersBeforeAccount = mocks.onboardingRenders.length;

      mocks.inventory = [
        availableConsoleAdapter("telegram", [
          consoleAdapterAccount("telegram", "telegram-first"),
        ]),
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
    mocks.inventory = [availableConsoleAdapter("telegram")];
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

  it("releases implicit onboarding into account identity-link recovery", async () => {
    mocks.inventory = [availableConsoleAdapter("telegram")];
    await renderPage({ initialDetailId: "telegram" });
    expect(lastOnboardingRender()?.adapterId).toBe("telegram");

    const account = consoleAdapterAccount("telegram", "telegram-existing");
    mocks.inventory = [availableConsoleAdapter("telegram", [account])];
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
