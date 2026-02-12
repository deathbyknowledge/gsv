import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

export const getCronToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.CRON,
    description:
      "Manage scheduled cron jobs. Actions: status, list, add, update, remove, run, runs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "status",
            "list",
            "add",
            "update",
            "remove",
            "run",
            "runs",
          ],
          description: "Cron action to execute.",
        },
        id: {
          type: "string",
          description: "Job id for update/remove/run(force).",
        },
        mode: {
          type: "string",
          enum: ["due", "force"],
          description: "Run mode for action=run.",
        },
        agentId: {
          type: "string",
          description:
            "Optional agent filter for list/status, or owner for add.",
        },
        includeDisabled: {
          type: "boolean",
          description: "Whether disabled jobs are included for action=list.",
        },
        limit: {
          type: "number",
          description: "Pagination limit for list/runs.",
        },
        offset: {
          type: "number",
          description: "Pagination offset for list/runs.",
        },
        job: {
          type: "object",
          description: "Job create payload for action=add.",
        },
        patch: {
          type: "object",
          description: "Job patch payload for action=update.",
        },
        jobId: {
          type: "string",
          description: "Job id filter for action=runs.",
        },
      },
      required: ["action"],
    },
  },
];

export const cronNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.CRON]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "Cron tool unavailable: gateway context missing",
      };
    }

    const payload = await context.gateway.executeCronTool(args);
    return {
      ok: true,
      result: payload,
    };
  },
};
