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
          properties: {
            name: {
              type: "string",
              description: "Human-readable job name (required).",
            },
            schedule: {
              type: "object",
              description:
                'Schedule object (required). Must have a "kind" discriminator: ' +
                '{ kind: "at", atMs: <epoch_ms> } for one-shot, ' +
                '{ kind: "every", everyMs: <ms>, anchorMs?: <epoch_ms> } for interval, ' +
                '{ kind: "cron", expr: "<5-field cron>", tz?: "<IANA timezone>" } for cron expression.',
              properties: {
                kind: {
                  type: "string",
                  enum: ["at", "every", "cron"],
                  description: "Schedule type.",
                },
              },
              required: ["kind"],
            },
            spec: {
              type: "object",
              description:
                'Job spec (required). Determines how the job runs and how results are delivered. ' +
                'Two modes:\n' +
                '  { mode: "systemEvent", text: "<message>" } — Injects text into the agent\'s ' +
                'main session. The agent processes it in the existing conversation context and ' +
                'the response is delivered to the last active channel. Good for simple reminders.\n' +
                '  { mode: "task", message: "<message>", deliver?: boolean, channel?: string, ' +
                'to?: string, model?: string, thinking?: string, timeoutSeconds?: number, ' +
                'bestEffortDeliver?: boolean } — Runs a full agent turn in an isolated session ' +
                '(clean conversation, no carry-over). Supports explicit delivery control. ' +
                'Good for scheduled reports, time-sensitive reminders, and jobs that shouldn\'t ' +
                'pollute the main conversation.',
              properties: {
                mode: {
                  type: "string",
                  enum: ["systemEvent", "task"],
                  description: "Spec mode.",
                },
              },
              required: ["mode"],
            },
            agentId: {
              type: "string",
              description: 'Agent that owns the job. Defaults to "main".',
            },
            description: {
              type: "string",
              description: "Optional human-readable description.",
            },
            enabled: {
              type: "boolean",
              description: "Whether the job is active. Defaults to true.",
            },
            deleteAfterRun: {
              type: "boolean",
              description: "If true, delete the job after a successful one-shot run.",
            },
          },
          required: ["name", "schedule", "spec"],
        },
        patch: {
          type: "object",
          description:
            "Job patch payload for action=update. Same fields as job but all optional.",
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
