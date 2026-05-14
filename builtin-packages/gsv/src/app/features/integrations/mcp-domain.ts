import type { McpConnectionState, McpServer, McpTransportType } from "./types";

export const MCP_TRANSPORT_OPTIONS: Array<{ value: McpTransportType; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
];

export function stateLabel(state: McpConnectionState): string {
  switch (state) {
    case "authenticating":
      return "Sign-in needed";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "discovering":
      return "Discovering";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    default:
      return "Not connected";
  }
}

export function stateTone(state: McpConnectionState): "is-good" | "is-warn" | "is-danger" | "is-idle" {
  if (state === "ready") return "is-good";
  if (state === "authenticating" || state === "connecting" || state === "connected" || state === "discovering") {
    return "is-warn";
  }
  if (state === "failed") return "is-danger";
  return "is-idle";
}

export function transportLabel(transport: McpTransportType): string {
  return MCP_TRANSPORT_OPTIONS.find((option) => option.value === transport)?.label ?? transport;
}

export function formatServerUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

export function describeMcpState(server: McpServer): { title: string; detail: string } {
  if (server.state === "ready") {
    return {
      title: "Ready for agents",
      detail: "Tools from this server are available to agents through CodeMode.",
    };
  }
  if (server.state === "authenticating") {
    return {
      title: "Sign-in required",
      detail: "This server needs a browser OAuth flow before its tools can be used.",
    };
  }
  if (server.state === "failed") {
    return {
      title: "Connection failed",
      detail: server.error ?? "Refresh the server after checking the endpoint and provider access.",
    };
  }
  return {
    title: stateLabel(server.state),
    detail: "The server is being connected or rediscovered. Refresh if this state does not settle.",
  };
}

export function readyServerCount(servers: McpServer[]): number {
  return servers.filter((server) => server.state === "ready").length;
}

export function attentionServerCount(servers: McpServer[]): number {
  return servers.filter((server) => server.state === "authenticating" || server.state === "failed").length;
}

export function formatShortDate(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
