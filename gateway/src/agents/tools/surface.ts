import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";
import type { Surface } from "../../protocol/surface";

export const getSurfaceToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.VIEW,
    description:
      "Manage views (surfaces) on connected clients and display nodes.\n\n" +
      "Actions:\n" +
      "  open  — Open a view. Requires kind and contentRef.\n" +
      "          kind=app opens a built-in tab (chat, sessions, channels, nodes, workspace, cron, logs, settings, overview).\n" +
      "          kind=media opens a media player (contentRef = URL).\n" +
      "          kind=webview opens an arbitrary URL in a native browser window.\n" +
      "          If targetClientId is omitted, webview/media auto-target display nodes; app auto-targets web clients.\n" +
      "  list  — List all open views. Optional targetClientId filter.\n" +
      "  close — Close a view by surfaceId.\n" +
      "  eval  — Execute JavaScript in a webview surface (like DevTools console). Requires surfaceId and script.\n" +
      "          Returns the JSON-serializable result. Only works on kind=webview surfaces on display nodes.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "list", "close", "eval"],
          description: "The operation to perform.",
        },
        kind: {
          type: "string",
          enum: ["app", "media", "webview"],
          description: "Type of view to open. Required for action=open.",
        },
        contentRef: {
          type: "string",
          description:
            "What to display. Required for action=open. " +
            "For kind=app: tab name (e.g. 'chat'). For kind=media or kind=webview: a URL.",
        },
        label: {
          type: "string",
          description: "Window title. Defaults to contentRef. Used with action=open.",
        },
        targetClientId: {
          type: "string",
          description:
            "Target client or node ID. Used with action=open (optional auto-target) and action=list (optional filter).",
        },
        surfaceId: {
          type: "string",
          description: "The surfaceId of an existing view. Required for action=close and action=eval.",
        },
        script: {
          type: "string",
          description:
            "JavaScript to execute in the webview. Required for action=eval. " +
            "The return value of the last expression is JSON-serialized and returned.",
        },
      },
      required: ["action"],
    },
  },
];

export const surfaceNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.VIEW]: async (context, args) => {
    if (!context.gateway) {
      return { ok: false, error: "View tool unavailable: gateway context missing" };
    }

    const action = typeof args.action === "string" ? args.action : "";

    switch (action) {
      case "open": {
        const kind = typeof args.kind === "string" ? args.kind : "app";
        const contentRef = typeof args.contentRef === "string" ? args.contentRef : "";
        const label = typeof args.label === "string" ? args.label : undefined;
        const targetClientId = typeof args.targetClientId === "string" ? args.targetClientId : undefined;

        if (!contentRef) {
          return { ok: false, error: "contentRef is required for action=open" };
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
      }

      case "list": {
        const targetClientId = typeof args.targetClientId === "string" ? args.targetClientId : undefined;

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
      }

      case "close": {
        const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId : "";
        if (!surfaceId) {
          return { ok: false, error: "surfaceId is required for action=close" };
        }

        const result = (await context.gateway.closeSurface(
          surfaceId,
        )) as unknown as { ok: boolean; error?: string };

        if (!result.ok) {
          return { ok: false, error: result.error };
        }

        return { ok: true, result: { closed: true, surfaceId } };
      }

      case "eval": {
        const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId : "";
        const script = typeof args.script === "string" ? args.script : "";

        if (!surfaceId) {
          return { ok: false, error: "surfaceId is required for action=eval" };
        }
        if (!script) {
          return { ok: false, error: "script is required for action=eval" };
        }

        if (!context.callId || !context.sessionKey) {
          return { ok: false, error: "eval requires callId and sessionKey in execution context" };
        }

        // Fire-and-forget: pass callId/sessionKey so the result routes back via Session DO toolResult()
        const result = (await context.gateway.evalSurface(
          surfaceId,
          script,
          context.callId,
          context.sessionKey,
        )) as unknown as { ok: boolean; error?: string; evalId?: string };

        if (!result.ok) {
          return { ok: false, error: result.error };
        }

        // Return deferred — the actual result arrives asynchronously via toolResult()
        return { ok: true, deferred: true };
      }

      default:
        return { ok: false, error: `Unknown action: "${action}". Use open, list, close, or eval.` };
    }
  },
};
