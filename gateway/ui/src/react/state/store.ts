import { create } from "zustand";
import { GatewayClient, type ConnectionState } from "../../ui/gateway-client";
import { getCurrentTab, navigateTo } from "../../ui/navigation";
import {
  applyTheme,
  getGatewayUrl,
  loadSettings,
  saveSettings,
  type UiSettings,
} from "../../ui/storage";
import type { EventFrame, Tab } from "../../ui/types";

type DebugEvent = {
  time: number;
  event: string;
};

type ReactUiStore = {
  initialized: boolean;
  connectionState: ConnectionState;
  connectionError: string | null;
  settings: UiSettings;
  showConnectScreen: boolean;
  tab: Tab;
  client: GatewayClient | null;
  debugEvents: DebugEvent[];
  initialize: () => void;
  setTab: (tab: Tab) => void;
  syncTabFromLocation: () => void;
  connect: () => void;
  disconnect: () => void;
  startConnection: () => void;
  stopConnection: () => void;
  updateSettings: (updates: Partial<UiSettings>) => void;
  pushDebugEvent: (event: EventFrame) => void;
};

const MAX_DEBUG_EVENTS = 100;

export const useReactUiStore = create<ReactUiStore>((set, get) => ({
  initialized: false,
  connectionState: "disconnected",
  connectionError: null,
  settings: loadSettings(),
  showConnectScreen: true,
  tab: getCurrentTab(),
  client: null,
  debugEvents: [],

  initialize: () => {
    if (get().initialized) {
      return;
    }

    const settings = get().settings;
    applyTheme(settings.theme);

    const shouldAutoConnect = Boolean(
      settings.token || localStorage.getItem("gsv-connected-once"),
    );

    set({
      initialized: true,
      showConnectScreen: !shouldAutoConnect,
      tab: getCurrentTab(),
    });

    if (shouldAutoConnect) {
      get().startConnection();
    }
  },

  setTab: (tab) => {
    if (get().tab === tab) {
      return;
    }
    set({ tab });
    navigateTo(tab);
  },

  syncTabFromLocation: () => {
    set({ tab: getCurrentTab() });
  },

  connect: () => {
    set({ showConnectScreen: false });
    get().startConnection();
  },

  disconnect: () => {
    get().stopConnection();
    localStorage.removeItem("gsv-connected-once");
    set({ showConnectScreen: true });
  },

  startConnection: () => {
    const existingClient = get().client;
    if (existingClient) {
      existingClient.stop();
    }

    const settings = get().settings;
    const client = new GatewayClient({
      url: getGatewayUrl(settings),
      token: settings.token || undefined,
      onStateChange: (state) => {
        set({ connectionState: state });
        if (state === "connected") {
          localStorage.setItem("gsv-connected-once", "true");
          set({
            connectionError: null,
            showConnectScreen: false,
          });
        }
      },
      onError: (error) => {
        set({ connectionError: error });
      },
      onEvent: (event) => {
        get().pushDebugEvent(event);
      },
    });

    set({
      client,
      connectionState: "connecting",
      connectionError: null,
    });
    client.start();
  },

  stopConnection: () => {
    const client = get().client;
    client?.stop();
    set({
      client: null,
      connectionState: "disconnected",
    });
  },

  updateSettings: (updates) => {
    const previous = get().settings;
    const settings = { ...previous, ...updates };
    set({ settings });
    saveSettings(updates);

    if (updates.theme) {
      applyTheme(updates.theme);
    }

    const shouldReconnect =
      (updates.gatewayUrl !== undefined || updates.token !== undefined) &&
      Boolean(get().client);
    if (shouldReconnect) {
      get().startConnection();
    }
  },

  pushDebugEvent: (event) => {
    set((state) => ({
      debugEvents: [
        ...state.debugEvents.slice(-(MAX_DEBUG_EVENTS - 1)),
        {
          time: Date.now(),
          event: event.event,
        },
      ],
    }));
  },
}));
