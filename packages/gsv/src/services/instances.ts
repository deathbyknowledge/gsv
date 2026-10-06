import { z } from "zod";
import type { TypedRequest, TypedResponse } from "../protocol/frame";
import type { BinaryBody } from "../protocol/body";
import type { SyscallDomains, SyscallName } from "../protocol/syscalls/map";
import type {
  SysInstanceCatalogResult, SysInstanceStartArgs, SysInstanceStartResult,
  SysInstanceListArgs, SysInstanceListResult, InstanceSelector, SysInstanceGetResult,
  SysBrowserProfileCreateArgs, SysBrowserProfileCreateResult,
  SysBrowserProfileListResult, SysBrowserProfileGetResult,
  SysBrowserHandoffRequestArgs, SysBrowserHandoffRequestResult,
  SysBrowserHandoffGetArgs, SysBrowserHandoffGetResult,
  SysBrowserFrameArgs, SysBrowserFrameResult, SysBrowserInputArgs, BrowserHumanInput,
} from "../protocol/syscalls/instance";

const id = z.string().trim().min(1).max(160);
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
export const browserProfileCreateSchema = z.strictObject({ requestId: id, label: z.string().trim().min(1).max(100) });
export const browserProfileSelectorSchema = z.strictObject({ profileId: id });
export const browserHandoffRequestSchema = z.strictObject({
  requestId: id, instanceId: id, tabId: z.number().int().positive(),
  purpose: z.string().trim().min(1).max(500), responsibilityId: id.optional(),
}) satisfies z.ZodType<SysBrowserHandoffRequestArgs>;
export const browserHandoffSelectorSchema = z.strictObject({ instanceId: id, requestId: id });
export const browserFrameSchema = z.strictObject({ instanceId: id, tabId: z.number().int().positive().optional() });
export const browserInputSchema = z.strictObject({ instanceId: id, tabId: z.number().int().positive(), documentId: id, handoffRequestId: id.optional() });
export type InstanceTargetRequest = TypedRequest<SyscallDomains, SyscallName, BinaryBody>;
export type InstanceTargetResponse = TypedResponse<SyscallDomains, SyscallName, BinaryBody>;

/** Identity is supplied by Kernel, never copied from public syscall arguments. */
export interface InstallationInstances {
  catalog(actor: InstanceActor): Promise<SysInstanceCatalogResult>;
  start(actor: InstanceActor, args: SysInstanceStartArgs): Promise<SysInstanceStartResult>;
  list(actor: InstanceActor, args: SysInstanceListArgs): Promise<SysInstanceListResult>;
  get(actor: InstanceActor, selector: InstanceSelector): Promise<SysInstanceGetResult>;
  stop(actor: InstanceActor, selector: InstanceSelector): Promise<SysInstanceGetResult>;
  createProfile(actor: InstanceActor, args: SysBrowserProfileCreateArgs): Promise<SysBrowserProfileCreateResult>;
  listProfiles(actor: InstanceActor): Promise<SysBrowserProfileListResult>;
  getProfile(actor: InstanceActor, profileId: string): Promise<SysBrowserProfileGetResult>;
  deleteProfile(actor: InstanceActor, profileId: string): Promise<SysBrowserProfileGetResult>;
  requestHandoff(actor: InstanceActor, args: SysBrowserHandoffRequestArgs): Promise<SysBrowserHandoffRequestResult>;
  getHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  cancelHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  openHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffRequestResult>;
  finishHandoff(actor: InstanceActor, args: SysBrowserHandoffGetArgs): Promise<SysBrowserHandoffGetResult>;
  frame(actor: InstanceActor, args: SysBrowserFrameArgs): Promise<{ data: SysBrowserFrameResult; body: BinaryBody }>;
  input(actor: InstanceActor, args: SysBrowserInputArgs, input: BrowserHumanInput): Promise<{ accepted: true }>;
  execute(actor: InstanceActor, instanceId: string, frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse>;
  cancel(actor: InstanceActor, instanceId: string, requestId: string): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** Optional service capability acquired only from a trusted Gateway binding. */
export interface InstancesService {
  getInstallation(installationId: string): Promise<InstallationInstances>;
}
