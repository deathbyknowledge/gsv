import type { ListRowStatus } from "../../../components/ui/ListRow";
import type { StatusTone } from "../../../components/ui/StatusDot";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge } from "../domain/consoleFormat";
import type { ConsoleMcpConnectionState, ConsoleMcpServer, ConsoleMcpTransport } from "../domain/consoleModels";

export const MCP_TRANSPORT_OPTIONS: ConsoleMcpTransport[] = ["auto", "streamable-http", "sse"];

export function integrationDetailId(server: ConsoleMcpServer): string {
  return server.serverId;
}

export function integrationIcon(_server: ConsoleMcpServer): string {
  return "weblink";
}

export function transportLabel(transport: ConsoleMcpTransport): string {
  if (transport === "streamable-http") return "STREAMABLE HTTP";
  if (transport === "sse") return "SSE";
  if (transport === "auto") return "AUTO";
  return "UNKNOWN";
}

export function stateLabel(state: ConsoleMcpConnectionState): string {
  if (state === "ready") return "READY";
  if (state === "authenticating") return "SIGN-IN";
  if (state === "connecting") return "CONNECTING";
  if (state === "connected") return "CONNECTED";
  if (state === "discovering") return "DISCOVERING";
  if (state === "failed") return "FAILED";
  if (state === "not-connected") return "NOT CONNECTED";
  return "UNKNOWN";
}

export function toneForMcpServer(server: ConsoleMcpServer): StatusTone {
  if (server.state === "ready") return "online";
  if (server.state === "failed" || server.error) return "error";
  if (server.state === "authenticating" || server.state === "connecting" || server.state === "connected" || server.state === "discovering") {
    return "warn";
  }
  return "idle";
}

export function statusForMcpServer(server: ConsoleMcpServer): string {
  return stateLabel(server.state);
}

export function listStatusForMcpServer(server: ConsoleMcpServer): ListRowStatus {
  return listRowStatusForTone(toneForMcpServer(server));
}

export function formatServerUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

export function mcpServerSub(server: ConsoleMcpServer): string {
  return compactText([
    formatServerUrl(server.url),
    `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`,
    server.error,
  ], server.serverId);
}

export function mcpServerBlurb(server: ConsoleMcpServer): string {
  if (server.error) return server.error;
  if (server.state === "ready") return "Tools from this MCP server are available to agents through CodeMode.";
  if (server.state === "authenticating") return "This MCP server needs provider sign-in before its tools can be used.";
  if (server.state === "failed") return "The MCP server failed to connect. Check the endpoint, auth state, and transport.";
  return "MCP server connection and tool discovery state.";
}

export function mcpServerDetailSections(server: ConsoleMcpServer): ConsoleDetailSection[] {
  return [
    {
      title: "CONNECTION",
      meta: statusForMcpServer(server),
      rows: liveRows([
        detailRow("server-id", "SERVER ID", server.serverId),
        detailRow("url", "URL", server.url),
        detailRow("status", "STATUS", statusForMcpServer(server), {
          status: listStatusForMcpServer(server),
          statusLabel: statusForMcpServer(server),
        }),
        detailRow("transport", "TRANSPORT", transportLabel(server.transport)),
        detailRow("auth", "AUTH URL", server.authUrl ? "AVAILABLE" : ""),
        detailRow("error", "ERROR", server.error),
      ]),
    },
    {
      title: "INVENTORY",
      meta: `${server.tools.length} TOOLS`,
      rows: liveRows([
        detailRow("tools", "TOOLS", server.tools.length),
        detailRow("created", "CREATED", server.createdAt === null ? "" : formatAge(server.createdAt)),
        detailRow("updated", "UPDATED", server.updatedAt === null ? "" : formatAge(server.updatedAt)),
      ]),
    },
    {
      title: "TOOLS",
      meta: `${server.tools.length}`,
      rows: liveRows(server.tools.map((tool) => detailRow(
        `tool-${tool.name}`,
        tool.name,
        tool.description || "No description provided.",
        { icon: "weblink" },
      ))),
    },
    {
      title: "INSTRUCTIONS",
      meta: server.instructions ? "PRESENT" : "NONE",
      rows: liveRows([
        detailRow("instructions", "SERVER INSTRUCTIONS", server.instructions),
      ]),
    },
  ];
}
