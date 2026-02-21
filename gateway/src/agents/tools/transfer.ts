import { NATIVE_TOOL_PREFIX } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { TransferEndpoint } from "../../protocol/transfer";

export const TRANSFER_TOOL_NAME = `${NATIVE_TOOL_PREFIX}Transfer`;

export function getTransferToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: TRANSFER_TOOL_NAME,
      description:
        "Transfer a file between two endpoints. Endpoints can be a connected node (nodeId:/path/to/file) or the GSV workspace storage (gsv:workspace/path). Orchestrates streaming binary transfer between source and destination.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Source endpoint in format nodeId:/path/to/file or gsv:workspace/path",
          },
          destination: {
            type: "string",
            description:
              "Destination endpoint in format nodeId:/path/to/file or gsv:workspace/path",
          },
        },
        required: ["source", "destination"],
      },
    },
  ];
}

export function parseTransferEndpoint(raw: string): TransferEndpoint {
  const colonIndex = raw.indexOf(":");
  if (colonIndex <= 0) {
    throw new Error(
      `Invalid transfer endpoint "${raw}": expected format nodeId:/path or gsv:path`,
    );
  }
  const node = raw.slice(0, colonIndex);
  const path = raw.slice(colonIndex + 1);
  if (!path) {
    throw new Error(
      `Invalid transfer endpoint "${raw}": path cannot be empty`,
    );
  }
  return { node, path };
}
