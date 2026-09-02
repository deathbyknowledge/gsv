import type { AdapterSurface } from "../adapters";

/**
 * The capability environment selected for one interaction. Selection supplies
 * model context only; target visibility and syscall authorization remain
 * independently enforced by the Kernel.
 */
export type CapabilityEnvironmentSelection = {
  target: string;
  cwd?: string;
};

export type ClientInteractionOrigin = {
  kind: "client";
  connectionId: string;
  clientId?: string;
  platform?: string;
  environment?: CapabilityEnvironmentSelection;
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

/**
 * A durable, authorized adapter destination. Unlike an interaction origin this
 * intentionally omits display labels and the triggering message id: it is the
 * minimum stable address needed to deliver a later message after rechecking
 * the linked actor's authority.
 */
export type AdapterMessageDestination = {
  kind: "adapter";
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  actorId: string;
};

export type EventReplyTarget = AdapterMessageDestination;

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
  replyTo?: EventReplyTarget;
};

export type InteractionOrigin =
  | ClientInteractionOrigin
  | AdapterInteractionOrigin
  | DeviceInteractionOrigin
  | ProcessInteractionOrigin
  | SchedulerInteractionOrigin;
