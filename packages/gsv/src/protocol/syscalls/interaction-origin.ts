import type { AdapterSurface } from "../adapters";

export type ClientInteractionOrigin = {
  kind: "client";
  connectionId: string;
  clientId?: string;
  platform?: string;
};

export type AppInteractionOrigin = {
  kind: "app";
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
};

export type AdapterInteractionOrigin = {
  kind: "adapter";
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  actorId: string;
  actorLabel?: string;
  messageId?: string;
};

export type DeviceInteractionOrigin = {
  kind: "device";
  deviceId: string;
  cwd?: string;
};

export type ProcessInteractionOrigin = {
  kind: "process";
  sourcePid: string;
  uid?: number;
};

export type SchedulerInteractionOrigin = {
  kind: "scheduler";
  scheduleId: string;
};

export type InteractionOrigin =
  | ClientInteractionOrigin
  | AppInteractionOrigin
  | AdapterInteractionOrigin
  | DeviceInteractionOrigin
  | ProcessInteractionOrigin
  | SchedulerInteractionOrigin;
