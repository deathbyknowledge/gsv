import type {
  AdapterActivity,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSurface,
  BinaryBody,
} from "./types";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "./installation";
import { cancelBinaryBody } from "./media-body";

const STANDALONE_INSTALLATION = Object.freeze({
  installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
});

export type AdapterConnectRpcArgs =
  | [accountId: string, config?: Record<string, unknown>]
  | [
      installation: AdapterInstallationContext,
      accountId: string,
      config?: Record<string, unknown>,
    ];

export type AdapterDisconnectRpcArgs =
  | [accountId: string]
  | [installation: AdapterInstallationContext, accountId: string];

export type AdapterStatusRpcArgs =
  | [accountId?: string]
  | [installation: AdapterInstallationContext, accountId?: string];

export type AdapterSendRpcArgs =
  | [accountId: string, message: AdapterOutboundMessage, body?: BinaryBody]
  | [
      installation: AdapterInstallationContext,
      accountId: string,
      message: AdapterOutboundMessage,
      body?: BinaryBody,
    ];

export type AdapterActivityRpcArgs =
  | [accountId: string, surface: AdapterSurface, activity: AdapterActivity]
  | [
      installation: AdapterInstallationContext,
      accountId: string,
      surface: AdapterSurface,
      activity: AdapterActivity,
    ];

export function resolveAdapterConnectRpcArgs(args: AdapterConnectRpcArgs): {
  installation: AdapterInstallationContext;
  accountId: string;
  config: Record<string, unknown>;
} {
  const values = args as unknown[];
  if (typeof values[0] === "string") {
    requireRpcArity("connect", values, 1, 2);
    return {
      installation: STANDALONE_INSTALLATION,
      accountId: values[0],
      config: normalizeConfig(values[1]),
    };
  }
  requireRpcArity("connect", values, 2, 3);
  return {
    installation: parseAdapterInstallationContext(values[0]),
    accountId: requireAccountId(values[1]),
    config: normalizeConfig(values[2]),
  };
}

export function resolveAdapterDisconnectRpcArgs(args: AdapterDisconnectRpcArgs): {
  installation: AdapterInstallationContext;
  accountId: string;
} {
  const values = args as unknown[];
  if (typeof values[0] === "string") {
    requireRpcArity("disconnect", values, 1);
    return { installation: STANDALONE_INSTALLATION, accountId: values[0] };
  }
  requireRpcArity("disconnect", values, 2);
  return {
    installation: parseAdapterInstallationContext(values[0]),
    accountId: requireAccountId(values[1]),
  };
}

export function resolveAdapterStatusRpcArgs(args: AdapterStatusRpcArgs): {
  installation: AdapterInstallationContext;
  accountId?: string;
} {
  const values = args as unknown[];
  if (values.length === 0) {
    return { installation: STANDALONE_INSTALLATION };
  }
  if (values[0] === undefined || typeof values[0] === "string") {
    requireRpcArity("status", values, 1);
    return {
      installation: STANDALONE_INSTALLATION,
      ...(values[0] === undefined ? {} : { accountId: values[0] }),
    };
  }
  requireRpcArity("status", values, 1, 2);
  const accountId = values[1];
  if (accountId !== undefined && typeof accountId !== "string") {
    throw new Error("Adapter account ID must be a string");
  }
  return {
    installation: parseAdapterInstallationContext(values[0]),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export async function resolveAdapterSendRpcArgs(args: AdapterSendRpcArgs): Promise<{
  installation: AdapterInstallationContext;
  accountId: string;
  message: AdapterOutboundMessage;
  body?: BinaryBody;
}> {
  const values = args as unknown[];
  const candidateBodies = binaryBodyCandidates(values[2], values[3]);
  try {
    if (typeof values[0] === "string") {
      requireRpcArity("send", values, 2, 3);
      const body = requireOptionalBinaryBody(values[2]);
      return {
        installation: STANDALONE_INSTALLATION,
        accountId: values[0],
        message: requireOutboundMessage(values[1]),
        ...(body === undefined ? {} : { body }),
      };
    }
    requireRpcArity("send", values, 3, 4);
    const body = requireOptionalBinaryBody(values[3]);
    return {
      installation: parseAdapterInstallationContext(values[0]),
      accountId: requireAccountId(values[1]),
      message: requireOutboundMessage(values[2]),
      ...(body === undefined ? {} : { body }),
    };
  } catch (error) {
    await Promise.all(candidateBodies.map((body) => cancelBinaryBody(body, error)));
    throw error;
  }
}

export function resolveAdapterActivityRpcArgs(args: AdapterActivityRpcArgs): {
  installation: AdapterInstallationContext;
  accountId: string;
  surface: AdapterSurface;
  activity: AdapterActivity;
} {
  const values = args as unknown[];
  if (typeof values[0] === "string") {
    requireRpcArity("set activity", values, 3);
    return {
      installation: STANDALONE_INSTALLATION,
      accountId: values[0],
      surface: requireAdapterSurface(values[1]),
      activity: requireAdapterActivity(values[2]),
    };
  }
  requireRpcArity("set activity", values, 4);
  return {
    installation: parseAdapterInstallationContext(values[0]),
    accountId: requireAccountId(values[1]),
    surface: requireAdapterSurface(values[2]),
    activity: requireAdapterActivity(values[3]),
  };
}

function requireAccountId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Adapter account ID must be a string");
  }
  return value;
}

function requireRpcArity(
  method: string,
  args: unknown[],
  ...allowed: number[]
): void {
  if (!allowed.includes(args.length)) {
    throw new Error(`Adapter ${method} RPC arguments are invalid`);
  }
}

function requireOutboundMessage(value: unknown): AdapterOutboundMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Adapter outbound message must be an object");
  }
  return value as AdapterOutboundMessage;
}

function requireAdapterSurface(value: unknown): AdapterSurface {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Adapter surface must be an object");
  }
  return value as AdapterSurface;
}

function requireAdapterActivity(value: unknown): AdapterActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Adapter activity must be an object");
  }
  return value as AdapterActivity;
}

function requireOptionalBinaryBody(value: unknown): BinaryBody | undefined {
  if (value === undefined) return undefined;
  const body = binaryBodyCandidate(value);
  if (!body) {
    throw new Error("Adapter send body is invalid");
  }
  return body;
}

function binaryBodyCandidates(...values: unknown[]): BinaryBody[] {
  const bodies = new Set<BinaryBody>();
  for (const value of values) {
    const body = binaryBodyCandidate(value);
    if (body) bodies.add(body);
  }
  return [...bodies];
}

function binaryBodyCandidate(value: unknown): BinaryBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return (value as { stream?: unknown }).stream instanceof ReadableStream
      ? value as BinaryBody
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeConfig(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Adapter config must be an object");
  }
  return value as Record<string, unknown>;
}
