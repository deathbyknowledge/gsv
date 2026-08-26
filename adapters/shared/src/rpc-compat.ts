import {
  adapterActivitySchema,
  adapterConnectConfigSchema,
  adapterInstallationContextSchema,
  adapterOutboundMessageSchema,
  adapterSurfaceSchema,
} from "../../../packages/gsv/src/protocol/adapters.js";
import { binaryBodySchema } from "../../../packages/gsv/src/protocol/body.js";
import type {
  AdapterActivity,
  AdapterConnectConfig,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSurface,
  BinaryBody,
} from "./types";
import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "./installation";
import { cancelBinaryBody } from "./media-body";
import * as z from "zod/mini";

const STANDALONE_INSTALLATION = Object.freeze({
  installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
});

const standaloneConnectRpcSchema = z.union([
  z.tuple([z.string()]),
  z.tuple([z.string(), z.undefined()]),
  z.tuple([z.string(), adapterConnectConfigSchema]),
]);
const managedConnectRpcSchema = z.union([
  z.tuple([adapterInstallationContextSchema, z.string()]),
  z.tuple([adapterInstallationContextSchema, z.string(), z.undefined()]),
  z.tuple([
    adapterInstallationContextSchema,
    z.string(),
    adapterConnectConfigSchema,
  ]),
]);
const standaloneDisconnectRpcSchema = z.tuple([z.string()]);
const managedDisconnectRpcSchema = z.tuple([
  adapterInstallationContextSchema,
  z.string(),
]);
const standaloneStatusRpcSchema = z.union([
  z.tuple([]),
  z.tuple([z.undefined()]),
  z.tuple([z.string()]),
]);
const managedStatusRpcSchema = z.union([
  z.tuple([adapterInstallationContextSchema]),
  z.tuple([adapterInstallationContextSchema, z.undefined()]),
  z.tuple([adapterInstallationContextSchema, z.string()]),
]);
const standaloneSendRpcSchema = z.union([
  z.tuple([z.string(), adapterOutboundMessageSchema]),
  z.tuple([z.string(), adapterOutboundMessageSchema, z.undefined()]),
  z.tuple([z.string(), adapterOutboundMessageSchema, binaryBodySchema]),
]);
const managedSendRpcSchema = z.union([
  z.tuple([
    adapterInstallationContextSchema,
    z.string(),
    adapterOutboundMessageSchema,
  ]),
  z.tuple([
    adapterInstallationContextSchema,
    z.string(),
    adapterOutboundMessageSchema,
    z.undefined(),
  ]),
  z.tuple([
    adapterInstallationContextSchema,
    z.string(),
    adapterOutboundMessageSchema,
    binaryBodySchema,
  ]),
]);
const standaloneActivityRpcSchema = z.tuple([
  z.string(),
  adapterSurfaceSchema,
  adapterActivitySchema,
]);
const managedActivityRpcSchema = z.tuple([
  adapterInstallationContextSchema,
  z.string(),
  adapterSurfaceSchema,
  adapterActivitySchema,
]);

