import { z } from "zod";
import type { TypedRequest, TypedResponse } from "../protocol/frame";
import type { BinaryBody } from "../protocol/body";
import type { SyscallDomains, SyscallName } from "../protocol/syscalls/map";
import type {
  SysInstanceCatalogResult, SysInstanceStartArgs, SysInstanceStartResult,
  SysInstanceListArgs, SysInstanceListResult, InstanceSelector, SysInstanceGetResult, SysInstanceStopArgs,
  SysBrowserProfileCreateArgs, SysBrowserProfileCreateResult,
  SysBrowserProfileListArgs, SysBrowserProfileListResult, SysBrowserProfileGetResult,
  SysBrowserHandoffRequestArgs, SysBrowserHandoffRequestResult,
  SysBrowserHandoffGetArgs, SysBrowserHandoffGetResult,
  SysBrowserInputArgs, BrowserHumanInput,
  SysBrowserWatchArgs, SysBrowserWatchResult,
} from "../protocol/syscalls/instance";

const id = z.string().trim().min(1).max(160);
export const instanceChangeSchema = z.strictObject({
  installationId: id,
  ownerUid: z.number().int().nonnegative(),
});

/** Deployment-authorized notifications contain identity only, never browser or login state. */
export interface InstancesGatewayService {
  instancesChanged(change: z.infer<typeof instanceChangeSchema>): Promise<void>;
}

export const instanceActorSchema = z.strictObject({
  ownerUid: z.number().int().nonnegative(),
  human: z.boolean(),
  processId: id.optional(),
});
export type InstanceActor = z.infer<typeof instanceActorSchema>;
export const instanceStartSchema = z.strictObject({
  requestId: id,
  templateId: id,
  label: z.string().trim().min(1).max(100).optional(),
  lifetimeSeconds: z.number().int().positive().optional(),
  profileId: id.optional(),
  fresh: z.boolean().optional(),
}) satisfies z.ZodType<SysInstanceStartArgs>;
export const instanceSelectorSchema = z.union([
  z.strictObject({ instanceId: id }),
  z.strictObject({ startRequestId: id }),
]) satisfies z.ZodType<InstanceSelector>;
export const instanceListSchema = z.strictObject({ includeTerminal: z.boolean().optional() });
export const instanceStopSchema = z.union([
  z.strictObject({ instanceId: id, force: z.boolean().optional() }),
  z.strictObject({ startRequestId: id, force: z.boolean().optional() }),
]) satisfies z.ZodType<SysInstanceStopArgs>;
export const browserProfileCreateSchema = z.strictObject({ requestId: id, label: z.string().trim().min(1).max(100) });
export const browserProfileSelectorSchema = z.strictObject({ profileId: id });
export const browserProfileListSchema = z.strictObject({ offset: z.number().int().nonnegative().optional() }) satisfies z.ZodType<SysBrowserProfileListArgs>;
export const browserHandoffRequestSchema = z.strictObject({
  requestId: id, instanceId: id, tabId: z.number().int().positive(),
  purpose: z.string().trim().min(1).max(500), responsibilityId: id.optional(),
}) satisfies z.ZodType<SysBrowserHandoffRequestArgs>;
export const browserHandoffSelectorSchema = z.strictObject({ instanceId: id, requestId: id });
export const browserWatchSchema = z.strictObject({ instanceId: id, tabId: z.number().int().positive().optional() });
export const browserInputSchema = z.strictObject({ instanceId: id, tabId: z.number().int().positive(), documentId: id, handoffRequestId: id.optional() });
export type InstanceTargetRequest = TypedRequest<SyscallDomains, SyscallName, BinaryBody>;
export type InstanceTargetResponse = TypedResponse<SyscallDomains, SyscallName, BinaryBody>;

/** Identity is supplied by Kernel, never copied from public syscall arguments. */
export interface InstallationInstances {
  catalog(actor: InstanceActor): Promise<SysInstanceCatalogResult>;
  start(actor: InstanceActor, args: SysInstanceStartArgs): Promise<SysInstanceStartResult>;
  list(actor: InstanceActor, args: SysInstanceListArgs): Promise<SysInstanceListResult>;
  get(actor: InstanceActor, selector: InstanceSelector): Promise<SysInstanceGetResult>;
  stop(actor: InstanceActor, selector: SysInstanceStopArgs): Promise<SysInstanceGetResult>;
  createProfile(actor: InstanceActor, args: SysBrowserProfileCreateArgs): Promise<SysBrowserProfileCreateResult>;
  listProfiles(actor: InstanceActor, args: SysBrowserProfileListArgs): Promise<SysBrowserProfileListResult>;
  getProfile(actor: InstanceActor, profileId: string): Promise<SysBrowserProfileGetResult>;
  deleteProfile(actor: InstanceActor, profileId: string): Promise<SysBrowserProfileGetResult>;
  saveProfile(actor: InstanceActor, instanceId: string): Promise<SysBrowserProfileGetResult>;
  requestHandoff(actor: InstanceActor, args: SysBrowserHandoffRequestArgs): Promise<SysBrowserHandoffRequestResult>;
  getHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  cancelHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  openHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffRequestResult>;
  finishHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  watch(actor: InstanceActor, args: SysBrowserWatchArgs): Promise<{ data: SysBrowserWatchResult; body: BinaryBody }>;
  input(actor: InstanceActor, args: SysBrowserInputArgs, input: BrowserHumanInput): Promise<{ accepted: true }>;
  execute(actor: InstanceActor, instanceId: string, frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse>;
  cancel(actor: InstanceActor, instanceId: string, requestId: string): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** Optional service capability acquired only from a trusted Gateway binding. */
export interface InstancesService {
  getInstallation(installationId: string): Promise<InstallationInstances>;
}
