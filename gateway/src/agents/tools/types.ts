import type { Gateway } from "../../gateway/do";

export type NativeToolResult = { ok: boolean; result?: unknown; error?: string };

export type NativeToolExecutionContext = {
  bucket: R2Bucket;
  agentId: string;
  basePath: string;
  gateway?: DurableObjectStub<Gateway>;
};

export type NativeToolHandler = (
  context: NativeToolExecutionContext,
  args: Record<string, unknown>,
) => Promise<NativeToolResult>;

export type NativeToolHandlerMap = Record<string, NativeToolHandler>;