export type AdapterConnectRpcArgs =
  | [accountId: string, config?: AdapterConnectConfig]
  | [
      installation: AdapterInstallationContext,
      accountId: string,
      config?: AdapterConnectConfig,
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

export type ResolvedAdapterConnectRpcArgs = {
  installation: AdapterInstallationContext;
  accountId: string;
  config: AdapterConnectConfig;
};

export type ResolvedAdapterDisconnectRpcArgs = {
  installation: AdapterInstallationContext;
  accountId: string;
};

export type ResolvedAdapterStatusRpcArgs = {
  installation: AdapterInstallationContext;
  accountId?: string;
};

export type ResolvedAdapterSendRpcArgs = {
  installation: AdapterInstallationContext;
  accountId: string;
  message: AdapterOutboundMessage;
  body?: BinaryBody;
};

export type ResolvedAdapterActivityRpcArgs = {
  installation: AdapterInstallationContext;
  accountId: string;
  surface: AdapterSurface;
  activity: AdapterActivity;
};

export function resolveAdapterConnectRpcArgs(
  args: AdapterConnectRpcArgs,
): ResolvedAdapterConnectRpcArgs {
  if (z.string().safeParse(args[0]).success) {
    const parsed = standaloneConnectRpcSchema.safeParse(args);
    if (!parsed.success) throw invalidRpcArguments("connect");
    return {
      installation: STANDALONE_INSTALLATION,
      accountId: parsed.data[0],
      config: parsed.data[1] ?? {},
    };
  }

  requireInstallation(args[0]);
  const parsed = managedConnectRpcSchema.safeParse(args);
  if (!parsed.success) throw invalidRpcArguments("connect");
  return {
    installation: Object.freeze(parsed.data[0]),
    accountId: parsed.data[1],
    config: parsed.data[2] ?? {},
  };
}

export function resolveAdapterDisconnectRpcArgs(
  args: AdapterDisconnectRpcArgs,
): ResolvedAdapterDisconnectRpcArgs {
  if (z.string().safeParse(args[0]).success) {
    const parsed = standaloneDisconnectRpcSchema.safeParse(args);
    if (!parsed.success) throw invalidRpcArguments("disconnect");
    return {
      installation: STANDALONE_INSTALLATION,
      accountId: parsed.data[0],
    };
  }

  requireInstallation(args[0]);
  const parsed = managedDisconnectRpcSchema.safeParse(args);
  if (!parsed.success) throw invalidRpcArguments("disconnect");
  return {
    installation: Object.freeze(parsed.data[0]),
    accountId: parsed.data[1],
  };
}

export function resolveAdapterStatusRpcArgs(
  args: AdapterStatusRpcArgs,
): ResolvedAdapterStatusRpcArgs {
  if (args.length === 0 || z.string().safeParse(args[0]).success || args[0] === undefined) {
    const parsed = standaloneStatusRpcSchema.safeParse(args);
    if (!parsed.success) throw invalidRpcArguments("status");
    const resolved: ResolvedAdapterStatusRpcArgs = {
      installation: STANDALONE_INSTALLATION,
    };
    if (parsed.data[0] !== undefined) resolved.accountId = parsed.data[0];
    return resolved;
  }

  requireInstallation(args[0]);
  const parsed = managedStatusRpcSchema.safeParse(args);
  if (!parsed.success) throw invalidRpcArguments("status");
  const resolved: ResolvedAdapterStatusRpcArgs = {
    installation: Object.freeze(parsed.data[0]),
  };
  if (parsed.data[1] !== undefined) resolved.accountId = parsed.data[1];
  return resolved;
}

export async function resolveAdapterSendRpcArgs(
  args: AdapterSendRpcArgs,
): Promise<ResolvedAdapterSendRpcArgs> {
  const candidateBodies = binaryBodyCandidates(args[2], args[3]);
  try {
    if (z.string().safeParse(args[0]).success) {
      const parsed = standaloneSendRpcSchema.safeParse(args);
      if (!parsed.success) throw invalidRpcArguments("send");
      const resolved: ResolvedAdapterSendRpcArgs = {
        installation: STANDALONE_INSTALLATION,
        accountId: parsed.data[0],
        message: parsed.data[1],
      };
      if (parsed.data[2] !== undefined) resolved.body = parsed.data[2];
      return resolved;
    }

    requireInstallation(args[0]);
    const parsed = managedSendRpcSchema.safeParse(args);
    if (!parsed.success) throw invalidRpcArguments("send");
    const resolved: ResolvedAdapterSendRpcArgs = {
      installation: Object.freeze(parsed.data[0]),
      accountId: parsed.data[1],
      message: parsed.data[2],
    };
    if (parsed.data[3] !== undefined) resolved.body = parsed.data[3];
    return resolved;
  } catch (error) {
    await Promise.all(candidateBodies.map((body) => cancelBinaryBody(body, error)));
    throw error;
  }
}

export function resolveAdapterActivityRpcArgs(
  args: AdapterActivityRpcArgs,
): ResolvedAdapterActivityRpcArgs {
  if (z.string().safeParse(args[0]).success) {
    const parsed = standaloneActivityRpcSchema.safeParse(args);
    if (!parsed.success) throw invalidRpcArguments("set activity");
    return {
      installation: STANDALONE_INSTALLATION,
      accountId: parsed.data[0],
      surface: parsed.data[1],
      activity: parsed.data[2],
    };
  }

  requireInstallation(args[0]);
  const parsed = managedActivityRpcSchema.safeParse(args);
  if (!parsed.success) throw invalidRpcArguments("set activity");
  return {
    installation: Object.freeze(parsed.data[0]),
    accountId: parsed.data[1],
    surface: parsed.data[2],
    activity: parsed.data[3],
  };
}

type AdapterRpcArgument =
  | AdapterActivity
  | AdapterConnectConfig
  | AdapterInstallationContext
  | AdapterOutboundMessage
  | AdapterSurface
  | BinaryBody
  | string
  | undefined;

function binaryBodyCandidates(...values: AdapterRpcArgument[]): BinaryBody[] {
  const bodies = new Set<BinaryBody>();
  for (const value of values) {
    const parsed = binaryBodySchema.safeParse(value);
    if (parsed.success) bodies.add(parsed.data);
  }
  return [...bodies];
}

function requireInstallation(value: AdapterRpcArgument): AdapterInstallationContext {
  const parsed = adapterInstallationContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter installation context is invalid");
  }
  return parsed.data;
}

function invalidRpcArguments(method: string): Error {
  return new Error(`Adapter ${method} RPC arguments are invalid`);
}
