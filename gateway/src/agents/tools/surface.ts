import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";
import type { Surface } from "../../protocol/surface";

export const getSurfaceToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.OPEN_VIEW,
    description:
      "Open a view on a connected client or node. Use this to display apps, media, or web content on the user's screen. " +
      "If targetClientId is omitted: webview/media surfaces prefer display-capable nodes (native windows); " +
      "app surfaces prefer web clients. " +
      "kind=app opens a built-in app tab (chat, sessions, channels, nodes, workspace, cron, logs, settings, overview). " +
      "kind=media opens a media player (contentRef should be a URL). " +
      "kind=webview opens an arbitrary URL.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["app", "media", "webview"],
          description: "Type of view to open.",
        },
        contentRef: {
          type: "string",
          description:
            "What to display. For kind=app, this is the tab name (e.g., 'chat', 'sessions'). " +
            "For kind=media or kind=webview, this is a URL.",
        },
        label: {
          type: "string",
          description: "Optional window title. Defaults to contentRef.",
        },
        targetClientId: {
          type: "string",
          description:
            "Optional ID of the client or node to open the view on. " +
            "If omitted, webview/media views auto-target display nodes; app views auto-target web clients.",
        },
      },
      required: ["kind", "contentRef"],
    },
  },
  {
    name: NATIVE_TOOLS.LIST_VIEWS,
    description:
      "List all currently open views (surfaces) across all connected clients. " +
      "Use this to see what the user is looking at, or to find a surfaceId to close.",
    inputSchema: {
      type: "object",
      properties: {
        targetClientId: {
          type: "string",
          description:
            "Optional. Filter views to a specific client/node.",
        },
      },
      required: [],
    },
  },
  {
    name: NATIVE_TOOLS.CLOSE_VIEW,
    description:
      "Close a view (surface) by its surfaceId. Use gsv__ListViews first to find the surfaceId.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: {
          type: "string",
          description: "The surfaceId of the view to close.",
        },
      },
      required: ["surfaceId"],
    },
  },
];

export const surfaceNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.OPEN_VIEW]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "OpenView tool unavailable: gateway context missing",
      };
    }

    const kind = typeof args.kind === "string" ? args.kind : "app";
    const contentRef =
      typeof args.contentRef === "string" ? args.contentRef : "";
    const label =
      typeof args.label === "string" ? args.label : undefined;
    const targetClientId =
      typeof args.targetClientId === "string"
        ? args.targetClientId
        : undefined;

    if (!contentRef) {
      return { ok: false, error: "contentRef is required" };
    }

    const result = (await context.gateway.openSurface({
      kind,
      contentRef,
      label,
      targetClientId,
    })) as unknown as { ok: boolean; surface?: Surface; error?: string };

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      result: {
        surfaceId: result.surface?.surfaceId,
        kind: result.surface?.kind,
        contentRef: result.surface?.contentRef,
        targetClientId: result.surface?.targetClientId,
        label: result.surface?.label,
      },
    };
  },

  [NATIVE_TOOLS.LIST_VIEWS]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "ListViews tool unavailable: gateway context missing",
      };
    }

    const targetClientId =
      typeof args.targetClientId === "string"
        ? args.targetClientId
        : undefined;

    const result = (await context.gateway.listSurfaces(
      targetClientId,
    )) as unknown as { surfaces: Surface[]; count: number };

    return {
      ok: true,
      result: {
        count: result.count,
        surfaces: result.surfaces.map((s: Surface) => ({
          surfaceId: s.surfaceId,
          kind: s.kind,
          label: s.label,
          contentRef: s.contentRef,
          targetClientId: s.targetClientId,
          state: s.state,
        })),
      },
    };
  },

  [NATIVE_TOOLS.CLOSE_VIEW]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "CloseView tool unavailable: gateway context missing",
      };
    }

    const surfaceId =
      typeof args.surfaceId === "string" ? args.surfaceId : "";
    if (!surfaceId) {
      return { ok: false, error: "surfaceId is required" };
    }

    const result = (await context.gateway.closeSurface(
      surfaceId,
    )) as unknown as { ok: boolean; error?: string };
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, result: { closed: true, surfaceId } };
  },
};
