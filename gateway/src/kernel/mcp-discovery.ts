import {
  ToolListChangedNotificationSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

type ToolListChangedHandler = (notification: unknown) => void | Promise<void>;

type ToolListChangedSchema = typeof ToolListChangedNotificationSchema;

type CursorParams = { cursor?: string };

type PaginatedResult<Key extends string, Item> = {
  nextCursor?: string;
} & Record<Key, Item[]>;

export type LenientMcpClient = {
  getInstructions(): string | undefined;
  getServerCapabilities(): ServerCapabilities | undefined;
  listTools(params?: CursorParams): Promise<PaginatedResult<"tools", Tool>>;
  setNotificationHandler?(
    schema: ToolListChangedSchema,
    handler: ToolListChangedHandler,
  ): void;
};

export type LenientMcpConnection = {
  client: LenientMcpClient;
  connectionError?: string | null;
  connectionState: string;
  instructions?: string;
  prompts: unknown[];
  resourceTemplates: unknown[];
  resources: unknown[];
  serverCapabilities?: ServerCapabilities;
  tools: Tool[];
};

export type LenientMcpDiscoveryResult =
  | { success: true; state: "ready" }
  | { success: false; state: string; error: string };

const MCP_DISCOVERY_TIMEOUT_MS = 15_000;

const OPTIONAL_LIST_METHODS = new Set([
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

export function isOptionalMcpListMethodNotFound(error: unknown): boolean {
  const message = errorText(error);
  const code = isRecord(error) ? error.code : undefined;
  if (!message && code !== -32601) {
    return false;
  }
  const methodMatched = [...OPTIONAL_LIST_METHODS].some((method) => message.includes(method));
  const methodNotFound = code === -32601 ||
    message.includes("-32601") ||
    message.toLowerCase().includes("method not found");
  return methodNotFound && (methodMatched || code === -32601);
}

export async function discoverMcpCapabilitiesLenient(
  connection: LenientMcpConnection,
  options: { timeoutMs?: number } = {},
): Promise<LenientMcpDiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
  try {
    connection.connectionState = "discovering";
    const capabilities = connection.client.getServerCapabilities();
    const shouldProbeCapabilities = !capabilities;
    const shouldListTools = !!capabilities?.tools || shouldProbeCapabilities;

    connection.instructions = connection.client.getInstructions();
    connection.serverCapabilities = capabilities;
    registerToolListChangedHandler(connection, timeoutMs);
    connection.tools = shouldListTools
      ? await withDiscoveryTimeout(
        listOptionalCapability(connection.client.listTools.bind(connection.client), "tools"),
        timeoutMs,
      )
      : [];
    connection.resources = [];
    connection.resourceTemplates = [];
    connection.prompts = [];
    connection.connectionError = null;
    connection.connectionState = "ready";
    return { success: true, state: "ready" };
  } catch (error) {
    const message = errorText(error) || "unknown discovery error";
    connection.connectionState = "connected";
    return { success: false, state: connection.connectionState, error: message };
  }
}

function registerToolListChangedHandler(
  connection: LenientMcpConnection,
  timeoutMs: number,
): void {
  if (!connection.serverCapabilities?.tools?.listChanged || !connection.client.setNotificationHandler) {
    return;
  }

  connection.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      connection.tools = await withDiscoveryTimeout(
        listOptionalCapability(connection.client.listTools.bind(connection.client), "tools"),
        timeoutMs,
      );
      connection.connectionError = null;
    } catch (error) {
      connection.connectionError = errorText(error) || "unknown discovery error";
    }
  });
}

async function listOptionalCapability<Key extends string, Item>(
  list: (params?: CursorParams) => Promise<PaginatedResult<Key, Item>>,
  key: Key,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    let result: PaginatedResult<Key, Item>;
    try {
      result = await list(cursor ? { cursor } : undefined);
    } catch (error) {
      if (isOptionalMcpListMethodNotFound(error)) {
        return items;
      }
      throw error;
    }
    items.push(...result[key]);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

async function withDiscoveryTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Discovery timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
